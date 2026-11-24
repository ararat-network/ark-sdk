// Broadcast and confirmation, kept apart: sync broadcast returns the mempool's
// CheckTx verdict, which is not inclusion; inclusion is a committed block the
// node can return the transaction from, found by polling. Neither step hides
// a code, a codespace, or a log, and neither reports an outcome it does not
// know: a broadcast whose answer never arrived may have reached the mempool,
// and says so with the hash to poll.

import { txHash } from "../codec/hash.js";
import type { TxResponse } from "../gen/cosmos/base/abci/v1beta1/abci_pb.js";
import type { QueryClient } from "../query/client.js";
import { EndpointsExhausted, isEndpointFault, QueryError, TransportError } from "../query/gateway.js";

/** The SDK's code for a transaction the mempool already holds: the first broadcast reached it. */
const TX_IN_MEMPOOL_CACHE = 19;

/**
 * Statuses a proxy in front of the node answers with when the node's own
 * answer did not come back: the node may have taken the transaction first. A
 * 429 is not among them, since a rate limiter answers before forwarding.
 */
const ANSWER_LOST_STATUSES: ReadonlySet<number> = new Set([502, 503, 504]);

export interface BroadcastResult {
  /** SHA-256 of the bytes that were sent, computed here. */
  hash: string;
  /** CheckTx's code: zero means the mempool accepted the transaction, nothing more. */
  code: number;
  codespace: string;
  rawLog: string;
  accepted: boolean;
  /** The mempool already held the transaction, so an earlier broadcast reached it; accepted. */
  alreadyInMempool: boolean;
}

export class BroadcastRefused extends Error {
  override readonly name: string = "BroadcastRefused";
  constructor(readonly result: BroadcastResult) {
    super(`transaction ${result.hash} refused by CheckTx: code ${result.code} (${result.codespace}): ${result.rawLog}`);
  }
}

/**
 * The broadcast's answer never arrived, came from a gateway that lost the
 * node's, or carried no verdict: the transaction may be in the mempool; poll
 * the hash.
 */
export class BroadcastUnknown extends Error {
  override readonly name: string = "BroadcastUnknown";
  constructor(
    readonly hash: string,
    override readonly cause: unknown,
  ) {
    super(`transaction ${hash} may have reached the mempool, the broadcast's outcome is unknown: ${cause instanceof Error ? cause.message : String(cause)}`);
  }
}

/** The chain is past the transaction's timeout height and no block carried it: it can no longer be included. */
export class TransactionExpired extends Error {
  override readonly name: string = "TransactionExpired";
  constructor(
    readonly hash: string,
    readonly timeoutHeight: bigint,
    readonly height: bigint,
  ) {
    super(`transaction ${hash} was not included by its timeout height ${timeoutHeight}; the chain is at ${height}`);
  }
}

export class InclusionTimeout extends Error {
  override readonly name: string = "InclusionTimeout";
  constructor(
    readonly hash: string,
    readonly waitedMs: number,
    /** The last error polling met, when the wait ended on one. */
    override readonly cause?: unknown,
  ) {
    super(`transaction ${hash} not found in a block after ${waitedMs} ms; it may still be included`);
  }
}

/**
 * Hands the transaction to the node's mempool, once, and returns its CheckTx
 * verdict. The broadcast is never re-sent to another endpoint: the first may
 * have taken it, so a lost answer is an unknown outcome, not a refusal,
 * whether the connection failed or a gateway answered 502, 503, or 504 in the
 * node's place. A node that already holds the transaction reports a cache
 * hit, which is an acceptance.
 */
export async function broadcastSync(client: QueryClient, txBytes: Uint8Array): Promise<BroadcastResult> {
  const hash = txHash(txBytes);
  let r: Awaited<ReturnType<QueryClient["tx"]["broadcast"]>>["txResponse"];
  try {
    r = (await client.tx.broadcast(txBytes)).txResponse;
  } catch (err) {
    if (err instanceof TransportError) throw new BroadcastUnknown(hash, err);
    if (err instanceof QueryError && ANSWER_LOST_STATUSES.has(err.httpStatus)) throw new BroadcastUnknown(hash, err);
    throw err;
  }
  if (!r) throw new BroadcastUnknown(hash, new Error("the node answered without a verdict"));
  const alreadyInMempool = r.code === TX_IN_MEMPOOL_CACHE && r.codespace === "sdk";
  // The hash is the bytes' own, never the one the node echoes: it is what is
  // polled next, and an answer for another transaction must not redirect that.
  return {
    hash,
    code: r.code,
    codespace: r.codespace,
    rawLog: r.rawLog,
    accepted: r.code === 0 || alreadyInMempool,
    alreadyInMempool,
  };
}

