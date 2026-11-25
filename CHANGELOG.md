# Changelog

## 0.4.0

What the app's signer needs to review a transaction before it signs: an amino sign document read back into the
transaction it describes, and a transaction prepared, signed, and broadcast as three steps, so the fee is shown before
the signature is asked for. Code written against 0.3 needs changes: see Changed and Removed below, and `sendTx` first
among them, which no longer signs a second time on a sequence mismatch unless asked to.

Fixed:

- The amino sign bytes of a contract message whose JSON holds half a surrogate pair as an escape, `"\ud83d"`, match
  the chain's. Go reads the escaped half as U+FFFD and writes that character as it is; the encoder wrote the
  six-character escape `\ufffd`, so the chain would have refused the signature. Checked against the chain's own
  encoder. Two member names that become one this way are refused, since the chain keeps the later in the text.

Added:

- `decodeAminoSignDoc`, the reverse of `makeAminoSignDoc`: the body, fee, chain ID, account number, and sequence an
  amino sign document describes, for a signer that is handed the document alone and must show what it says.
  `aminoDecode` and `aminoDecodeAny` read one message, the reverse of `aminoEncode` and `aminoEncodeAny`, and
  `durationFromAmino` a duration's nanoseconds. The decoder reads by the schemas the encoder writes by, finds a
  message by its amino name, or by its type URL when it has none, and refuses a name two registered types share, a
  member that names no field, and whatever the encoder refuses. A decoding is returned only if it encodes back to the
  JSON it was read from. A contract message's bytes come back as the same JSON, compact with sorted keys, and every
  message's bytes with its fields in number order: the document carries the content, not how its bytes were written.
- `prepareTx`, the first of three steps a transaction now goes through: it asks the chain for the account, the gas,
  the tax, and the price sheet, and returns a `PreparedTx`, the unsigned transaction with the quote that priced it.
  It signs nothing and takes no signer, only the account that will sign, so a caller can show the quote before it
  asks for a signature. `signTx` then signs `prepared.tx` with no request to a node, so the fee signed is the fee
  the quote declares, and `broadcastTx` sends what was signed.
- `SignedTx.timeoutHeight`, the body's timeout height when it has one. `broadcastTx` and `sendTx` read it for the
  wait, so a caller no longer passes it a second time in the options.

Changed:

- `signTx` takes the transaction and the signer as two arguments, `signTx(tx, signer)`, where it took one input
  holding both. It signs a transaction `prepareTx` made as it signs one written out by hand.
- `broadcastAndConfirm` is `broadcastTx`, and takes the signed transaction where it took its bytes: a `SignedTx`, or
  `{ txBytes }` for bytes signed elsewhere. Nothing is signed in it, so the same signed transaction is handed over
  again after a broadcast whose outcome is unknown.
- `sendTx` takes the signer and the address it signs for, as before, and now asks the signer for its accounts once
  and first, before any request to a node. It signs again on a sequence mismatch only when passed
  `retryOnSequenceMismatch`, which was on by default: signing again is a second signature, which a signer that shows
  each document to a person asks them for again. The account number and the sequence it returns are under `tx`.

Removed:

- `prepareAndSign`, with `PrepareInput` and `Prepared`: it is `prepareTx` then `signTx`, and had nothing to show
  between the two. `SignTxInput` is `UnsignedTx`, without the signer.

## 0.3.0

The fixes from two correctness reviews, and a client for each service. Code written against 0.2 may need changes: see
Changed and Removed below, and the order of a fee's legs first among them, since it changes the bytes that are signed.

Fixed:

- `waitForInclusion`, and `sendTx` through it, read a timeout height of zero as none. Zero is the body's value for no
  timeout; it was compared as a height, so the first poll after an accepted broadcast threw `TransactionExpired` for
  a transaction that then landed.
- `broadcastSync` reports a 502, 503, or 504 answer as `BroadcastUnknown`, with the hash to poll and the gateway's
  answer as its cause. A proxy answers with these when the node's own answer was lost, after the node may have taken
  the transaction; they surfaced as a plain `QueryError` with no hash. A 429 is still a `QueryError`.
