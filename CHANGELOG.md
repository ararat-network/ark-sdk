# Changelog

## Unreleased

Fixed:

- `waitForInclusion`, and `sendTx` through it, read a timeout height of zero as none. Zero is the body's value for no
  timeout; it was compared as a height, so the first poll after an accepted broadcast threw `TransactionExpired` for
  a transaction that then landed.
- `broadcastSync` reports a 502, 503, or 504 answer as `BroadcastUnknown`, with the hash to poll and the gateway's
  answer as its cause. A proxy answers with these when the node's own answer was lost, after the node may have taken
  the transaction; they surfaced as a plain `QueryError` with no hash. A 429 is still a `QueryError`.
- `client.auth.decodedAccount` decodes with the registry the client was given. It used every generated type whatever
  the client's registry, so an account type only the client's registry knew came back with no message.
- `QueryClient` and `GatewayClient` work in a browser without a `fetch` option. They called the stored `fetch` as a
  method of the client, which a browser refuses with "Illegal invocation", so every call failed as a `TransportError`.
- `prepareAndSign` and `sendTx` simulate and sign an unordered transaction at sequence zero, and refuse one without
  a timeout timestamp. They used the account's sequence, which the chain refuses for an unordered transaction, so
  the flow failed for any account that had transacted before. `Prepared.sequence` is the sequence signed at.
- The registry's endpoint rule accepts http for an address in 127.0.0.0/8, not for any host whose name starts with
  `127.`: `http://127.attacker.example` passed as the loopback.
- `broadcastSync` always reports the hash it computed from the bytes, and `waitForInclusion` throws the new
  `WrongTransaction` when a lookup is answered with another hash. The node's echoed `txhash` used to replace the
  computed one and was then polled, so a faulty endpoint could have another transaction's result returned as this one's.
- A route refuses an empty path parameter, as it does a missing one, instead of requesting a path with an empty
  segment.
- A gateway answer carrying an `Any` of a type the registry lacks no longer fails the whole call with
  `UnknownTypeError`. `searchTxs`, `fetchTx`, `tx.byBlock`, `gov.proposals`, `auth.account`, and `waitForInclusion`
  keep it as unknown: the `Any` has its type URL, an empty value, and the node's JSON, which the new `unknownAnyJson`
  returns and `decodeMessage` shows as the message's `json` with `known: false`. Nested inside a known `Any` it keeps
  its type URL alone. `unpackAny`, the amino encoder, and `packMessages` never treat its empty value as the message.

Added:

- `unknownAnyJson` and `anyFromUnknownJson`, and `unknownAny: "keep"` on `fromProtoJson`, which still throws on an
  unknown type by default.
- `@ararat-network/sdk/core`, a second entry with the main entry's names and no default registry: whatever reads an
  `Any` takes its registry as an argument, so an app bundles only the types it names. A gateway client over one
  service bundles 11 generated files, 118 KiB minified, where the main entry bundles all 197, 440 KiB. `WithRegistry` is the required form of
  `RegistryOption`. The main entry is the core with the registry defaulted, and is otherwise unchanged.
- `SignTxInput.registry`, the types the amino encoder resolves the messages against. The main entry defaults it; the
  core entry needs it in amino mode only.
- `ArkSdkError`, the base of every error the SDK throws on purpose: one `instanceof` tells a refusal the SDK made
  from a bug or the runtime's own failure. Every error class the package exports extends it and keeps its own name.
- `GatewayClient.registry`, the types the client resolves an `Any` against, readable so that what decodes one of its
  answers uses the same; and `RegistryOption`, the `registry` member every reader's options share.
- `lookUpTx`, the node's answer for one transaction by hash, undecoded: undefined while the node has none, and
  refusing an answer for another hash. `fetchTx` and `waitForInclusion` both read through it.
- `SignTxInput.signerAccount`, the signer's account when the caller already holds it. `prepareAndSign` passes the one
  it read, so a wallet or a device is asked for its accounts once per transaction, not twice.
- `isJsonObject`, the guard for a `JsonObject`, and `TX_IN_MEMPOOL_CODE` and `WRONG_SEQUENCE_CODE`, the two SDK error
  codes the transaction flow acts on, beside `SDK_CODESPACE`.