export interface InclusionOptions {
  /** How long to poll before giving up; the transaction may still be included after. */
  timeoutMs?: number;
  /**
   * The body's timeout height, when it has one: past it the transaction is dead, and the wait says so instead of
   * running to the deadline. Zero is the body's own value for no timeout and is read as none.
   */
  timeoutHeight?: bigint;
  pollMs?: number;
  signal?: AbortSignal;
  /** Injectable for tests. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  now?: () => number;
}

const abortReason = (signal: AbortSignal): Error => (signal.reason instanceof Error ? signal.reason : new Error("aborted"));

const defaultSleep = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortReason(signal));
      return;
    }
    const onAbort = () => {
      clearTimeout(t);
      reject(abortReason(signal as AbortSignal));
    };
    const t = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });

/** Whether polling should go on past this error: the endpoint was at fault, not the hash. */
function transient(err: unknown): boolean {
  return err instanceof EndpointsExhausted || isEndpointFault(err);
}

/** The node answered a lookup with a different transaction than the one asked for. */
export class WrongTransaction extends Error {
  override readonly name: string = "WrongTransaction";
  constructor(
    readonly hash: string,
    readonly answered: string,
  ) {
    super(`the node answered for transaction ${answered}, not ${hash}`);
  }
}

/** The committed transaction, or undefined while the node has none under the hash; an answer for another hash is refused. */
async function lookUp(client: QueryClient, hash: string): Promise<TxResponse | undefined> {
  try {
    const found = (await client.tx.getTx(hash)).txResponse;
    if (found && found.txhash !== "" && found.txhash.toUpperCase() !== hash.toUpperCase()) throw new WrongTransaction(hash, found.txhash);
    return found;
  } catch (err) {
    if (err instanceof QueryError && err.isNotFound) return undefined;
    throw err;
  }
}

async function latestHeight(client: QueryClient): Promise<bigint> {
  const latest = await client.node.latestBlock();
  const height = latest.sdkBlock?.header?.height ?? latest.block?.header?.height;
  if (height === undefined) throw new Error("the node reported no latest block");
  return height;
}

/**
 * Polls the node until the transaction is in a committed block and returns
 * its result, whatever its code. NotFound means not yet; an endpoint fault is
 * ridden out until the deadline, which then names it; any other error is the
 * caller's and is thrown at once. Given the body's timeout height, the wait
 * ends once the chain is past it, after one last look, since a block at the
 * height may have carried the transaction between the poll and the read.
 */
export async function waitForInclusion(client: QueryClient, hash: string, options: InclusionOptions = {}): Promise<TxResponse> {
  const timeoutMs = options.timeoutMs ?? 60_000;
  const pollMs = options.pollMs ?? 1_000;
  const sleep = options.sleep ?? defaultSleep;
  const now = options.now ?? Date.now;
  // A body with no timeout carries height zero, which every chain height is
  // past: it must not read as an expiry.
  const timeoutHeight = options.timeoutHeight !== undefined && options.timeoutHeight > 0n ? options.timeoutHeight : undefined;
  const start = now();
  let lastError: unknown;
  for (;;) {
    try {
      const found = await lookUp(client, hash);
      if (found) return found;
      lastError = undefined;
      if (timeoutHeight !== undefined) {
        const height = await latestHeight(client);
        if (height > timeoutHeight) {
          const last = await lookUp(client, hash);
          if (last) return last;
          throw new TransactionExpired(hash, timeoutHeight, height);
        }
      }
    } catch (err) {
      if (err instanceof TransactionExpired) throw err;
      if (transient(err)) lastError = err;
      else throw err;
    }
    const waited = now() - start;
    if (waited >= timeoutMs) throw new InclusionTimeout(hash, waited, lastError);
    await sleep(Math.min(pollMs, timeoutMs - waited), options.signal);
  }
}

export interface Confirmed {
  broadcast: BroadcastResult;
  /** The result in the block: code zero is success, anything else a failure with its log. */
  response: TxResponse;
}

/** Broadcasts, fails on a CheckTx refusal, and waits for the block. */
export async function broadcastAndConfirm(client: QueryClient, txBytes: Uint8Array, options: InclusionOptions = {}): Promise<Confirmed> {
  const broadcast = await broadcastSync(client, txBytes);
  if (!broadcast.accepted) throw new BroadcastRefused(broadcast);
  const response = await waitForInclusion(client, broadcast.hash, options);
  return { broadcast, response };
}