- An indexer endpoint the registry's rule refuses is named as `ark.json`'s. The error said `chain.json indexer
  endpoint`, a file that holds none.
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
  returns and `decodeMessage` shows as the message's `json` with `known: false`. A known `Any` that holds one, at any
  depth, is kept the same way, whole: a `MsgExec` around a message the registry lacks, or an account whose key type
  it lacks, is unknown with the node's JSON, never bytes that name the inner type with none of its content.
  `unpackAny`, the amino encoder, and `packMessages` never treat an empty value as the message, and `packAny` refuses
  a message built around one, so `packMessages` and `signTx` do too.
- An amount is read as the chain reads it. The chain takes the base of a `cosmos.Int`'s or a `cosmos.Dec`'s text
  from the text, so `"0100"` is 64 and `"0x10"` is 16, and it executes a transaction that carries one; the SDK read
  the digits as decimal or passed them through. A send built with `coin("ausd", "0100")` moved 64 where its caller
  wrote 100, and a transaction's bytes decoded here showed 100 where 64 had moved. `sumCoins`, `formatCoin`,
  `coinsToString`, `LegacyDec.fromWire`, the vesting and fee arithmetic, and the JSON view now give the chain's
  number, and refuse text the chain refuses; `fromProtoJson` reads an `Int`'s JSON text the same way. The amino
  document still carries a string `Int`'s text as it is, as the chain's does.
- `formatAssetAmount`, `formatCoin`, and `formatDecCoin` accept a `minimumFractionDigits` above the default most of
  six; the most stayed at six, and the formatter threw `RangeError`. The most is raised to the least asked for.
- `shortenAddress` with a tail of zero ends at the ellipsis. `slice(-0)` is the whole string, so the address came
  back whole after it. A negative or fractional count is read as a whole number, zero at least.
- `prepareAndSign`, `sendTx`, and `maxSendable` say that a fee denomination is missing when `feeDenom` is empty; the
  error named an empty denomination as absent from the gas price sheet, after the flow's requests.
- The README's simulate sample compiles under `strict`: it read a signer's first account and a simulation's gas
  info without checking either was there.
- A bytes field in a route's path is sent as the gateway reads it: base64 in the URL's alphabet, of the bytes
  themselves. `gateway.call` put a smart contract query's JSON in the path, which the gateway refused, and the
  standard alphabet elsewhere, whose `/` the gateway takes for a path separator: a raw contract state key or
  `addressBytesToString` failed for about a third of binary values, and for some answered for another key.
- Bytes cast to CometBFT's `HexBytes` are written and read as uppercase hex, as the chain's JSON has them. wasmd's
  contract state keys and code checksums were read as base64: wrong bytes with no error, or the base64 library's.
- A list of inline JSON renders as a list of what each holds, as the chain shows a contract authorization's
  accepted messages; it rendered as base64 that did not read back to the same bytes.
- The amino document signs a contract message's JSON member for member. A member named `__proto__` was dropped
  and a negative zero written as `0`, so a Ledger signed bytes the chain did not rebuild. It also holds the memo,
  chain ID, payer, and granter as the transaction's bytes carry them, half a surrogate pair as U+FFFD.
- The amino encoder's bound on a duration is the chain's: seconds whose nanoseconds fit a 64-bit integer. It was
  jsonpb's ten thousand years, so a duration over 292 years was signed that the chain refuses to encode.
- wasmd's access type renders as `Unspecified` for a value it does not name, as wasmd writes it, not as a number.
- `paginate` and `collectAll` walk a route that pages by offset to its end. They stopped when an answer carried no
  next key, and such a route never carries one: `collectAll` over `tx.byBlock` returned the first 100 transactions
  of a larger block, with no error. A page with no next key whose total says more exist is followed by offset,
  a page's worth of positions at a time: a page may hold fewer items than the positions it covers, as a block's
  does on Ark, whose first position is data the node cannot show as a transaction.
