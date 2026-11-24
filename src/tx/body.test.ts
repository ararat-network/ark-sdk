import assert from "node:assert/strict";
import { test } from "node:test";

import { create, fromBinary } from "@bufbuild/protobuf";
import { AnySchema, timestampFromDate } from "@bufbuild/protobuf/wkt";

import { packAny, UnknownTypeError } from "../codec/any.js";
import { fromHex } from "../codec/bytes.js";
import { CoinError } from "../codec/coins.js";
import { DecError, LegacyDec } from "../codec/dec.js";
import { timestampToAmino } from "../codec/wkt.js";
import { fromProtoJson, signTx } from "../defaults.js";
import { MsgExecSchema } from "../gen/cosmos/authz/v1beta1/tx_pb.js";
import { MsgSendSchema } from "../gen/cosmos/bank/v1beta1/tx_pb.js";
import { MsgSubmitProposalSchema } from "../gen/cosmos/gov/v1/tx_pb.js";
import { MsgEditValidatorSchema } from "../gen/cosmos/staking/v1beta1/tx_pb.js";
import { TxBodySchema, TxRawSchema } from "../gen/cosmos/tx/v1beta1/tx_pb.js";
import { MemorySigner } from "../keys/memory_signer.js";
import { makeFee, makeTxBody, packMessages, typed } from "./body.js";
import { simulationTxBytes } from "./builder.js";

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

test("a message that holds one read without its type cannot be put in a transaction either", async () => {
  const future = { "@type": "/ark.future.v1.MsgNew", sender: "ark1x", amount: "5" };
  const held = fromProtoJson(AnySchema, future, { unknownAny: "keep" });
  const refused = (err: unknown) => err instanceof UnknownTypeError && err.typeUrl === "/ark.future.v1.MsgNew" && /holds no bytes/.test(err.message);

  // Built around it by hand: packed as it is, the exec would carry the inner type URL and nothing else.
  const exec = typed(MsgExecSchema, create(MsgExecSchema, { grantee: "ark1g", msgs: [held] }));
  assert.throws(() => packMessages([exec]), refused);
  assert.throws(() => makeTxBody({ messages: [exec] }), refused);
  // Two levels down, through a list of a list.
  const proposal = typed(
    MsgSubmitProposalSchema,
    create(MsgSubmitProposalSchema, { proposer: "ark1p", messages: [packAny(MsgSendSchema, create(MsgSendSchema)), held] }),
  );
  assert.throws(() => packMessages([proposal]), refused);

  // Read from a node around it: the exec is itself kept as JSON, so it is refused as any message read without its type is.
  const read = fromProtoJson(AnySchema, { "@type": "/cosmos.authz.v1beta1.MsgExec", grantee: "ark1g", msgs: [future] }, { unknownAny: "keep" });
  assert.throws(() => packMessages([read]), /read without its type and holds no bytes/);
  const signer = MemorySigner.random();
  const [account] = await signer.accounts();
  assert.throws(() => simulationTxBytes({ messages: [read], publicKey: account!.publicKey, sequence: 0n }), UnknownTypeError);
  await assert.rejects(
    signTx({
      signer,
      address: signer.address,
      chainId: "localark",
      accountNumber: 1n,
      sequence: 0n,
      messages: [read],
      fee: makeFee({ amount: [], gasLimit: 1n }),
    }),
    UnknownTypeError,
  );

  // An exec around messages that carry their bytes packs as before.
  const send = packAny(MsgSendSchema, create(MsgSendSchema, { fromAddress: "ark1a", toAddress: "ark1b" }));
  const [packed] = packMessages([typed(MsgExecSchema, create(MsgExecSchema, { grantee: "ark1g", msgs: [send] }))]);
  assert.deepEqual(fromBinary(MsgExecSchema, packed!.value).msgs[0]?.value, send.value);
});

test("a message whose amount text the chain would read as another number cannot be packed", () => {
  // Built without coin(): "0100" would be signed here as one hundred and executed by the chain as sixty-four.
  const send = (amount: string) =>
    typed(MsgSendSchema, create(MsgSendSchema, { fromAddress: "ark1a", toAddress: "ark1b", amount: [{ denom: "ausd", amount }] }));
  for (const text of ["0100", "010", "0x10", "1_000", "+5", "08", "-0"]) {
    assert.throws(
      () => packMessages([send(text)]),
      (err: unknown) => err instanceof CoinError && /cosmos\.base\.v1beta1\.Coin\.amount/.test(err.message),
      JSON.stringify(text),
    );
  }
  assert.throws(() => makeTxBody({ messages: [send("0100")] }), CoinError);
  assert.equal(fromBinary(MsgSendSchema, packMessages([send("100")])[0]!.value).amount[0]?.amount, "100");

  // A Dec field holds its scaled integer, and the same rule holds for its text.
  const edit = (commissionRate: string) => typed(MsgEditValidatorSchema, create(MsgEditValidatorSchema, { validatorAddress: "arkvaloper1x", commissionRate }));
  assert.throws(() => packMessages([edit("0100000000000000000")]), DecError);
  assert.throws(() => packMessages([edit("0.1")]), DecError, "the decimal's text is not its wire form");
  assert.equal(packMessages([edit(LegacyDec.fromString("0.1").toWire())]).length, 1);

  // Bytes packed elsewhere pass through as they are: what they hold is their maker's.
  const packed = create(AnySchema, {
    typeUrl: "/cosmos.bank.v1beta1.MsgSend",
    value: fromHex("0a0861726b3166726f6d120661726b31746f1a0c0a0461757364120430313030"),
  });
  assert.deepEqual(packMessages([packed]), [packed]);
});
