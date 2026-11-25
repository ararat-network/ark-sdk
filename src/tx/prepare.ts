// The flow for one transaction, as three steps a caller runs in order.
// prepareTx asks the chain what the fee contract needs, in the order it needs
// it: the account, a simulation for gas, the tax on the final messages and the
// gas price sheet, then the quote with the caller's headroom. It signs
// nothing. signTx, in builder.ts, signs what was prepared as it stands, and
// broadcastTx, in broadcast.ts, sends what was signed and waits for its block.
// Between the first two a caller can show the quote, and the fee shown is the
// fee signed. sendTx runs the three in one call. Requests whose answers do
// not depend on each other are asked together. Nothing here chooses a
// headroom, a gas adjustment, or a denomination for the caller; it only runs
// the steps in the right order on the same messages.
import { SDK_CODESPACE, WRONG_SEQUENCE_CODE } from "../decode/result.js";
import { ArkSdkError } from "../errors.js";
import type { Coin } from "../gen/cosmos/base/v1beta1/coin_pb.js";
import { type Signer, type SignerAccount, signerAccountFor } from "../keys/signer.js";
import type { QueryClient } from "../query/client.js";
import { QueryError } from "../query/gateway.js";
import { type FeeInput, packMessages, type TxBodyInput } from "./body.js";
import { BroadcastRefused, type BroadcastResult, broadcastSync, type Confirmed, type InclusionOptions, waitForAccepted } from "./broadcast.js";
import { feeFromQuote, type SignedTx, type SigningMode, signTx, simulationTxBytes, type UnsignedTx } from "./builder.js";
import { adjustGas, type FeeQuote, type FeeQuoteInput, gasPriceFor, quoteFee, requireFeeDenom } from "./fee.js";

export class PrepareError extends ArkSdkError {
  override readonly name: string = "PrepareError";
}

export interface AccountState {
  accountNumber: bigint;
  sequence: bigint;
}

/**
 * The body's members, and what the flow needs to price it: the quote's headroom, tip, and native denomination, and
 * the fee's payer and granter, each as FeeQuoteInput and FeeInput say. An unordered body needs its timeout timestamp.
 */
export interface PrepareTxInput extends TxBodyInput, Pick<FeeQuoteInput, "headroom" | "tip" | "nativeDenom">, Pick<FeeInput, "payer" | "granter"> {
  /** The services the flow reads, a QueryClient or those of its members over one gateway. */
  client: Pick<QueryClient, "gateway" | "auth" | "tx" | "treasury">;
  /** The account that will sign, as its signer reports it: its address, and the public key the simulation is built over. No signer is taken, since nothing is signed. */
  signerAccount: SignerAccount;
  chainId: string;
  /** The denomination that pays the base fee; must be on the sheet. Its leg is encoded first unless `legOrder` says otherwise, which is what makes it the one the ante charges. */
  feeDenom: string;
  /** Multiplier on the simulated gas; ignored when gasLimit is given. */
  gasAdjustment: number;
  /** A gas limit to use instead of simulating. */
  gasLimit?: bigint;
  /** Denominations first among the fee's legs; left out, a stable `feeDenom` goes first so that it pays. See FeeQuoteInput.legOrder. */
  legOrder?: readonly string[];
  mode?: SigningMode;
  /** The account's number and sequence, when already known; queried otherwise. */
  account?: AccountState;
}

/**
 * A transaction priced, with nothing signed, and the chain's figures that priced it. Its sequence and its fee are
 * those of the moment it was prepared, and the quote is the chain's word at the height it names: one left unsigned
 * long enough for either to have moved is prepared again, not signed.
 */
export interface PreparedTx {
  /** What signTx signs: the body with its messages packed, the account with its number and sequence, and the fee the quote declares. */
  tx: UnsignedTx;
  quote: FeeQuote;
  tax: Coin[];
  /** The principal the tax was computed over: what the messages move. */
  taxBase: Coin[];
  simulatedGas: bigint | undefined;
  gasLimit: bigint;
}

