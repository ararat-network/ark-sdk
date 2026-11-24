// The whole flow for one transaction, in the order the fee contract needs:
// the account, a simulation for gas, the tax on the final messages and the
// gas price sheet, the quote with the caller's headroom, the signature, and,
// for sendTx, the broadcast and the block. Requests whose answers do not
// depend on each other are asked together. Nothing here chooses a headroom, a
// gas adjustment, or a denomination for the caller; it only runs the steps in
// the right order on the same messages.
import { SDK_CODESPACE, WRONG_SEQUENCE_CODE } from "../decode/result.js";
import { ArkSdkError } from "../errors.js";
import type { Coin } from "../gen/cosmos/base/v1beta1/coin_pb.js";
import { type Signer, SignerError } from "../keys/signer.js";
import type { QueryClient } from "../query/client.js";
import { QueryError } from "../query/gateway.js";
import { packMessages, type TxBodyInput } from "./body.js";
import { BroadcastRefused, type BroadcastResult, broadcastSync, type Confirmed, type InclusionOptions, waitForAccepted } from "./broadcast.js";
import { feeFromQuote, type SignedTx, type SigningMode, signTx, simulationTxBytes } from "./builder.js";
import { adjustGas, FeeError, type FeeQuote, type Headroom, quoteFee } from "./fee.js";

export class PrepareError extends ArkSdkError {
  override readonly name: string = "PrepareError";
}

export interface AccountState {
  accountNumber: bigint;
  sequence: bigint;
}

/** The body's members, and what the flow needs to price and sign it. An unordered body needs its timeout timestamp. */
export interface PrepareInput extends TxBodyInput {
  client: QueryClient;
  signer: Signer;
  address: string;
  chainId: string;
  /** The denomination that pays the base fee; must be on the sheet. Its leg is encoded first unless `legOrder` says otherwise, which is what makes it the one the ante charges. */
  feeDenom: string;
  headroom: Headroom;
  /** Multiplier on the simulated gas; ignored when gasLimit is given. */
  gasAdjustment: number;
  /** A gas limit to use instead of simulating. */
  gasLimit?: bigint;
  /** A tip in NOAH base units: its own leg beside a stable gas leg, part of the NOAH leg when NOAH carries the gas. */
  tip?: bigint;
  /** Denominations first among the fee's legs; left out, a stable `feeDenom` goes first so that it pays. See FeeQuoteInput.legOrder. */
  legOrder?: readonly string[];
  nativeDenom?: string;
  payer?: string;
  granter?: string;
  mode?: SigningMode;
  /** The account's number and sequence, when already known; queried otherwise. */
  account?: AccountState;
}

export interface Prepared {
  signed: SignedTx;
  quote: FeeQuote;
  tax: Coin[];
  /** The principal the tax was computed over: what the messages move. */
  taxBase: Coin[];
  simulatedGas: bigint | undefined;
  gasLimit: bigint;
  accountNumber: bigint;
  /** The sequence signed at: the account's, or zero for an unordered transaction. */
  sequence: bigint;
}

/**
 * Runs account, simulation, tax, sheet, quote, and signature on the same
 * messages. An unordered transaction needs a timeout timestamp and is
 * simulated and signed at sequence zero, as the chain requires.
 */
