// Fields the chain's Go types carry that the generated schema lacks, because
// ark's proto/buf.lock pins a cosmos-sdk registry commit older than the
// v0.54.4 module the chain is built from. The bytes still round-trip as
// unknown fields; only the JSON view cannot name them. Each entry removes the
// member from a fixture's expected JSON and fails once the schema gains it, so
// a pin bump retires the gap.
import assert from "node:assert/strict";

import type { JsonObject } from "../codec/json.js";

export const knownJsonGaps: Record<string, (tx: JsonObject) => void> = {
  gov_proposal_cosmos: (tx) => {
    const messages = ((tx.body as JsonObject).messages as JsonObject[])[0]!.messages as JsonObject[];
    const consensus = messages.find((m) => m["@type"] === "/cosmos.consensus.v1.MsgUpdateParams")!;
    assert.ok("auth" in consensus, "cosmos.consensus.v1.MsgUpdateParams.auth is in the schema now; retire this gap");
    delete consensus.auth;
  },
};

/** The fixture's `tx` with the known gaps applied, for comparison with the SDK's view. */
export function expectedTxJson(name: string, tx: unknown): JsonObject {
  const expected = structuredClone(tx) as JsonObject;
  knownJsonGaps[name]?.(expected);
  return expected;
}
