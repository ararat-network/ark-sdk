// Queries over the node's gRPC gateway, the REST surface every node serves.
// A route is never written by hand: each method's google.api.http option is in
// the generated descriptor, so one caller serves every service. Responses are
// the gateway's gogoproto JSON, read by the codec's dialect reader, and every
// result carries the block height the node answered at.
import { getOption, hasOption, type DescMethod, type MessageInitShape, type MessageShape } from "@bufbuild/protobuf";
import { create } from "@bufbuild/protobuf";
import type { GenService, GenServiceMethods } from "@bufbuild/protobuf/codegenv2";

import type { JsonObject, JsonValue } from "../codec/json.js";
import { fromProtoJson, toProtoJson } from "../codec/protojson.js";
import { http } from "../gen/google/api/annotations_pb.js";

/** gRPC status codes the gateway reports in its error body. */
export enum GrpcCode {
  OK = 0,
  Cancelled = 1,
  Unknown = 2,
  InvalidArgument = 3,
  DeadlineExceeded = 4,
  NotFound = 5,
  AlreadyExists = 6,
  PermissionDenied = 7,
  ResourceExhausted = 8,
  FailedPrecondition = 9,
  Aborted = 10,
  OutOfRange = 11,
  Unimplemented = 12,
  Internal = 13,
  Unavailable = 14,
  DataLoss = 15,
  Unauthenticated = 16,
}

export class QueryError extends Error {
  override readonly name: string = "QueryError";
  constructor(
    readonly grpcCode: number,
    message: string,
    readonly httpStatus: number,
    readonly url: string,
    readonly details: readonly JsonValue[] = [],
  ) {
    super(message);
  }

  get isNotFound(): boolean {
    return this.grpcCode === GrpcCode.NotFound;
  }
}

/** The node could not be reached or did not answer HTTP. */
export class TransportError extends Error {
  override readonly name: string = "TransportError";
  constructor(
    readonly url: string,
    override readonly cause: unknown,
  ) {
    super(`${url}: ${cause instanceof Error ? cause.message : String(cause)}`);
  }
}

export interface GatewayOptions {
  fetch?: typeof fetch;
  /** Headers sent with every request, for a node behind authentication. */
  headers?: Record<string, string>;
}

export interface CallOptions {
  /** Query committed state at this height instead of the latest. */
  height?: bigint;
  signal?: AbortSignal;
}

export interface GatewayResult<T> {
  value: T;
  /** The block height the node answered at, from its response header; undefined when it sent none. */
  height: bigint | undefined;
}

type MethodNames<S extends GenService<GenServiceMethods>> = keyof S["method"] & string;
type InputOf<S extends GenService<GenServiceMethods>, M extends MethodNames<S>> = S["method"][M]["input"];
type OutputOf<S extends GenService<GenServiceMethods>, M extends MethodNames<S>> = S["method"][M]["output"];

export interface Route {
  verb: "GET" | "POST" | "PUT" | "DELETE" | "PATCH";
  path: string;
  body: JsonValue | undefined;
}

export class GatewayClient {
  readonly baseUrl: string;
  readonly #fetch: typeof fetch;
  readonly #headers: Record<string, string>;

  constructor(baseUrl: string, options: GatewayOptions = {}) {
    this.baseUrl = baseUrl.replace(/\/+$/, "");
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#headers = { ...options.headers };
  }

