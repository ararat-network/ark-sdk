import assert from "node:assert/strict";
import { test } from "node:test";

import { fromBinary } from "@bufbuild/protobuf";
import { timestampFromDate } from "@bufbuild/protobuf/wkt";

import { timestampToAmino } from "../codec/wkt.js";
import { TxBodySchema, TxRawSchema } from "../gen/cosmos/tx/v1beta1/tx_pb.js";
import { MemorySigner } from "../keys/memory_signer.js";
import { makeFee } from "./body.js";
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
