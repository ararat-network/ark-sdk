// Broadcast and confirmation, kept apart: sync broadcast returns the mempool's
// CheckTx verdict, which is not inclusion; inclusion is a committed block the
// node can return the transaction from, found by polling. Neither step hides
// a code, a codespace, or a log.
import type { TxResponse } from "../gen/cosmos/base/abci/v1beta1/abci_pb.js";
import { QueryError } from "../query/gateway.js";
import type { QueryClient } from "../query/client.js";
import { txHash } from "./signdoc.js";

export interface BroadcastResult {
  hash: string;
  /** CheckTx's code: zero means the mempool accepted the transaction, nothing more. */
  code: number;
  codespace: string;
  rawLog: string;
  accepted: boolean;
}

export class BroadcastRefused extends Error {
  override readonly name: string = "BroadcastRefused";
  constructor(readonly result: BroadcastResult) {
    super(`transaction ${result.hash} refused by CheckTx: code ${result.code} (${result.codespace}): ${result.rawLog}`);
  }
}

export class InclusionTimeout extends Error {
  override readonly name: string = "InclusionTimeout";
  constructor(
    readonly hash: string,
    readonly waitedMs: number,
  ) {
    super(`transaction ${hash} not found in a block after ${waitedMs} ms; it may still be included`);
  }
}

/** Hands the transaction to the node's mempool and returns its CheckTx verdict. */
export async function broadcastSync(client: QueryClient, txBytes: Uint8Array): Promise<BroadcastResult> {
  const response = await client.tx.broadcast(txBytes);
  const r = response.txResponse;
  const hash = r?.txhash && r.txhash !== "" ? r.txhash : txHash(txBytes);
  return { hash, code: r?.code ?? 0, codespace: r?.codespace ?? "", rawLog: r?.rawLog ?? "", accepted: (r?.code ?? 0) === 0 };
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

const defaultSleep = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(t);
        reject(signal.reason instanceof Error ? signal.reason : new Error("aborted"));
      },
      { once: true },
    );
  });

/** Polls the node until the transaction is in a committed block and returns its result, whatever its code. */
export async function waitForInclusion(client: QueryClient, hash: string, options: InclusionOptions = {}): Promise<TxResponse> {
  const timeoutMs = options.timeoutMs ?? 60_000;
  const pollMs = options.pollMs ?? 1_000;
  const sleep = options.sleep ?? defaultSleep;
  const now = options.now ?? Date.now;
  const start = now();
  for (;;) {
    try {
      const found = await client.tx.getTx(hash);
      if (found.txResponse) return found.txResponse;
    } catch (err) {
      if (!(err instanceof QueryError && err.isNotFound)) throw err;
    }
    const waited = now() - start;
    if (waited >= timeoutMs) throw new InclusionTimeout(hash, waited);
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