- A gateway answer carrying an enum value under a name the SDK's types lack no longer fails the whole call: one
  proposal with a status newer than the SDK failed `gov.proposals` for the list. The field holds its zero value,
  the new `unknownEnumNames` returns the name it arrived as, and an `Any` around it is kept as the node's JSON.
- A gateway answer that does not fit its type is refused with `ProtoJsonError`. A mistyped integer surfaced as the
  runtime's `SyntaxError` or `RangeError`, and bad base64 as the base64 library's own error. `fromProtoJson` names
  the field and checks an integer's range; `fromBase64` and `fromHex` throw `ArkSdkError`, as do `marshalGoJson`
  for a number that is not finite and, as `DecError`, `LegacyDec.fromInt` for a fraction.
- A request timeout above 2^31 − 1 ms, `Infinity` included, waits; a timer that long fires at once, so the request
  timed out after a millisecond. Such a timeout is held to the longest a timer runs, about 25 days, and one that
  is not positive is refused.
- A `GatewayClient` or `QueryClient` built without a registry, by a caller the types do not reach, is refused at
  once with `ArkSdkError`; it was a `TypeError`, or none until the first `Any`. The core entry's readers, `decodeTx`
  and `toProtoJson` among them, say the same by name when called without one.
- The JSON view of a contract message keeps every integer exact. It parsed the message's JSON into numbers, so a
  64-bit value above 2^53 was shown rounded. Such a value is now the runtime's raw JSON value, which
  `JSON.stringify` writes back digit for digit, and the view reads back to the bytes it came from. On a runtime
  without `JSON.rawJSON` it is a number, as before.
- `loadNetwork` takes a registry directory's name and a git ref, and refuses anything else before requesting a
  file. Both went into the URL as given, so a name or a ref holding `..` read another repository's files:
  `loadNetwork("../../../other/repo/main/arktestnet")` built a network, chain ID and endpoints included, from them,
  which matters to an app that takes either from a link or a setting. `registrySource` refuses such a ref too.
- `loadNetwork` refuses files that describe another network than the one asked for. A directory serving another
  chain's well-formed files handed a caller who asked for the testnet that chain's ID and endpoints.
- A unit's exponent is at most 77, the places a 256-bit amount has. A registry file giving one of 10^21 was accepted,
  and formatting an amount of that asset threw the runtime's `RangeError`.
- A name belongs to one unit of an asset. A unit's alias matching the display unit's name, or the display unit
  listed twice, gave the asset the exponent of whichever came first: with the display's at 18 read as 0, an amount
  of one display unit was built as one base unit. Such an asset is refused.
- `loadNetwork` reports a request that fails as a `RegistryError` with the failure as its cause; the runtime's own
  error came through. Its "not JSON" error keeps its cause too.
- The denomination chosen to pay the base fee pays it. `quoteFee` and `prepareAndSign` encoded the fee's legs in
  denomination order, and the ante charges the first stable leg, in encoded order, whose slack above its tax covers
  the base fee. A lifted tax leg has slack, so on a taxed send in a denomination that sorts before `feeDenom`, from
  about 47 EUR at a 0.5% tax and a 1.1 headroom, the ante took the base fee from the tax leg's denomination while
  the quote named `feeDenom`; a payer holding exactly the principal and its tax there had the transfer fail with
  the fee kept. A stable gas leg is now encoded first.
- `affordableFeeDenoms` offers a denomination when the payer holds what the chain draws. It required the lifted
  ceiling of every leg, a tax leg's included, though the ante draws a tax leg's tax and no more: a payer holding
  exactly the principal and its tax was not offered another denomination for the gas, the one case that needs it.
  The gas leg is still counted at its ceiling, as arkd counts it, and a NOAH leg whole.
- `sendTx` signs again on a sequence mismatch only while the first transaction cannot be in the mempool: when the
  flow before the broadcast met it, or CheckTx refused the transaction for it. It read the text of any query error
  from the whole flow, the wait after an accepted broadcast included, so a lookup answered with the ante's sequence
  error made it sign and broadcast the same messages a second time at the next sequence: two payments.
