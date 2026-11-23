# Changelog

## 0.2.0

The signup protocol leaves the SDK. Signup is completed in the Ark app alone, so the protocol, its code, and its
vectors live in `ark-app`'s signer, and the SDK is transactions, queries, and decoding.

Removed, with no replacement here:

- `signDocument`, `checkSubmission`, `verifySignature`, `submissionToJson`, `submissionFromJson`, `secp256k1KeyBytes`,
  and the `Submission`, `SubmissionJson`, and `StatelessRefusal` types.
- `parseDocument`, `validateDocument`, `documentBytes`, `DocumentError`, `SignupDocument`, `Domain`, `SIGNUP_DOMAIN`,
  and `VOUCH_DOMAIN`.
- `adr036SignBytes` and `MSG_SIGN_DATA_TYPE`.
- `signArbitrary` on the `Signer` interface and on `MemorySigner`, and the `ArbitrarySignature` type. A signer written
  against 0.1 may keep the method; the SDK no longer calls it.
- The second argument of `fromOfflineSigner`, with `OfflineSignerOptions` and `ArbitrarySignerLike`: the adapter no
  longer wraps a wallet's ADR-036 call.
- `testdata/signup/vectors.json`.

## 0.1.2

No change to the code. The first release from the release workflow, with provenance: the workflow stages the version
on npm and a maintainer approves it, so no workflow run publishes on its own. 0.1.0 was published by hand to create
the package.

## 0.1.1

Not published. The release workflow published directly, which the package's trusted publisher does not allow.

## 0.1.0

The first-tranche SDK: network registry, keys and addresses behind the `Signer` interface, the chain's JSON dialect
and amino sign bytes, typed queries over the gRPC gateway with failover and pagination, transaction construction
under the fee contract with a one-call flow, the signup protocol's ADR-036 proof, a decoder for transactions, typed
events, results, message responses, and accounts with vesting schedules, transaction search, formatting, and an
adapter for CosmJS-shaped wallets. Every decoding fixture and signup vector reproduces byte for byte.
