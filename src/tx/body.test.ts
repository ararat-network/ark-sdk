import assert from "node:assert/strict";
import { test } from "node:test";

import { fromBinary } from "@bufbuild/protobuf";
import { AnySchema, timestampFromDate } from "@bufbuild/protobuf/wkt";

import { fromProtoJson } from "../codec/protojson.js";
import { timestampToAmino } from "../codec/wkt.js";
import { TxBodySchema, TxRawSchema } from "../gen/cosmos/tx/v1beta1/tx_pb.js";
import { MemorySigner } from "../keys/memory_signer.js";
import { makeFee, packMessages } from "./body.js";
import { signTx, simulationTxBytes } from "./builder.js";

test("an unordered transaction and its timeout timestamp reach the body, the simulation, and the amino document", async () => {
  const signer = MemorySigner.random();
  const [account] = await signer.accounts();
  const until = timestampFromDate(new Date("2030-01-01T00:00:00Z"));
  const fee = makeFee({ amount: [], gasLimit: 1n });
  const signed = await signTx({
    signer,
    address: signer.address,
    chainId: "localark",
    accountNumber: 1n,
    sequence: 0n,
    messages: [],
    fee,
    unordered: true,
    timeoutTimestamp: until,
    mode: "amino",
  });
  const body = fromBinary(TxBodySchema, signed.bodyBytes);
  assert.equal(body.unordered, true);
  assert.equal(body.timeoutTimestamp?.seconds, until.seconds);
  assert.equal(signed.aminoSignDoc?.unordered, true);
  assert.equal(signed.aminoSignDoc?.timeout_timestamp, timestampToAmino(until));

  const simulated = fromBinary(
    TxRawSchema,
    simulationTxBytes({ messages: [], publicKey: account!.publicKey, sequence: 0n, unordered: true, timeoutTimestamp: until, timeoutHeight: 9n }),
  );
  const simulatedBody = fromBinary(TxBodySchema, simulated.bodyBytes);
  assert.equal(simulatedBody.unordered, true);
  assert.equal(simulatedBody.timeoutHeight, 9n);
  assert.equal(simulatedBody.timeoutTimestamp?.seconds, until.seconds);

  const ordered = await signTx({ signer, address: signer.address, chainId: "localark", accountNumber: 1n, sequence: 0n, messages: [], fee, mode: "amino" });
  assert.equal(fromBinary(TxBodySchema, ordered.bodyBytes).unordered, false);
  assert.equal(ordered.aminoSignDoc?.unordered, undefined, "omitted when false, as the chain's document omits it");
});

test("a message read from a node without its type cannot be put in a transaction", () => {
  // It holds no bytes: packed as it is, the signature would cover an empty message under that type.
  const held = fromProtoJson(AnySchema, { "@type": "/ark.future.v1.MsgNew", amount: "5" }, { unknownAny: "keep" });
  assert.throws(() => packMessages([held]), /read without its type and holds no bytes/);
  const read = fromProtoJson(AnySchema, { "@type": "/cosmos.bank.v1beta1.MsgSend", from_address: "ark1a", to_address: "ark1b", amount: [] });
  assert.deepEqual(packMessages([read]), [read], "one read with its type passes through");
});