- A lookup answered with no transaction hash is refused with `WrongTransaction`, as one for another hash is.
  `waitForInclusion`, `fetchTx`, and `lookUpTx` took an empty answer for the transaction, and an empty result reads
  as code zero: a success reported for a transaction that may be in no block.
- `broadcastSync` reports a broadcast answer it cannot read as `BroadcastUnknown`, with the hash and what failed
  as the cause, and likewise an answer with a status above 504, which a CDN gives for an origin that timed out.
  They surfaced as a codec error or a `QueryError` with no hash, though the node may hold the transaction. A 500 and
  a 501 are still the node's own refusal.
- `waitForInclusion` says a transaction expired only once it has stayed unfound for `expiryGraceMs`, 10 seconds by
  default, after the chain is seen past its timeout height, and only on a node that says it is not catching up. A
  node reports a block before it has indexed the block's transactions, so the one look it took could report a
  transaction as never includable that a block at the height had carried.
- With several endpoints, calls in flight together each walk the endpoints once. A call read the client's current
  endpoint again at every attempt, so one that failed over while another was still waiting sent that other back to
  the endpoint it had just left: it could fail with `EndpointsExhausted` naming one endpoint twice while a healthy
  one was never tried, and a late answer from the first endpoint moved the client back to it. A call's walk is now
  fixed when it begins, and only a call that moved on moves the client.
- `verifyNetwork` with `genesis` reports a genesis file it could not fetch as a `RegistryError` with the failure as
  its cause, as `loadNetwork` reports a registry file; the runtime's own error came through.
- `utf8Decode` throws an `ArkSdkError` for bytes that are not UTF-8, as `fromHex` and `fromBase64` do for their
  text; it threw the runtime's `TypeError`, which `toProtoJson`, `aminoEncode`, and `materialise` let through for a
  `Dec` or an `Int` carried as bytes that are not text.
- `prepareAndSign`, `sendTx`, and `maxSendable` price a fee denomination by the sheet's reference row when the sheet
  lists a row under the same name, as `affordableFeeDenoms` and arkd do; they took the sheet's row. The chain lists
  the reference apart from the sheet, so no answer of its own changes.
- `LegacyDec.mulInt` and `quoInt` refuse a number that is not an integer with `DecError`, as `fromInt` does; BigInt's
  `RangeError` came through.
- `privateKeyFromMnemonic` refuses a derivation path that is not one with `KeyError`, the library's error as its
  cause; the library's own came through.
- `fromOfflineSigner` refuses a sign document whose account number is not an integer with `SignerError`; a wallet
  returning other text met BigInt's `SyntaxError`.
- `waitForInclusion`, and `broadcastAndConfirm` and `sendTx` through it, end with the caller's abort reason as it was
  given. A reason that was not an `Error` was replaced by a bare `Error("aborted")`.
- `decodeAddress` keeps the bech32 library's error as the cause of its `AddressError`.

Added:

- `maxSendable`, the largest amount of one denomination a payer can send: the amount, the tax the chain computes for
  it, and what else is drawn from that balance, a gas leg at its ceiling when `feeDenom` is the denomination sent
  and a tip when it is NOAH, fit in the spendable balance. The tax is read from the chain for the caller's own
  messages, never recomputed, and the answer is one the chain's tax was read for, with one base unit more read not
  to fit. A rate and a cap settle in about five tax queries.
- `FeeDenomChoiceInput.reference`, the sheet's reference row: given it, `affordableFeeDenoms` offers the reference
  denomination where arkd ranks it, after NOAH and before the rest of the sheet. Its comment claimed arkd's order
  while the reference, arkd's first choice for a send of it, was never offered.
- `unknownEnumNames`, and `unknownEnum: "keep"` on `fromProtoJson`, which still throws on an unknown enum name by
  default.
- `InclusionUnknown`, thrown by `sendTx` and `broadcastAndConfirm` when the wait for a block fails after the mempool
  accepted the transaction: it carries the hash, the mempool's verdict, and what the wait met as the cause.
- `InclusionOptions.expiryGraceMs` and `DEFAULT_EXPIRY_GRACE_MS`, how long a transaction stays unfound past its
  timeout height before `waitForInclusion` calls it expired.
