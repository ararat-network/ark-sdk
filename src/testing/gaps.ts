// Fields the chain's Go types carry that the generated schema lacks, because
// ark's proto/buf.lock pins a cosmos-sdk registry commit older than the
// v0.54.4 module the chain is built from. The bytes still round-trip as
// unknown fields; only the JSON view cannot name them. Each entry removes the
// member from a fixture's expected JSON and fails once the schema gains it, so
// a pin bump retires the gap.
import assert from "node:assert/strict";

import type { JsonObject } from "../codec/json.js";
import { MsgUpdateParamsSchema as ConsensusMsgUpdateParamsSchema } from "../gen/cosmos/consensus/v1/tx_pb.js";
import type { FixtureTx } from "./fixtures.js";

const knownJsonGaps: Record<string, (tx: FixtureTx) => void> = {
  gov_proposal_cosmos: (tx) => {
    assert.ok(
      !ConsensusMsgUpdateParamsSchema.fields.some((f) => f.name === "auth"),
      "cosmos.consensus.v1.MsgUpdateParams.auth is in the schema now; retire this gap",
    );
    const messages = tx.body.messages[0]!.messages as JsonObject[];
    const consensus = messages.find((m) => m["@type"] === "/cosmos.consensus.v1.MsgUpdateParams")!;
    assert.ok("auth" in consensus, "the fixture no longer carries auth; the gap has nothing to remove");
    delete consensus.auth;
  },
};

/** The fixture's `tx` with the known gaps applied, for comparison with the SDK's view. */
export function expectedTxJson(name: string, tx: FixtureTx): FixtureTx {
  const expected = structuredClone(tx);
  knownJsonGaps[name]?.(expected);
  return expected;
}
