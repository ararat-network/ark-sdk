import assert from "node:assert/strict";
import { test } from "node:test";

import { create, toBinary } from "@bufbuild/protobuf";

import { packAny } from "../codec/any.js";
import { toHex } from "../codec/bytes.js";
import { TxMsgDataSchema } from "../gen/cosmos/base/abci/v1beta1/abci_pb.js";
import { MsgSendResponseSchema } from "../gen/cosmos/bank/v1beta1/tx_pb.js";
import { MsgSubmitProposalResponseSchema } from "../gen/cosmos/gov/v1/tx_pb.js";
import { decodeMsgResponses } from "./responses.js";

test("message responses decode from the result's hex data", () => {
  const data = create(TxMsgDataSchema, {
    msgResponses: [packAny(MsgSendResponseSchema, create(MsgSendResponseSchema)), packAny(MsgSubmitProposalResponseSchema, create(MsgSubmitProposalResponseSchema, { proposalId: 7n }))],
  });
  const hex = toHex(toBinary(TxMsgDataSchema, data)).toUpperCase();
  const responses = decodeMsgResponses(hex);
  assert.deepEqual(
    responses.map((r) => r.typeUrl),
    ["/cosmos.bank.v1beta1.MsgSendResponse", "/cosmos.gov.v1.MsgSubmitProposalResponse"],
  );
  assert.equal((responses[1]?.message as unknown as { proposalId: bigint }).proposalId, 7n);
  assert.deepEqual(responses[1]?.json, { "@type": "/cosmos.gov.v1.MsgSubmitProposalResponse", proposal_id: "7" });
  assert.deepEqual(decodeMsgResponses(""), []);
  assert.deepEqual(decodeMsgResponses(new Uint8Array()), []);
});