export async function prepareAndSign(input: PrepareInput): Promise<Prepared> {
  const { client } = input;
  if (!input.feeDenom) throw new FeeError("no fee denomination: feeDenom names the one that pays the base fee, and none is chosen for you");
  const messages = packMessages(input.messages);
  if (input.unordered && !input.timeoutTimestamp) {
    throw new PrepareError("an unordered transaction needs a timeout timestamp: it is what the chain orders and expires it by");
  }
  // The body every step is built over, its messages packed once so the simulation, the tax, and the signature see the same bytes.
  const body: TxBodyInput = {
    messages,
    memo: input.memo,
    timeoutHeight: input.timeoutHeight,
    timeoutTimestamp: input.timeoutTimestamp,
    unordered: input.unordered,
  };
  // The chain's account and the signer's are independent, so they are asked for together. The signer is asked
  // inside a promise: one that throws where it should reject would otherwise leave the account request, already
  // sent, with nothing awaiting it.
  const [account, signerAccounts] = await Promise.all([input.account ?? fetchAccount(client, input.address), (async () => input.signer.accounts())()]);
  // The ante refuses an unordered transaction that carries a sequence: its
  // timeout timestamp stands in for one, so it is simulated and signed at zero.
  const sequence = input.unordered ? 0n : account.sequence;
  const signerAccount = signerAccounts.find((a) => a.address === input.address);
  if (!signerAccount) throw new SignerError(`signer holds no account ${input.address}`);

  let simulatedGas: bigint | undefined;
  let gasLimit = input.gasLimit;
  if (gasLimit === undefined) {
    const simulation = await client.tx.simulate(simulationTxBytes({ ...body, publicKey: signerAccount.publicKey, sequence }));
    if (!simulation.gasInfo) throw new PrepareError("simulation returned no gas info");
    simulatedGas = simulation.gasInfo.gasUsed;
    gasLimit = adjustGas(simulatedGas, input.gasAdjustment);
  }

  // Neither answer depends on the other, so the tax and the sheet are asked for together, the tax first.
  const [tax, sheet] = await Promise.all([client.treasury.computeTax(messages), client.treasury.gasPrices()]);
  const gasPrice =
    sheet.gasPrices.find((p) => p.denom === input.feeDenom) ?? (sheet.referenceGasPrice?.denom === input.feeDenom ? sheet.referenceGasPrice : undefined);
  if (!gasPrice) throw new FeeError(`${input.feeDenom} is not on the gas price sheet; the chain does not accept it for the base fee`);
  const quote = quoteFee({
    tax: tax.tax,
    gasPrice,
    gasLimit,
    headroom: input.headroom,
    tip: input.tip,
    legOrder: input.legOrder,
    nativeDenom: input.nativeDenom,
  });

  const signed = await signTx({
    ...body,
    signer: input.signer,
    address: input.address,
    signerAccount,
    chainId: input.chainId,
    accountNumber: account.accountNumber,
    sequence,
    fee: feeFromQuote(quote, { payer: input.payer, granter: input.granter }),
    mode: input.mode,
    // The types the client was given are the ones this flow knows; amino mode encodes the messages through them.
    registry: client.gateway.registry,
  });
  return { signed, quote, tax: tax.tax, taxBase: tax.taxBase, simulatedGas, gasLimit, accountNumber: account.accountNumber, sequence };
}

async function fetchAccount(client: QueryClient, address: string): Promise<AccountState> {
  const { info } = await client.auth.accountInfo(address);
  if (!info) throw new PrepareError(`no account at ${address}; it has never held coins`);
  return { accountNumber: info.accountNumber, sequence: info.sequence };
}

export interface SendOptions extends InclusionOptions {
  /** On a sequence mismatch, at simulation or at CheckTx, sign once more at the sequence the chain named; on by default. */
  retryOnSequenceMismatch?: boolean;
}

export type Sent = Prepared & Confirmed;

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

/**
 * prepareAndSign, broadcast, and the block, signing once more at the chain's
 * sequence when another transaction took it. The second signature is made
 * only while the first transaction is known not to be in the mempool: before
 * anything was sent, or when CheckTx refused it. Once a broadcast is accepted,
 * or its outcome is unknown, nothing is signed again whatever the node then
 * answers, since a second transaction would pay twice. Every failure from the
 * broadcast on carries the transaction's hash.
 */
export async function sendTx(input: PrepareInput, options: SendOptions = {}): Promise<Sent> {
  let attempt = input;
  let signAgain = (options.retryOnSequenceMismatch ?? true) && !input.account;
  for (;;) {
    const handed = await signAndBroadcast(attempt, signAgain);
    if (!("expected" in handed)) {
      const inclusion = { ...options, timeoutHeight: options.timeoutHeight ?? input.timeoutHeight };
      const response = await waitForAccepted(input.client, handed.broadcast, inclusion);
      return { ...handed.prepared, broadcast: handed.broadcast, response };
    }
    // The committed account still shows the old sequence while the earlier transaction is pending, so it is read
    // for its number only, and the sequence is the one the chain named.
    const { accountNumber } = await fetchAccount(input.client, input.address);
    attempt = { ...input, account: { accountNumber, sequence: handed.expected } };
    signAgain = false;
  }
}

/**
 * Signs and hands the transaction to the mempool. When another transaction
 * took the sequence and the caller allows signing again, the sequence the
 * chain expects is returned in place of an error, from the two points where
 * the mempool cannot hold this transaction: the flow before the broadcast,
 * and a CheckTx refusal. An error from the broadcast itself is never read for
 * a sequence: its text is the node's, and the node may have the transaction.
 */
async function signAndBroadcast(input: PrepareInput, signAgain: boolean): Promise<{ prepared: Prepared; broadcast: BroadcastResult } | { expected: bigint }> {
  let prepared: Prepared;
  try {
    prepared = await prepareAndSign(input);
  } catch (err) {
    const expected = signAgain ? expectedSequence(err) : undefined;
    if (expected === undefined) throw err;
    return { expected };
  }
  const broadcast = await broadcastSync(input.client, prepared.signed.txBytes);
  if (broadcast.accepted) return { prepared, broadcast };
  const refused = new BroadcastRefused(broadcast);
  const expected = signAgain ? expectedSequence(refused) : undefined;
  if (expected === undefined) throw refused;
  return { expected };
}
