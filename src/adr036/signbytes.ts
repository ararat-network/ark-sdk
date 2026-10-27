// The ADR-036 sign document: an amino sign document that can never be a valid
// transaction, carrying the data as a sign/MsgSignData message. The bytes are
// what every signer signs and every verifier rebuilds (SIGNUP_PROTOCOL.md §5).

import { toBase64 } from "../codec/bytes.js";
import { marshalGoJsonBytes } from "../codec/json.js";

export const MSG_SIGN_DATA_TYPE = "sign/MsgSignData";

/** The exact sign bytes for data signed by the holder of `signer`. */
export function adr036SignBytes(signer: string, data: Uint8Array): Uint8Array {
  return marshalGoJsonBytes({
    account_number: "0",
    chain_id: "",
    fee: { amount: [], gas: "0" },
    memo: "",
    msgs: [{ type: MSG_SIGN_DATA_TYPE, value: { data: toBase64(data), signer } }],
    sequence: "0",
  });
}
