// Broadcast and confirmation, kept apart: sync broadcast returns the mempool's
// CheckTx verdict, which is not inclusion; inclusion is a committed block the
// node can return the transaction from, found by polling. Neither step hides
// a code, a codespace, or a log, and neither reports an outcome it does not
// know: a broadcast whose answer never arrived may have reached the mempool,
// and says so with the hash to poll.

import { txHash } from "../codec/hash.js";
import { SDK_CODESPACE, TX_IN_MEMPOOL_CODE } from "../decode/result.js";
import { ArkSdkError, errorMessage } from "../errors.js";
import type { TxResponse } from "../gen/cosmos/base/abci/v1beta1/abci_pb.js";
import type { QueryClient } from "../query/client.js";
import { EndpointsExhausted, isEndpointFault, QueryError } from "../query/gateway.js";
import { lookUpTx, WrongTransaction } from "../query/search.js";

/**
 * Whether a status is one a proxy in front of the node answers with when the
 * node's own answer did not come back: the node may have taken the
 * transaction first. 502, 503, and 504 are a gateway's, and the statuses
 * above them are what a CDN answers with for an origin that timed out. A 500
 * and a 501 are the node's own, given before it takes a transaction, and a
 * 429 is a rate limiter's, which answers before forwarding.
 */
function answerLost(status: number): boolean {
  return status >= 502 && status <= 599;
}

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

export class BroadcastRefused extends ArkSdkError {
  override readonly name: string = "BroadcastRefused";
  constructor(readonly result: BroadcastResult) {
    super(`transaction ${result.hash} refused by CheckTx: code ${result.code} (${result.codespace}): ${result.rawLog}`);
  }
}

/**
 * The broadcast's answer never arrived, came from a gateway that lost the
 * node's, could not be read, or carried no verdict: the transaction may be in
 * the mempool; poll the hash.
 */
export class BroadcastUnknown extends ArkSdkError {
  override readonly name: string = "BroadcastUnknown";
  constructor(
    readonly hash: string,
    override readonly cause: unknown,
  ) {
    super(`transaction ${hash} may have reached the mempool, the broadcast's outcome is unknown: ${errorMessage(cause)}`);
  }
}

/**
 * The chain is past the transaction's timeout height and the node has no
 * block that carried it: it can no longer be included. The node's word is
 * taken only after the transaction stayed unfound for the grace period, on a
 * node that says it is not catching up; a node whose index is further behind
 * than that can still be wrong, so look the hash up elsewhere before paying again.
 */
export class TransactionExpired extends ArkSdkError {
  override readonly name: string = "TransactionExpired";
  constructor(
    readonly hash: string,
    readonly timeoutHeight: bigint,
    readonly height: bigint,
  ) {
    super(`transaction ${hash} was not included by its timeout height ${timeoutHeight}; the chain is at ${height}`);
  }
}

/**
 * The mempool accepted the transaction, and the wait for its block then ended
 * on an error that says nothing of the transaction: a node's answer to a
 * lookup, or the caller's abort, kept as the cause. The transaction may still
 * be included, and the hash is what finds it. sendTx and broadcastAndConfirm
 * throw this so that no failure after an acceptance leaves a caller without
 * the hash; the wait's own verdicts, which carry it, are thrown as they are.
 */
export class InclusionUnknown extends ArkSdkError {
  override readonly name: string = "InclusionUnknown";
  readonly hash: string;
  constructor(
    /** The mempool's verdict the transaction was accepted with. */
    readonly broadcast: BroadcastResult,
    override readonly cause: unknown,
  ) {
    super(`transaction ${broadcast.hash} was accepted by the mempool, and the wait for its block failed: ${errorMessage(cause)}; it may still be included`);
    this.hash = broadcast.hash;
  }
}

