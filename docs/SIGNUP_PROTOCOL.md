# Ark member signup protocol

For the Ark app and SDK, the membership service, security reviewers, and anyone building a signup flow for a member who
signs with an external wallet. The test vectors in [testdata/signup/vectors.json](../testdata/signup/vectors.json) are
part of this specification: a producer must reproduce their bytes and a verifier must return their refusals.

## Contents

- [1. Purpose](#1-purpose)
- [2. Terms](#2-terms)
- [3. Flow](#3-flow)
- [4. Documents](#4-documents)
- [5. Signature](#5-signature)
- [6. Submission](#6-submission)
- [7. Verification](#7-verification)
- [8. Compatibility](#8-compatibility)
- [9. Test vectors](#9-test-vectors)
- [10. Security notes](#10-security-notes)
- [11. Out of scope](#11-out-of-scope)

## 1. Purpose

A member grant pays to one address for a year and the registration is permanent. The chain never sees a person: the link
between an admitted person and the address that is paid is made once, off chain, by the membership service. This
protocol is that link. It gives the platform two signatures:

- a **proof of possession**: the member signs a challenge the platform issued, which proves the submitted address is
  controlled by the key that signed and binds that address to one admission;
- a **vouch**: an existing member signs a document naming the admission, which makes the vouch verifiable and
  attributable to a member key rather than to a click. A vouch is the admission's basis for a person who has not
  passed the identity check, and the voucher's membership stands behind it under the
  [admission rules](https://github.com/ararat-network/ark/blob/main/docs/governance/DISBURSEMENT_PLAN.md#admission).

Both are ADR-036 off-chain signatures. They sign no transaction, move no coins, and need no balance, which matters
because a member holds nothing until the grant's first payment.

## 2. Terms

| Term | Meaning |
| --- | --- |
| Member | A person admitted by the platform; after registration, the holder of a member grant. |
| Admission | The platform's record that a person passed the identity check or was vouched for, which basis it rests on, and the vouch if any. It names no person. |
| Platform | The membership service, `ark-membership`, the backend behind the Ark app. It issues documents and verifies signatures. |
| Verifier | The third-party identity check. Its attestation is opaque to this protocol. |
| Voucher | A member whose address the chain lists, whom the platform has not suspended, and whose standing under the admission rules allows another vouch. |
| Address | Canonical lowercase Bech32, prefix `ark`, 20-byte payload: RIPEMD-160 of SHA-256 of a compressed secp256k1 key. |
| Origin | The platform's web origin, lowercase scheme and host, a port if not the default, no path or trailing slash. |

## 3. Flow

1. The platform opens an admission for a prospective member on one of two bases: the verifier's attestation reaches
   it, or a member offers to vouch.
2. For a vouch, the platform issues a **vouch document** for the admission. The voucher signs it with their member
   key. The platform verifies it under [§7](#7-verification) with the vouch domain and records the vouch. A verified
   person may collect a vouch as well, which raises their standing under the admission rules.
3. The admission is complete once one basis holds. The platform issues a **challenge** for it.
4. The member signs the challenge. The platform verifies it under [§7](#7-verification) with the signup domain and
   stores the address and the proof beside the admission.
5. The platform batches the address to the registrar. Nothing from this protocol reaches the chain: the registrar's
   `MsgRegisterMembers` carries a reference naming the admission batch, never an admission, a proof, or a person.

Order within the admission is the platform's: an attestation and a vouch may arrive in either order, and a vouched
member may verify later. The challenge is issued only for a complete admission, so a proof always binds to an admission
that can be registered.

## 4. Documents

The challenge and the vouch document share one shape. Each is a JSON object with exactly these members:

| Member | Value |
| --- | --- |
| `admission` | The admission ID, opaque to the signer. Printable ASCII, 1 to 128 bytes, no whitespace. |
| `chain_id` | The chain the member will register on: `ark-1`, `ark-testnet-1`, or a local chain ID. |
| `domain` | `ark-signup/v1` for a challenge, `ark-vouch/v1` for a vouch document. |
| `expires` | The first second at which the document is no longer valid, Unix seconds as a decimal string. |
| `issued` | The second the platform issued it, Unix seconds as a decimal string. |
| `nonce` | 32 bytes from a cryptographic random source, as 64 lowercase hexadecimal characters. |
| `origin` | The platform's origin. |

**Canonical encoding.** Members in the order above, which is byte order of their names; no whitespace; UTF-8; every
value a JSON string. No value may contain `"`, `\`, `<`, `>`, `&`, or a byte outside printable ASCII, so no JSON or
HTML escaping ever applies and every encoder produces the same bytes. The document is signed and compared as these
bytes.

**Window.** `issued <= now < expires`. A challenge expires at most 15 minutes after issue, 10 by default. A vouch
document expires at most 24 hours after issue, since the voucher signs on their own device in their own time. Those
maxima are the platform's issuance policy; a verifier checks the window against its clock under rules 8 and 9 and
nothing else. A document is single use: the platform refuses a nonce it has already accepted.

**Binding.** `chain_id` and `origin` stop a document issued by one platform or for one chain from being accepted by
another. `admission` stops a proof made for one admission from being attached to another. `nonce` and the window stop
replay.

## 5. Signature

The signature is ADR-036: an amino sign document that can never be a valid transaction, with the document from §4 as
its data.

```json
{"account_number":"0","chain_id":"","fee":{"amount":[],"gas":"0"},"memo":"","msgs":[{"type":"sign/MsgSignData","value":{"data":"<base64 of the document bytes>","signer":"<address>"}}],"sequence":"0"}
```

- **Sign bytes.** The object above with keys sorted byte-wise at every level, no whitespace, UTF-8. `data` is standard
  base64 with padding. By construction the sign bytes contain no character that JSON or HTML encoders escape, so
  Go's `encoding/json` with the SDK's `MustSortJSON`, Keplr's `serializeSignDoc`, and the Ledger app's parser all see
  the same bytes.
- **Signer.** The address from §2. It must equal the address derived from the public key presented with the
  signature.
- **Hash and curve.** SHA-256 of the sign bytes, signed with ECDSA over secp256k1.
- **Signature.** 64 bytes, `r || s`, each 32 bytes big-endian, `s` in the lower half of the curve order. A high-S
  signature is refused.
- **Public key.** 33 bytes, compressed secp256k1.
- **Keys.** One simple secp256k1 key only. A multisig cannot produce ADR-036 signatures, and the chain's other key
  types are not accepted for membership.

What each signer does with it:

- The Ark app's signer interface signs the document through its sign-arbitrary call.
- Keplr and Leap sign it through `signArbitrary` with the document text as the data, which they show as it is and
  sign as its bytes; their verification helper accepts the result.
- A Ledger signs the amino sign bytes. The device shows the document in expert mode, with `data` as base64.

## 6. Submission

The signer sends the platform four values. Transport, authentication of the session, and rate limiting belong to the
platform's API, not to this protocol.

| Value | Encoding |
| --- | --- |
| `data` | The document bytes, verbatim. |
| `signer` | The address, as signed. |
| `public_key` | 33 bytes, standard base64. |
| `signature` | 64 bytes, standard base64. |

The platform stores the four values beside the admission as the proof, or the vouch. It stores no key material and
nothing that names a person. The chain receives the address in a registration batch and nothing else.

## 7. Verification

The platform applies these rules in order and refuses at the first that fails, with the code shown. The order is part
of the contract: the vectors assert which code a bad submission receives.

| # | Rule | Code |
| --- | --- | --- |
| 1 | `signer` is canonical lowercase Bech32 with prefix `ark` and a 20-byte payload. | `signer_invalid` |
| 2 | `public_key` is 33 bytes compressed secp256k1 and derives to `signer`. | `key_mismatch` |
| 3 | `signature` is 64 bytes, low-S, and verifies over the sign bytes built from `signer` and `data`. | `signature_invalid` |
| 4 | `data` parses as a canonical document of §4 and re-encodes to the same bytes. | `data_invalid` |
| 5 | The platform issued a document with this `nonce`. | `nonce_unknown` |
| 6 | That nonce has not been accepted before. | `nonce_used` |
| 7 | `domain`, `chain_id`, `origin`, and `admission` equal the issued document's, and `domain` is the one expected for this submission. | `challenge_mismatch` |
| 8 | `issued <= now`. | `not_yet_valid` |
| 9 | `now < expires`. | `expired` |
| 10 | Signup only: no admission already holds this address. | `address_taken` |
| 11 | Signup only: the chain lists no member at this address. | `member_exists` |
| 12 | Vouch only: the chain lists `signer` as a member and the platform has not suspended it. | `voucher_not_member` |
| 13 | Vouch only: `signer` may vouch under the admission rules: within their limit, with unpaid grant above the tenth, and verified once a verifier exists. | `voucher_not_eligible` |

On success the platform stores the submission, marks the nonce used, and, for a challenge, binds the address to the
admission. Rules 1 to 4 need no state and are the generic ADR-036 layer; rules 5 to 9 need the platform's issued
documents and a clock; rules 10 to 13 need the admission store and a node.

## 8. Compatibility

- Direct signing stays the chain's transaction sign mode. Amino JSON appears in this protocol and on the Ledger, and
  nowhere else.
- Any wallet that implements ADR-036 can complete signup. A signup web flow hands it the document bytes as the data and
  submits what comes back.
- Changes to the document are additive within a domain version. An incompatible change takes a new `domain` string;
  a verifier refuses a domain it does not know under rule 7.

## 9. Test vectors

[testdata/signup/vectors.json](../testdata/signup/vectors.json) holds three test keys and the vectors. The keys are
test fixtures: never fund them.

Each vector gives `prefix`, `domain`, the document the platform issued as `challenge` (or `null` when it issued none),
`now`, and the four submission values plus `sign_bytes`, the exact ADR-036 sign bytes. Two results are stated:

- `signature_valid`: whether rule 3 holds, the generic layer's answer;
- `expect`: the first refusal of rules 1 to 9, or `ok`.

A producer takes `signer` and `data`, must reproduce `sign_bytes`, and with the named test key must reproduce
`signature`. A verifier runs rules 1 to 9 and must return `expect`. Rules 10 to 13 are not in the vectors.

The vectors are generated from the chain's secp256k1 and JSON sorting and checked against Keplr's ADR-36
serialisation and verifier, so the two implementations that matter already agree on every byte.

## 10. Security notes

- The proof binds an address to an admission and to a key. It does not authenticate the member's session: a stolen
  session can still submit the thief's address against the victim's admission. That is bounded by the platform's
  session and device controls and by the registration hold, in which the committee can suspend it.
- The platform never holds a key. A proof reveals a public key, which the chain reveals at the address's first
  transaction in any case.
- The sign document can never be a valid transaction: empty chain ID, zero account number, zero sequence, zero fee.
- A member asked by a third party to sign an `ark-signup/v1` document should read `origin`; it is there to be read.
  Wallets show the data as text.
- Nothing in a document or a submission names a person. Everything the platform stores from this protocol can be
  published without exposing one.
- A vouch is a stake, not a click: the admission rules cancel a voucher whose vouchee is found to be a fake. The
  document names only the admission, so the app shows the voucher which request they are answering before they sign,
  and a voucher asked to sign an `ark-vouch/v1` document anywhere else should refuse.

## 11. Out of scope

The platform's endpoints, session authentication, rate limiting, and device attestation; the verifier's attestation
envelope; the admission and uniqueness stores; the admission rules, who may vouch, their limits, and what a finding
costs, which are the [disbursement plan's](https://github.com/ararat-network/ark/blob/main/docs/governance/DISBURSEMENT_PLAN.md#admission);
the registrar and the chain. Those are the platform's and the chain's own specifications.