Changed:

- Refusals that were a bare `Error` carry an SDK class. `packMessages` throws `UnknownTypeError` for a message read
  without its type, as the amino encoder does, and `UnknownTypeError` takes the message to say so with.
  `QueryClient.forNetwork` throws `RegistryError` for a network that lists no REST endpoint. A request the gateway
  client cannot build, a client given no endpoint, `decodedAccount` answered with no account, and a node that reports
  no latest block throw `ArkSdkError` itself.
- `prepareAndSign` throws `SignerError`, no longer `PrepareError`, when the signer holds no account for the address,
  as `signTx` does.
- `searchTxs` and `fetchTx` decode with the client's registry unless one is passed; they used every generated type.
  A client built without a registry is unaffected. One built with a narrower registry now gets a typed event or a
  message response decoded only when that registry holds its type, so pass a registry to keep the old result.
- `AminoOptions`, `EventDecodeOptions`, and `TxDecodeOptions` are aliases of `RegistryOption`; `GatewayOptions`,
  `ToProtoJsonOptions`, and `FromProtoJsonOptions` are type aliases too; `SearchOptions` extends `RegistryOption`.
  Their members are unchanged.
- The main entry's `QueryClient` and `GatewayClient` extend the core entry's. A `QueryClient`'s `gateway` is the core
  class, so `client.gateway instanceof GatewayClient` is false for the main entry's `GatewayClient`.
- `prepareAndSign` and `sendTx` encode an amino document through the client's registry; they used every generated
  type. A client built without a registry is unaffected.
- `fetchTx` throws `WrongTransaction` when the node answers with another transaction's hash, as `waitForInclusion`
  does. It used to return that transaction decoded.
- `prepareAndSign` asks for the tax and the gas price sheet together, and for the chain's account and the signer's
  together, so a send waits on three round trips before signing where it waited on four. The requests are still issued
  in the fee contract's order, and the simulation still comes before the tax and the sheet.
- `decodeTx` renders each message once: a `DecodedMessage`'s `json` is the same object as its entry in the
  transaction's `json`, where it used to be an equal copy.
- `SignTxInput`, `SimulationTxInput`, and `PrepareInput` extend `TxBodyInput` in place of repeating its members.
- `AminoMsg` is a type alias, no longer an interface, so the amino encoder returns one without a cast. It has the same
  members; only code that merged a declaration into the interface is affected.
- `client.gov.params` takes its params type, `"voting"`, `"tallying"`, or `"deposit"`, as a required argument. The
  default was the empty string, which requested `/cosmos/gov/v1/params/`, a path the gateway does not serve.
- The package index names every export where it re-exported each module whole, so a helper one module shares with
  another is no longer public by accident. Apart from the names under Removed, everything exported before still is.

Removed:

- `Event` is now `ChainEvent`: the name shadowed the DOM's `Event` wherever it was imported. Rename the import.
- The codecs' own plumbing, which was public only because the index re-exported every module: `fieldOptions`,
  `FieldOptions`, `messageOptions`, `MessageOptions`, `LEGACY_DEC`, `MATH_INT`, `SCALAR_DEC`, `SCALAR_INT`,
  `ENCODING_INLINE_JSON`, `ENCODING_LEGACY_COINS`, `ENCODING_NULL_SLICE_AS_EMPTY`, and `stripTrailing`. Nothing replaces
  them; they read proto options for the encoders and trim a string.
- `routeFor` and `Route`, the gateway client's route builder. To change how a request is sent, pass `fetch`.
- `compareUtf8`, `goJsonString`, and `goJsonNumber`, the pieces of the sorted-JSON serialiser. `marshalGoJson`,
  `marshalGoJsonBytes`, and `sortKeys` are the surface.
- `anyHolds`, `schemaFor`, and `concatBytes`, which nothing used. `anyHolds` answered true for an `Any` read without
  its type, which `unpackAnyAs` refuses; `schemaFor(url)` is `registry.getMessage(typeNameOf(url))`.

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