/**
 * Runs account, simulation, tax, sheet, and quote on the same messages, and
 * asks for no signature. An unordered transaction needs a timeout timestamp
 * and is simulated, and signed, at sequence zero, as the chain requires.
 */
export async function prepareTx(input: PrepareTxInput): Promise<PreparedTx> {
  // What the flow reads for itself is taken out, and what is left is the body's members, handed on whole: a member
  // the body gains is then carried here with no line to add.
  const { client, signerAccount, chainId, feeDenom: denom, gasAdjustment, gasLimit: givenGasLimit, legOrder, mode, account: givenAccount, ...rest } = input;
  const { headroom, tip, nativeDenom, payer, granter, ...members } = rest;
  const feeDenom = requireFeeDenom(denom);
  const messages = packMessages(members.messages);
  if (members.unordered && !members.timeoutTimestamp) {
    throw new PrepareError("an unordered transaction needs a timeout timestamp: it is what the chain orders and expires it by");
  }
  // The body every step is built over, its messages packed once so the simulation, the tax, and the signature see
  // the same bytes.
  const body: TxBodyInput = { ...members, messages };
  const account = givenAccount ?? (await fetchAccount(client, signerAccount.address));
  // The ante refuses an unordered transaction that carries a sequence: its
  // timeout timestamp stands in for one, so it is simulated and signed at zero.
  const sequence = body.unordered ? 0n : account.sequence;

  let simulatedGas: bigint | undefined;
  let gasLimit = givenGasLimit;
  if (gasLimit === undefined) {
    // Simulated with no fee, whatever the input carried beside the members this flow names: the fee is priced below.
    const simulation = await client.tx.simulate(simulationTxBytes({ ...body, publicKey: signerAccount.publicKey, sequence, fee: undefined }));
    if (!simulation.gasInfo) throw new PrepareError("simulation returned no gas info");
    simulatedGas = simulation.gasInfo.gasUsed;
    gasLimit = adjustGas(simulatedGas, gasAdjustment);
  }

  // Neither answer depends on the other, so the tax and the sheet are asked for together, the tax first.
  const [tax, sheet] = await Promise.all([client.treasury.computeTax(messages), client.treasury.gasPrices()]);
  const quote = quoteFee({ tax: tax.tax, gasPrice: gasPriceFor(sheet, feeDenom), gasLimit, headroom, tip, legOrder, nativeDenom });

  const tx: UnsignedTx = {
    ...body,
    address: signerAccount.address,
    signerAccount,
    chainId,
    accountNumber: account.accountNumber,
    sequence,
    fee: feeFromQuote(quote, { payer, granter }),
    mode,
    // The types the client was given are the ones this flow knows; amino mode encodes the messages through them.
    registry: client.gateway.registry,
  };
  return { tx, quote, tax: tax.tax, taxBase: tax.taxBase, simulatedGas, gasLimit };
}

async function fetchAccount(client: Pick<QueryClient, "auth">, address: string): Promise<AccountState> {
  const { info } = await client.auth.accountInfo(address);
  if (!info) throw new PrepareError(`no account at ${address}; it has never held coins`);
  return { accountNumber: info.accountNumber, sequence: info.sequence };
}

/** What sendTx takes: what prepareTx takes, with the signer and the address it signs for in place of the account. */
export interface SendTxInput extends Omit<PrepareTxInput, "client" | "signerAccount"> {
  /** The services prepareTx reads, and `node` beside them for the wait. */
  client: Pick<QueryClient, "gateway" | "auth" | "tx" | "treasury" | "node">;
  signer: Signer;
  address: string;
}

export interface SendOptions extends InclusionOptions {
  /**
   * On a sequence mismatch, at simulation or at CheckTx, sign once more at the sequence the chain named. Off unless
   * asked for: it is a second signature, which a signer that shows each document to a person asks them for again.
   */
  retryOnSequenceMismatch?: boolean;
}

/** What sendTx returns: the transaction as it was prepared, as it was signed, and as the chain took it. */
export interface Sent extends PreparedTx, Confirmed {
  signed: SignedTx;
}

