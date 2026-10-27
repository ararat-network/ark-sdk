// What a transaction result means. Code zero is success. The SDK's own
// errors carry codespace "sdk" and a registered code: the ante's refusals,
// among them. A handler error with no registered code is code 1 in
// codespace "undefined" with the refusal in the log. A module's registered
// error carries the module's codespace. The log is never summarised away.

/** The Cosmos SDK's registered errors, codespace "sdk". */
export const sdkErrors: Readonly<Record<number, string>> = {
  2: "tx parse error",
  3: "invalid sequence",
  4: "unauthorized",
  5: "insufficient funds",
  6: "unknown request",
  7: "invalid address",
  8: "invalid pubkey",
  9: "unknown address",
  10: "invalid coins",
  11: "out of gas",
  12: "memo too large",
  13: "insufficient fee",
  14: "maximum number of signatures exceeded",
  15: "no signatures supplied",
  16: "failed to marshal JSON bytes",
  17: "failed to unmarshal JSON bytes",
  18: "invalid request",
  19: "tx already in mempool",
  20: "mempool is full",
  21: "tx too large",
  22: "key not found",
  23: "invalid account password",
  24: "tx intended signer does not match the given signer",
  25: "invalid gas adjustment",
  26: "invalid height",
  27: "invalid version",
  28: "invalid chain-id",
  29: "invalid type",
  30: "tx timeout height",
  31: "unknown extension options",
  32: "incorrect account sequence",
  33: "failed packing protobuf message to Any",
  34: "failed unpacking protobuf message from Any",
  35: "internal logic error",
  36: "conflict",
  37: "feature not supported",
  38: "not found",
  39: "internal IO error",
  40: "error in app.toml",
  41: "invalid gas limit",
  42: "tx timeout",
};

export const SDK_CODESPACE = "sdk";
export const UNDEFINED_CODESPACE = "undefined";
export const PANIC_CODE = 111222;

export interface TxResultLike {
  code: number;
  codespace: string;
  /** `log` in a fixture or block result, `raw_log` in a gateway response. */
  log?: string;
  rawLog?: string;
}

export type Outcome =
  | { kind: "ok" }
  /** The SDK refused it, before or during execution: an ante check such as the fee, the sequence, or gas. */
  | { kind: "refused"; code: number; codespace: typeof SDK_CODESPACE; reason: string; log: string; messageIndex: number | undefined }
  /** A handler refused with no registered code; the reason is only in the log. */
  | { kind: "failed"; code: 1; codespace: typeof UNDEFINED_CODESPACE; log: string; messageIndex: number | undefined }
  /** Execution panicked, out of gas aside. */
  | { kind: "panic"; code: typeof PANIC_CODE; codespace: typeof UNDEFINED_CODESPACE; log: string }
  /** A module's registered error: its codespace names the module. */
  | { kind: "module_error"; code: number; codespace: string; module: string; log: string; messageIndex: number | undefined };

const MESSAGE_INDEX = /message index: (\d+)/;

/** Classifies a result; the log is kept on every refusal. */
export function classifyResult(r: TxResultLike): Outcome {
  if (r.code === 0) return { kind: "ok" };
  const log = r.log ?? r.rawLog ?? "";
  const match = MESSAGE_INDEX.exec(log);
  const messageIndex = match ? Number(match[1]) : undefined;
  if (r.codespace === SDK_CODESPACE) {
    return { kind: "refused", code: r.code, codespace: SDK_CODESPACE, reason: sdkErrors[r.code] ?? `sdk error ${r.code}`, log, messageIndex };
  }
  if (r.codespace === UNDEFINED_CODESPACE || r.codespace === "") {
    if (r.code === PANIC_CODE) return { kind: "panic", code: PANIC_CODE, codespace: UNDEFINED_CODESPACE, log };
    if (r.code === 1) return { kind: "failed", code: 1, codespace: UNDEFINED_CODESPACE, log, messageIndex };
  }
  return { kind: "module_error", code: r.code, codespace: r.codespace, module: r.codespace, log, messageIndex };
}

/** One line a reader can show, never hiding the log. */
export function describeOutcome(o: Outcome): string {
  switch (o.kind) {
    case "ok":
      return "ok";
    case "refused":
      return `refused by the chain: ${o.reason} (sdk ${o.code}): ${o.log}`;
    case "failed":
      return `execution failed${o.messageIndex === undefined ? "" : ` in message ${o.messageIndex}`}: ${o.log}`;
    case "panic":
      return `execution panicked: ${o.log}`;
    case "module_error":
      return `${o.module} error ${o.code}${o.messageIndex === undefined ? "" : ` in message ${o.messageIndex}`}: ${o.log}`;
  }
}
