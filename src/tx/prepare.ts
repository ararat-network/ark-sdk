// The whole flow for one transaction, in the order the fee contract needs:
// the account, a simulation for gas, the tax on the final messages, the gas
// price sheet, the quote with the caller's headroom, the signature, and, for
// sendTx, the broadcast and the block. Nothing here chooses a headroom, a gas
// adjustment, or a denomination for the caller; it only runs the steps in the
// right order on the same messages.
import type { Coin } from "../gen/cosmos/base/v1beta1/coin_pb.js";
import type { Signer } from "../keys/signer.js";
import type { QueryClient } from "../query/client.js";
import { packMessages, type TxMessage } from "./body.js";
import { BroadcastRefused, broadcastAndConfirm, type Confirmed, type InclusionOptions } from "./broadcast.js";
import { feeFromQuote, type SignedTx, type SigningMode, signTx, simulationTxBytes } from "./builder.js";
import { adjustGas, FeeError, type FeeQuote, type Headroom, quoteFee } from "./fee.js";

export class PrepareError extends Error {
  override readonly name: string = "PrepareError";
}

export interface AccountState {
  accountNumber: bigint;
  sequence: bigint;
}

export interface PrepareInput {
  client: QueryClient;
  signer: Signer;
  address: string;
  chainId: string;
  messages: readonly TxMessage[];
  memo?: string;
  timeoutHeight?: bigint;
  /** The denomination that pays the base fee; must be on the sheet. */
  feeDenom: string;
  headroom: Headroom;
  /** Multiplier on the simulated gas; ignored when gasLimit is given. */
  gasAdjustment: number;
  /** A gas limit to use instead of simulating. */
  gasLimit?: bigint;
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
  sequence: bigint;
}

/** Runs account, simulation, tax, sheet, quote, and signature on the same messages. */
export async function prepareAndSign(input: PrepareInput): Promise<Prepared> {
  const { client } = input;
  const messages = packMessages(input.messages);
  const account = input.account ?? (await fetchAccount(client, input.address));
  const signerAccount = (await input.signer.accounts()).find((a) => a.address === input.address);
  if (!signerAccount) throw new PrepareError(`signer holds no account ${input.address}`);

  let simulatedGas: bigint | undefined;
  let gasLimit = input.gasLimit;
  if (gasLimit === undefined) {
    const simulation = await client.tx.simulate(
      simulationTxBytes({ messages, memo: input.memo, publicKey: signerAccount.publicKey, sequence: account.sequence }),
    );
    if (!simulation.gasInfo) throw new PrepareError("simulation returned no gas info");
    simulatedGas = simulation.gasInfo.gasUsed;
    gasLimit = adjustGas(simulatedGas, input.gasAdjustment);
  }

  const tax = await client.treasury.computeTax(messages);
  const sheet = await client.treasury.gasPrices();
  const gasPrice =
    sheet.gasPrices.find((p) => p.denom === input.feeDenom) ?? (sheet.referenceGasPrice?.denom === input.feeDenom ? sheet.referenceGasPrice : undefined);
  if (!gasPrice) throw new FeeError(`${input.feeDenom} is not on the gas price sheet; the chain does not accept it for the base fee`);
  const quote = quoteFee({ tax: tax.tax, gasPrice, gasLimit, headroom: input.headroom, legOrder: input.legOrder, nativeDenom: input.nativeDenom });

  const signed = await signTx({
    signer: input.signer,
    address: input.address,
    chainId: input.chainId,
    accountNumber: account.accountNumber,
    sequence: account.sequence,
    messages,
    memo: input.memo,
    timeoutHeight: input.timeoutHeight,
    fee: feeFromQuote(quote, { payer: input.payer, granter: input.granter }),
    mode: input.mode,
  });
  return { signed, quote, tax: tax.tax, taxBase: tax.taxBase, simulatedGas, gasLimit, accountNumber: account.accountNumber, sequence: account.sequence };
}

async function fetchAccount(client: QueryClient, address: string): Promise<AccountState> {
  const { info } = await client.auth.accountInfo(address);
  if (!info) throw new PrepareError(`no account at ${address}; it has never held coins`);
  return { accountNumber: info.accountNumber, sequence: info.sequence };
}

export interface SendOptions extends InclusionOptions {
  /** On a sequence mismatch at CheckTx, refetch the account and prepare once more; on by default. */
  retryOnSequenceMismatch?: boolean;
}

export type Sent = Prepared & Confirmed;

const SEQUENCE_MISMATCH = 32;

/** prepareAndSign, broadcast, and the block, with one retry when another transaction took the sequence. */
export async function sendTx(input: PrepareInput, options: SendOptions = {}): Promise<Sent> {
  const retry = options.retryOnSequenceMismatch ?? true;
  let prepared = await prepareAndSign(input);
  try {
    return { ...prepared, ...(await broadcastAndConfirm(input.client, prepared.signed.txBytes, options)) };
  } catch (err) {
    const mismatch = err instanceof BroadcastRefused && err.result.codespace === "sdk" && err.result.code === SEQUENCE_MISMATCH;
    if (!retry || !mismatch || input.account) throw err;
  }
  prepared = await prepareAndSign(input);
  return { ...prepared, ...(await broadcastAndConfirm(input.client, prepared.signed.txBytes, options)) };
}