  /** Calls one unary method of a generated service. */
  async call<S extends GenService<GenServiceMethods>, M extends MethodNames<S>>(
    service: S,
    method: M,
    request: MessageInitShape<InputOf<S, M>> = {} as MessageInitShape<InputOf<S, M>>,
    options: CallOptions = {},
  ): Promise<GatewayResult<MessageShape<OutputOf<S, M>>>> {
    const desc = service.method[method] as DescMethod;
    const input = desc.input as InputOf<S, M>;
    const message = create(input, request);
    const route = routeFor(desc, toProtoJson(input, message) as JsonObject);
    const url = this.baseUrl + route.path;
    const headers: Record<string, string> = { accept: "application/json", ...this.#headers };
    if (options.height !== undefined) headers["x-cosmos-block-height"] = options.height.toString();
    const init: RequestInit = { method: route.verb, headers };
    if (route.body !== undefined) {
      headers["content-type"] = "application/json";
      init.body = JSON.stringify(route.body);
    }
    if (options.signal) init.signal = options.signal;

    let response: Response;
    try {
      response = await this.#fetch(url, init);
    } catch (err) {
      throw new TransportError(url, err);
    }
    const text = await response.text();
    let json: JsonValue;
    try {
      json = JSON.parse(text) as JsonValue;
    } catch {
      if (!response.ok) throw new QueryError(GrpcCode.Unknown, text || response.statusText, response.status, url);
      throw new TransportError(url, new Error(`not JSON: ${text.slice(0, 200)}`));
    }
    if (!response.ok) throw gatewayError(json, response.status, url);
    const heightHeader = response.headers.get("grpc-metadata-x-cosmos-block-height");
    const height = heightHeader !== null && /^\d+$/.test(heightHeader) ? BigInt(heightHeader) : undefined;
    return { value: fromProtoJson(desc.output as OutputOf<S, M>, json) as MessageShape<OutputOf<S, M>>, height };
  }
}

function gatewayError(json: JsonValue, status: number, url: string): QueryError {
  if (json !== null && typeof json === "object" && !Array.isArray(json)) {
    const code = typeof json["code"] === "number" ? json["code"] : GrpcCode.Unknown;
    const message = typeof json["message"] === "string" ? json["message"] : typeof json["error"] === "string" ? json["error"] : JSON.stringify(json);
    const details = Array.isArray(json["details"]) ? json["details"] : [];
    return new QueryError(code, message, status, url, details);
  }
  return new QueryError(GrpcCode.Unknown, JSON.stringify(json), status, url);
}

/** The gateway route of a method for one request, from its google.api.http option. */
export function routeFor(method: DescMethod, request: JsonObject): Route {
  if (!hasOption(method, http)) throw new Error(`${method.parent.typeName}.${method.name} has no gateway route`);
  const rule = getOption(method, http);
  const pattern = rule.pattern;
  if (pattern.case === undefined || pattern.case === "custom") throw new Error(`${method.parent.typeName}.${method.name}: unsupported route pattern`);
  const verb = pattern.case.toUpperCase() as Route["verb"];
  const remaining: JsonObject = { ...request };
  const path = pattern.value.replace(/\{([^}=]+)(?:=[^}]*)?\}/g, (_, name: string) => {
    const value = remaining[name];
    delete remaining[name];
    if (value === undefined || value === null) throw new Error(`${method.parent.typeName}.${method.name}: request lacks ${name} for the route`);
    return encodeURIComponent(typeof value === "string" ? value : JSON.stringify(value));
  });
  if (rule.body === "*") return { verb, path, body: remaining };
  if (rule.body !== "") {
    const body = remaining[rule.body];
    delete remaining[rule.body];
    const query = queryString(remaining);
    return { verb, path: path + query, body: body ?? {} };
  }
  return { verb, path: path + queryString(remaining), body: undefined };
}

/** Flattens the request's remaining fields into gateway query parameters, dotted for nested messages, defaults left out. */
function queryString(fields: JsonObject): string {
  const params = new URLSearchParams();
  const add = (prefix: string, value: JsonValue): void => {
    if (value === null || value === "" || value === false || value === 0 || value === "0") return;
    if (Array.isArray(value)) {
      for (const item of value) if (item !== null && typeof item !== "object") params.append(prefix, String(item));
      return;
    }
    if (typeof value === "object") {
      for (const [k, v] of Object.entries(value)) add(`${prefix}.${k}`, v);
      return;
    }
    params.append(prefix, String(value));
  };
  for (const [k, v] of Object.entries(fields)) add(k, v);
  const s = params.toString();
  return s === "" ? "" : "?" + s;
}

