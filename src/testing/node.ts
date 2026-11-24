// A stand-in for a node's gateway in tests: a fetch that records each request
// and answers from the test's own function, the answers a node gives most,
// and a client over a scripted node. Test-only; excluded from the build.
import { QueryClient } from "../defaults.js";

export interface SeenRequest {
  url: string;
  method: string;
  /** The method and the URL without its origin, such as "GET /cosmos/tx/v1beta1/txs/AB". */
  call: string;
  body: string | undefined;
  headers: Record<string, string>;
  signal: AbortSignal | undefined;
}

/** A fetch that records what it was asked and answers with `reply`; a reply that throws is a request that failed. */
export function stubFetch(reply: (request: SeenRequest) => Response | Promise<Response>): { fetch: typeof fetch; seen: SeenRequest[] } {
  const seen: SeenRequest[] = [];
  const fetchStub = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    const request: SeenRequest = {
      url,
      method,
      call: `${method} ${url.replace(/^https?:\/\/[^/]+/, "")}`,
      body: init?.body as string | undefined,
      headers: (init?.headers as Record<string, string>) ?? {},
      signal: init?.signal ?? undefined,
    };
    seen.push(request);
    return reply(request);
  }) as typeof fetch;
  return { fetch: fetchStub, seen };
}

/** A JSON response; a number is its status. */
export function json(body: unknown, init: number | ResponseInit = 200): Response {
  return new Response(JSON.stringify(body), typeof init === "number" ? { status: init } : init);
}

/** A TxResponse as the gateway renders one: code zero at height zero unless overridden. */
export function txResponse(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { txhash: "", code: 0, codespace: "", raw_log: "", height: "0", gas_wanted: "0", gas_used: "0", events: [], logs: [], ...overrides };
}

/** A node's answer to one request. */
export type Reply = (request: SeenRequest) => Response | Promise<Response>;

/** An error as the gateway renders one: the gRPC code and its message, under an HTTP status. */
export function gatewayError(code: number, message: string, status: number): Response {
  return json({ code, message, details: [] }, status);
}

/** NotFound for a transaction the node does not hold: pending, or unknown to it. */
export const notFound = (): Response => gatewayError(5, "tx not found", 404);

/** The endpoint's own fault: a gateway that cannot reach its node. */
export const unavailable = (): Response => gatewayError(14, "unavailable", 503);

/** A request that reached no node: the failure a runtime's fetch throws. */
export const unreachable = (): never => {
  throw new TypeError("fetch failed");
};

/** CheckTx's acceptance of a broadcast, from a node that echoes the transaction's hash. */
export const accepted =
  (hash: string): Reply =>
  () =>
    json({ tx_response: txResponse({ txhash: hash }) });

/** The block's result under the hash the lookup asked for, in uppercase as a node reports one. */
export const included: Reply = ({ call }) =>
  json({ tx_response: txResponse({ txhash: call.split("/").pop()?.toUpperCase(), height: "7", gas_wanted: "250000", gas_used: "98227" }) });

/**
 * A client over a scripted node. A request whose call starts with a key of
 * `replies` gets that reply every time; any other takes the next step of
 * `script`, and a request past its end fails. A script that is one reply
 * answers every request with it. `answer` is the node's own answer to a
 * request, for a test that puts a fetch of its own in front of it.
 */
export function fakeNode(
  script: Reply[] | Reply = [],
  replies: Record<string, Reply> = {},
): { client: QueryClient; calls: string[]; requests: SeenRequest[]; script: Reply[]; replies: Record<string, Reply>; answer: Reply } {
  const calls: string[] = [];
  const steps = typeof script === "function" ? [] : script;
  const answer: Reply = (request) => {
    calls.push(request.call);
    const standing = Object.entries(replies).find(([prefix]) => request.call.startsWith(prefix));
    const reply = standing ? standing[1] : typeof script === "function" ? script : steps.shift();
    if (!reply) throw new Error(`unexpected request ${request.call}`);
    return reply(request);
  };
  const { fetch, seen } = stubFetch(answer);
  return { client: new QueryClient("http://node", { fetch }), calls, requests: seen, script: steps, replies, answer };
}
