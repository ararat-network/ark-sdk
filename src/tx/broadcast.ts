// Broadcast and confirmation, kept apart: sync broadcast returns the mempool's
// CheckTx verdict, which is not inclusion; inclusion is a committed block the
// node can return the transaction from, found by polling. Neither step hides
// a code, a codespace, or a log, and neither reports an outcome it does not
// know: a broadcast whose answer never arrived may have reached the mempool,
// and says so with the hash to poll.
import type { TxResponse } from "../gen/cosmos/base/abci/v1beta1/abci_pb.js";
import type { QueryClient } from "../query/client.js";
import { EndpointsExhausted, isEndpointFault, QueryError, TransportError } from "../query/gateway.js";
import { txHash } from "./signdoc.js";

/** The SDK's code for a transaction the mempool already holds: the first broadcast reached it. */
const TX_IN_MEMPOOL_CACHE = 19;

export interface BroadcastResult {
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

/** The broadcast's answer never arrived or carried no verdict: the transaction may be in the mempool; poll the hash. */
export class BroadcastUnknown extends Error {
  override readonly name: string = "BroadcastUnknown";
  constructor(
    readonly hash: string,
    override readonly cause: unknown,
  ) {
    super(`transaction ${hash} may have reached the mempool, the broadcast's outcome is unknown: ${cause instanceof Error ? cause.message : String(cause)}`);
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
 * have taken it, so a lost answer is an unknown outcome, not a refusal. A
 * node that already holds the transaction reports a cache hit, which is an
 * acceptance.
 */
export async function broadcastSync(client: QueryClient, txBytes: Uint8Array): Promise<BroadcastResult> {
  const hash = txHash(txBytes);
  let r: Awaited<ReturnType<QueryClient["tx"]["broadcast"]>>["txResponse"];
  try {
    r = (await client.tx.broadcast(txBytes)).txResponse;
  } catch (err) {
    if (err instanceof TransportError) throw new BroadcastUnknown(hash, err);
    throw err;
  }
  if (!r) throw new BroadcastUnknown(hash, new Error("the node answered without a verdict"));
  const alreadyInMempool = r.code === TX_IN_MEMPOOL_CACHE && r.codespace === "sdk";
  return {
    hash: r.txhash !== "" ? r.txhash : hash,
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

/**
 * Polls the node until the transaction is in a committed block and returns
 * its result, whatever its code. NotFound means not yet; an endpoint fault is
 * ridden out until the deadline, which then names it; any other error is the
 * caller's and is thrown at once.
 */
export async function waitForInclusion(client: QueryClient, hash: string, options: InclusionOptions = {}): Promise<TxResponse> {
  const timeoutMs = options.timeoutMs ?? 60_000;
  const pollMs = options.pollMs ?? 1_000;
  const sleep = options.sleep ?? defaultSleep;
  const now = options.now ?? Date.now;
  const start = now();
  let lastError: unknown;
  for (;;) {
    try {
      const found = await client.tx.getTx(hash);
      if (found.txResponse) return found.txResponse;
      lastError = undefined;
    } catch (err) {
      if (err instanceof QueryError && err.isNotFound) lastError = undefined;
      else if (transient(err)) lastError = err;
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