- `intFromWire`, the integer a `cosmos.Int`'s text holds as the chain reads it: what to use in place of `BigInt` on
  a coin's amount out of a decoded message.
- `unknownAnyJson` and `anyFromUnknownJson`, and `unknownAny: "keep"` on `fromProtoJson`, which still throws on an
  unknown type by default.
- `@ararat-network/sdk/core`, a second entry with the main entry's names and no default registry: whatever reads an
  `Any` takes its registry as an argument, so an app bundles only the types it names. A gateway client over one
  service bundles 11 generated files, 118 KiB minified, where the main entry bundles all 197, 440 KiB. `WithRegistry` is the required form of
  `RegistryOption`. The main entry is the core with the registry defaulted, and is otherwise unchanged.
- A client for each service `QueryClient` reads, over a gateway: `authClient`, `bankClient`, `disbursementClient`,
  `distributionClient`, `govClient`, `marketClient`, `nodeClient`, `oracleClient`, `stakingClient`, `treasuryClient`,
  and `txClient`. `QueryClient` is those over its own gateway and bundles every one, 47 generated files whatever its
  registry; a caller of the core entry who builds the ones it calls bundles those alone. Each flow's `client` is typed
  by the services it reads, so it takes either: `searchTxs` and `fetchTx` the gateway and `tx`, `lookUpTx` and
  `broadcastSync` `tx`, `maxSendable` `treasury`, `prepareAndSign` the gateway, `auth`, `tx`, and `treasury`, and
  `sendTx`, `waitForInclusion`, and `broadcastAndConfirm` `node` as well. A send through four services' clients is
  207 kB minified where through the core's `QueryClient` it is 276; a search through `txClient` is 155 where it was 254.
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

- With a stable gas leg and no `legOrder`, the fee's legs are signed with the gas leg's denomination first, where
  they were in denomination order. A fee of one leg, or with NOAH carrying the gas, is unchanged. For a fee of
  several legs the signed bytes now differ from arkd's for the same inputs, since arkd can only sort; `legOrder: []`
  gives denomination order.
- After an accepted broadcast, `sendTx` and `broadcastAndConfirm` throw `InclusionUnknown` where they threw whatever
  the wait met: a node's error answering a lookup, or the caller's abort, which is now its `cause`. Such an error
  carried no hash, and a caller of `sendTx` holds neither the bytes nor the hash, so a transaction was left in the
  mempool with nothing to find it by. `InclusionTimeout`, `TransactionExpired`, and `WrongTransaction` carry the
  hash and are thrown as they were; `waitForInclusion` called directly is unchanged. This is a breaking change for
  a caller that matched those errors by class or by an abort's name.
- `coin` refuses an amount that is negative, over 256 bits, or text other than decimal digits with no leading zero,
  with `CoinError`; it passed any text through. `parseCoin` and `parseCoins` refuse a leading zero, and
  `coinFromDisplay` a negative amount. `packMessages`, and so `signTx` and `prepareAndSign`, refuse a message whose
  `Int` or `Dec` field holds text the chain would not write. This is a breaking change for a caller that relied on
  such text being passed on: the chain read it as another number, or refused it.
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
- `Network.fromRegistry` takes the three files as the JSON they were read as, `unknown` each, and builds the network
  from what its checks return: a member cannot be read unless it was checked. A value typed `RegistryFiles` is still
  accepted. The network no longer shares objects with the files, so changing an endpoint in them afterwards does not
  change it. In `features`, a member that is not true or false is no longer carried over.
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
- `waitForInclusion` with a timeout height reads the node's height and whether it is catching up from one answer,
  the node's sync state, on each poll. It read the latest block for the height, which carries the block's
  transactions and its commit twice over, and asked the sync state apart. A node whose sync state carries no height
  still has its latest block read.

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
- `ChainJson.status`, `ChainJson.fees`, and `ArkJson.logo_URIs`. The types are what the registry's parsers return,
  and no parser returned these: a network never carried them.

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
