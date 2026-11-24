import assert from "node:assert/strict";
import { test } from "node:test";

import { create, toBinary } from "@bufbuild/protobuf";

import { packAny } from "../codec/any.js";
import { toHex } from "../codec/bytes.js";
import { decodeMsgResponses } from "../defaults.js";
import { ArkSdkError } from "../errors.js";
import { MsgSendResponseSchema } from "../gen/cosmos/bank/v1beta1/tx_pb.js";
import { TxMsgDataSchema } from "../gen/cosmos/base/abci/v1beta1/abci_pb.js";
import { MsgSubmitProposalResponseSchema } from "../gen/cosmos/gov/v1/tx_pb.js";

test("message responses decode from the result's hex data", () => {
  const data = create(TxMsgDataSchema, {
    msgResponses: [
      packAny(MsgSendResponseSchema, create(MsgSendResponseSchema)),
      packAny(MsgSubmitProposalResponseSchema, create(MsgSubmitProposalResponseSchema, { proposalId: 7n })),
    ],
  });
  const hex = toHex(toBinary(TxMsgDataSchema, data)).toUpperCase();
  const responses = decodeMsgResponses(hex);
  assert.deepEqual(
    responses.map((r) => r.typeUrl),
    ["/cosmos.bank.v1beta1.MsgSendResponse", "/cosmos.gov.v1.MsgSubmitProposalResponse"],
  );
  assert.equal((responses[1]!.message as unknown as { proposalId: bigint }).proposalId, 7n);
  assert.deepEqual(responses[1]?.json, { "@type": "/cosmos.gov.v1.MsgSubmitProposalResponse", proposal_id: "7" });
  // The length, not the list: a decoded response carries its schema, which prints as over a million lines, and a failed assert.deepEqual diffs both sides.
  assert.equal(decodeMsgResponses("").length, 0);
  assert.equal(decodeMsgResponses(new Uint8Array()).length, 0);
});

test("result data that is not hex is refused by an SDK error, not the hex library's", () => {
  assert.throws(
    () => decodeMsgResponses("zz"),
    (err: unknown) => err instanceof ArkSdkError && /not hex/.test(err.message),
  );
});
