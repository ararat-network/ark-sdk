import { QueryClient } from "../defaults.js";
// A stand-in for a node's gateway in tests: a fetch that records each request
// and answers from the test's own function, and a client over a scripted node.
// Test-only; excluded from the build.

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

/** A node's answer to one request, given its call. */
export type Reply = (call: string) => Response;

/**
 * A client over a scripted node. A request whose call starts with a key of
 * `replies` gets that reply every time; any other takes the next step of
 * `script`, and a request past its end fails.
 */
export function fakeNode(
  script: Reply[] = [],
  replies: Record<string, Reply> = {},
): { client: QueryClient; calls: string[]; requests: SeenRequest[]; script: Reply[]; replies: Record<string, Reply> } {
  const calls: string[] = [];
  const { fetch, seen } = stubFetch(({ call }) => {
    calls.push(call);
    const standing = Object.entries(replies).find(([prefix]) => call.startsWith(prefix));
    const reply = standing ? standing[1] : script.shift();
    if (!reply) throw new Error(`unexpected request ${call}`);
    return reply(call);
  });
  return { client: new QueryClient("http://node", { fetch }), calls, requests: seen, script, replies };
}