export class InclusionTimeout extends ArkSdkError {
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
 * whether the connection failed, a gateway answered in the node's place, or
 * the node's answer arrived and could not be read. Only an answer that blames
 * the request is the request's error. A node that already holds the
 * transaction reports a cache hit, which is an acceptance.
 */
export async function broadcastSync(client: Pick<QueryClient, "tx">, txBytes: Uint8Array): Promise<BroadcastResult> {
  const hash = txHash(txBytes);
  let r: TxResponse | undefined;
  try {
    r = (await client.tx.broadcast(txBytes)).txResponse;
  } catch (err) {
    // The node's own verdict on the request, given before it takes a transaction.
    if (err instanceof QueryError && !answerLost(err.httpStatus)) throw err;
    // Anything else leaves the outcome unknown, and the hash is what the caller needs: the request was sent, and
    // no answer that settles it came back.
    throw new BroadcastUnknown(hash, err);
  }
  if (!r) throw new BroadcastUnknown(hash, new Error("the node answered without a verdict"));
  // The mempool already holds the transaction: the first broadcast reached it.
  const alreadyInMempool = r.code === TX_IN_MEMPOOL_CODE && r.codespace === SDK_CODESPACE;
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
  /**
   * How long the transaction must stay unfound, once the chain is seen past its timeout height, before the wait
   * says it expired; 10 seconds by default. The height is read from the node's blocks and the transaction from its
   * index, which is written later and apart, so one look past the height does not settle it.
   */
  expiryGraceMs?: number;
  pollMs?: number;
  signal?: AbortSignal;
  /** Injectable for tests. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  now?: () => number;
}

/** How long a transaction must stay unfound past its timeout height before it is called expired: two of Ark's block intervals. */
export const DEFAULT_EXPIRY_GRACE_MS = 10_000;

/** Sleeps, or ends at once with the signal's reason as the caller gave it when the signal aborts, as fetch does. */
const defaultSleep = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason);
      return;
    }
    const onAbort = () => {
      clearTimeout(t);
      reject(signal?.reason);
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

/**
 * The node's latest height, and whether it says it is still catching up with the chain: its newest blocks are then
 * ahead of its transaction index. Both come in the node's answer on its sync state, a few dozen bytes; the latest
 * block, which carries its transactions and its commit twice over, is read only for a node whose answer has no
 * height, one built on an SDK from before the answer carried it.
 */
async function chainTip(client: Pick<QueryClient, "node">): Promise<{ height: bigint; catchingUp: boolean }> {
  const state = await client.node.syncing();
  if (state.latestBlockHeight > 0n) return { height: state.latestBlockHeight, catchingUp: state.syncing };
  const latest = await client.node.latestBlock();
  const height = latest.sdkBlock?.header?.height ?? latest.block?.header?.height;
  if (height === undefined) throw new ArkSdkError("the node reported no latest block");
  return { height, catchingUp: state.syncing };
}

/**
 * Polls the node until the transaction is in a committed block and returns
 * its result, whatever its code. NotFound means not yet; an endpoint fault is
 * ridden out until the deadline, which then names it; any other error is the
 * caller's and is thrown at once. Given the body's timeout height, the wait
 * ends as expired once the chain is past it and the transaction has stayed
 * unfound for the grace period after, on a node that is not catching up, and
 * after one last look: the node indexes a block's transactions after it
 * reports the block, so the first look past the height can miss one the
 * block carried.
 */
export async function waitForInclusion(client: Pick<QueryClient, "tx" | "node">, hash: string, options: InclusionOptions = {}): Promise<TxResponse> {
  const timeoutMs = options.timeoutMs ?? 60_000;
  const pollMs = options.pollMs ?? 1_000;
  const sleep = options.sleep ?? defaultSleep;
  const now = options.now ?? Date.now;
  // A body with no timeout carries height zero, which every chain height is
  // past: it must not read as an expiry.
  const timeoutHeight = options.timeoutHeight !== undefined && options.timeoutHeight > 0n ? options.timeoutHeight : undefined;
  const expiryGraceMs = options.expiryGraceMs ?? DEFAULT_EXPIRY_GRACE_MS;
  const start = now();
  /** When the chain was first seen past the timeout height. */
  let pastSince: number | undefined;
  let lastError: unknown;
  for (;;) {
    try {
      const found = await lookUpTx(client, hash);
      if (found) return found.response;
      lastError = undefined;
      if (timeoutHeight !== undefined) {
        const { height, catchingUp } = await chainTip(client);
        if (height > timeoutHeight) {
          pastSince ??= now();
          if (now() - pastSince >= expiryGraceMs && !catchingUp) {
            const last = await lookUpTx(client, hash);
            if (last) return last.response;
            throw new TransactionExpired(hash, timeoutHeight, height);
          }
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

/**
 * Waits for the block of a transaction the mempool accepted. Every failure
 * from here carries the hash: the wait's verdicts on the transaction as they
 * are, and anything else as InclusionUnknown. Shared with sendTx; not
 * exported from the core entry.
 */
export async function waitForAccepted(
  client: Pick<QueryClient, "tx" | "node">,
  broadcast: BroadcastResult,
  options: InclusionOptions = {},
): Promise<TxResponse> {
  try {
    return await waitForInclusion(client, broadcast.hash, options);
  } catch (err) {
    if (err instanceof InclusionTimeout || err instanceof TransactionExpired || err instanceof WrongTransaction) throw err;
    throw new InclusionUnknown(broadcast, err);
  }
}

/** Broadcasts, fails on a CheckTx refusal, and waits for the block; a failure after the acceptance carries the hash. */
export async function broadcastAndConfirm(client: Pick<QueryClient, "tx" | "node">, txBytes: Uint8Array, options: InclusionOptions = {}): Promise<Confirmed> {
  const broadcast = await broadcastSync(client, txBytes);
  if (!broadcast.accepted) throw new BroadcastRefused(broadcast);
  const response = await waitForAccepted(client, broadcast, options);
  return { broadcast, response };
}