/**
 * prepareTx, signTx, and the broadcast and the block, in one call, for a
 * caller with nothing to show between the quote and the signature. Asked to,
 * it signs once more at the chain's sequence when another transaction took
 * it. That second signature is made only while the first transaction is
 * known not to be in the mempool: before anything was sent, or when CheckTx
 * refused it. Once a broadcast is accepted, or its outcome is unknown, nothing
 * is signed again whatever the node then answers, since a second transaction
 * would pay twice. Every failure from the broadcast on carries the
 * transaction's hash.
 */
export async function sendTx(input: SendTxInput, options: SendOptions = {}): Promise<Sent> {
  const { signer, address, ...rest } = input;
  // The signer is asked once, whatever follows: a wallet or a device answers for its accounts once per transaction.
  const signerAccount = signerAccountFor(await signer.accounts(), address);
  let attempt: PrepareTxInput = { ...rest, signerAccount };
  let signAgain = (options.retryOnSequenceMismatch ?? false) && !input.account;
  for (;;) {
    const handed = await signAndBroadcast(input.client, attempt, signer, signAgain);
    if (!("expected" in handed)) {
      const inclusion = { ...options, timeoutHeight: options.timeoutHeight ?? handed.signed.timeoutHeight };
      const response = await waitForAccepted(input.client, handed.broadcast, inclusion);
      return { ...handed.prepared, signed: handed.signed, broadcast: handed.broadcast, response };
    }
    // The committed account still shows the old sequence while the earlier transaction is pending, so it is read
    // for its number only, and the sequence is the one the chain named.
    const { accountNumber } = await fetchAccount(input.client, address);
    attempt = { ...attempt, account: { accountNumber, sequence: handed.expected } };
    signAgain = false;
  }
}

/**
 * Prepares, signs, and hands the transaction to the mempool. When another
 * transaction took the sequence and the caller allows signing again, the
 * sequence the chain expects is returned in place of an error, from the two
 * points where the mempool cannot hold this transaction: the flow before the
 * broadcast, and a CheckTx refusal. An error from the broadcast itself is
 * never read for a sequence: its text is the node's, and the node may have
 * the transaction.
 */
async function signAndBroadcast(
  client: Pick<QueryClient, "tx">,
  input: PrepareTxInput,
  signer: Signer,
  signAgain: boolean,
): Promise<{ prepared: PreparedTx; signed: SignedTx; broadcast: BroadcastResult } | { expected: bigint }> {
  let prepared: PreparedTx;
  let signed: SignedTx;
  try {
    prepared = await prepareTx(input);
    signed = await signTx(prepared.tx, signer);
  } catch (err) {
    const expected = signAgain ? expectedSequence(err) : undefined;
    if (expected === undefined) throw err;
    return { expected };
  }
  const broadcast = await broadcastSync(client, signed.txBytes);
  if (broadcast.accepted) return { prepared, signed, broadcast };
  const refused = new BroadcastRefused(broadcast);
  const expected = signAgain ? expectedSequence(refused) : undefined;
  if (expected === undefined) throw refused;
  return { expected };
}

const EXPECTED_SEQUENCE = /account sequence mismatch, expected (\d+), got \d+/;

/**
 * The sequence the chain expects, when an error is a sequence mismatch. It
 * surfaces at simulation, which runs against the mempool's state and so sees
 * a pending transaction, as a query error; or at CheckTx as the SDK's code
 * 32. Either way the log names the expected sequence, which the committed
 * account does not show while the earlier transaction is still pending. This
 * only reads the error: signing again on its answer is safe when the error
 * came before the broadcast or is CheckTx's refusal, and not for an error met
 * after a broadcast was accepted, whose text a faulty node could choose.
 */
export function expectedSequence(err: unknown): bigint | undefined {
  let log: string | undefined;
  if (err instanceof BroadcastRefused && err.result.codespace === SDK_CODESPACE && err.result.code === WRONG_SEQUENCE_CODE) log = err.result.rawLog;
  else if (err instanceof QueryError) log = err.message;
  const m = log === undefined ? null : EXPECTED_SEQUENCE.exec(log);
  return m ? BigInt(m[1] as string) : undefined;
}
