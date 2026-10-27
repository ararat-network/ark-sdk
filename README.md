# ark-sdk

The TypeScript SDK for [Ark](https://github.com/ararat-network/ark) and the home of the client contracts it
implements. The [tooling direction](https://github.com/ararat-network/ark/blob/main/docs/direction/TOOLING_DIRECTION.md)
says what the SDK is for and where it sits among Ark's repositories.

The package is `@ararat-network/sdk`. It holds what the first member tranche needs: the network registry, keys and
addresses behind a signer interface, typed queries, transaction construction under the fee contract, the signup
protocol's ADR-036 proof, and a decoder, every byte checked against the chain's own fixtures.

| Path | Holds |
| --- | --- |
| [src/registry/](src/registry/) | The network registry: chain ID, prefix, coin type, assets and display units, endpoints, feature flags, and the genesis hash check, from [ark-registry](https://github.com/ararat-network/ark-registry). |
| [src/keys/](src/keys/) | Bech32 addresses, secp256k1, BIP-39 derivation at coin type 330, the `Signer` interface, and an in-memory signer for tests and development. |
| [src/codec/](src/codec/) | The chain's JSON dialect both ways, the amino JSON encoder a Ledger signs, `LegacyDec`, Any packing, and the type registry. |
| [src/query/](src/query/) | The gateway client over one endpoint or several, routes read from the generated descriptors, typed facades for Ark's and the Cosmos modules, pagination, and transaction search. |
| [src/tx/](src/tx/) | Body, fee, sign documents, signing in direct or amino mode, broadcast, confirmation by polling, and the whole flow in one call. |
| [src/adr036/](src/adr036/) | The signup challenge and vouch document, its canonical bytes, the proof, and the stateless checks. |
| [src/decode/](src/decode/) | Transactions, typed events, results, message responses, and accounts with their vesting schedules, read the one way every Ark reader must. |
| [src/format/](src/format/) | Amounts in display units for a locale, coin text, shortened addresses. |
| [src/gen/](src/gen/) | Every message, query, and event the SDK can meet, generated from the protos at the pins below; importable as `@ararat-network/sdk/gen/...`. |
| [testdata/decoding/](testdata/decoding/) | `ark`'s decoding fixtures at the tag in [ARK_VERSION](ARK_VERSION): the byte-for-byte contract the codec, builder, and decoder are tested against. |
| [docs/SIGNUP_PROTOCOL.md](docs/SIGNUP_PROTOCOL.md), [testdata/signup/vectors.json](testdata/signup/vectors.json) | The member signup protocol and its vectors, which the producer here and the membership service's verifier both reproduce. |

## Use

```sh
pnpm add @ararat-network/sdk
```

A network comes from the registry, a client from its REST endpoints, and the client checks it reached that chain.
Given several endpoints, a call that cannot reach one, or finds it unavailable, moves to the next and stays there;
an answer that blames the request is final, and a broadcast is never re-sent:

```ts
import { collectAll, loadNetwork, QueryClient, searchTxs, txQuery } from "@ararat-network/sdk";

const network = await loadNetwork("arktestnet");
const client = QueryClient.forNetwork(network);
await client.verifyNetwork(network);
const { grant } = await client.disbursement.member(address);
const account = await client.auth.decodedAccount(address);
const delegations = await collectAll((pagination) => client.staking.delegatorDelegations(address, pagination), (p) => p.delegationResponses);
const sent = await searchTxs(client, txQuery.bySender(address), { limit: 20n });
```

`decodedAccount` names the account's type and, for a vesting account such as a seat, its schedule; `vestedCoins`
computes what has vested at a time as the chain does. `searchTxs` needs a node that indexes transactions and returns
each match decoded: its messages, typed events, message responses, and outcome.

A transaction is simulated, priced per the [fee contract](https://github.com/ararat-network/ark/blob/main/docs/clients/CLIENT_FEES.md),
signed through a `Signer`, broadcast, and confirmed. The chain publishes the tax and the gas price sheet; the
headroom and the gas adjustment are yours and must be passed, arkd's numbers are exported for a caller that wants
them:

```ts
import { create } from "@bufbuild/protobuf";
import { MsgSendSchema } from "@ararat-network/sdk/gen/cosmos/bank/v1beta1/tx_pb.js";
import {
  adjustGas, arkdPolicy, broadcastAndConfirm, classifyResult, coin, feeFromQuote,
  packMessages, quoteFee, signTx, simulationTxBytes, typed,
} from "@ararat-network/sdk";

const send = typed(MsgSendSchema, create(MsgSendSchema, { fromAddress, toAddress, amount: [coin("ausd", 10n ** 18n)] }));
const [account] = await signer.accounts();
const { info } = await client.auth.accountInfo(fromAddress);

const simulated = await client.tx.simulate(simulationTxBytes({ messages: [send], publicKey: account.publicKey, sequence: info.sequence }));
const gasLimit = adjustGas(simulated.gasInfo.gasUsed, arkdPolicy.gasAdjustment);
const { tax } = await client.treasury.computeTax(packMessages([send]));
const sheet = await client.treasury.gasPrices();
const quote = quoteFee({ tax, gasPrice: sheet.gasPrices.find((p) => p.denom === "ausd"), gasLimit, headroom: arkdPolicy.headroom });

const signed = await signTx({ signer, address: fromAddress, chainId: network.chainId, accountNumber: info.accountNumber, sequence: info.sequence, messages: [send], fee: feeFromQuote(quote) });
const { response } = await broadcastAndConfirm(client, signed.txBytes);
const outcome = classifyResult(response);
```

`sendTx` runs those steps in that order on the same messages, with the headroom, gas adjustment, and fee
denomination still yours, and, when another transaction took the sequence, signs once more at the sequence the
chain names, whether the mismatch surfaced at simulation or at CheckTx; `prepareAndSign` stops before the broadcast:

```ts
import { arkdPolicy, sendTx } from "@ararat-network/sdk";

const sent = await sendTx({ client, signer, address: fromAddress, chainId: network.chainId, messages: [send], feeDenom: "ausd", headroom: arkdPolicy.headroom, gasAdjustment: arkdPolicy.gasAdjustment });
```

`quote` says what is declared and why: the tax legs, the gas leg at the sheet's price and the height that priced it,
each leg's lift, and the tip, exact, when NOAH carries the gas. The fee denomination is yours. Beside a stable gas
leg every lift is free; beside a NOAH gas leg the tax legs are declared exact, since the ante takes the base fee from
a stable leg's slack before it lets NOAH pay and would then charge the whole NOAH leg as tip, so a tax that rises
before inclusion refuses the transaction for a new quote. `tip`, in NOAH base units, buys priority: its own leg
beside a stable gas leg, part of the NOAH leg when NOAH carries the gas, and `quote.tip` is what will be charged as
tip, exact, since NOAH is charged whole. `broadcastAndConfirm` keeps the mempool's verdict and the block's result
apart: a broadcast whose answer never arrives is an unknown outcome that carries the hash to poll, a node that
already holds the transaction counts as an acceptance, and polling rides out an unavailable endpoint until the
deadline. `classifyResult` names an SDK refusal, an execution failure, or a module error with its log.
`decodeMsgResponses` reads the responses the messages returned from the result's data. Nothing summarises a tax, a
tip, a price age, or a pending transaction away.

The signup proof and the vouch go through the same signer:

```ts
import { signDocument, submissionToJson } from "@ararat-network/sdk";

const submission = await signDocument(signer, address, challengeIssuedByThePlatform);
await fetch(`${origin}/signup/proof`, { method: "POST", body: JSON.stringify(submissionToJson(submission)) });
```

A transaction a node returns, and each event it emitted, decode to typed messages and to the chain's own JSON:

```ts
import { decodeEvents, decodeTx } from "@ararat-network/sdk";

const { messages, json } = decodeTx(txBytes);
const events = decodeEvents(response.events);
```

Two things to know when reading messages. A `cosmos.Dec` field holds the chain's wire form, the 18-decimal scaled
integer; `LegacyDec.fromWire` reads it and the JSON view shows the decimal. And a message type the registry does
not know decodes as unknown, with its type URL and bytes, never under a label it did not earn.

## The signer

Nothing in the package holds or sees a private key. `Signer` is what the SDK asks of whatever does: the accounts it
can sign for, `signDirect` over the protobuf sign document, `signAmino` over the amino document for a Ledger, and
`signArbitrary` over the ADR-036 sign bytes for the signup protocol. `ark-signer` implements it for device keys and
the Ledger; `MemorySigner` implements it for tests and development against a localnet; `fromOfflineSigner` wraps a
wallet with CosmJS's OfflineSigner shape, such as Keplr or Leap, including its ADR-036 call. The builder refuses to
continue if a signer returns a different document than it was given, and refuses direct mode for a multisig key.

## Generated code

[buf.gen.yaml](buf.gen.yaml) generates `src/gen` with `protoc-gen-es` from three inputs, none needing an account:
`ark`'s git repository at the tag named in `ARK_VERSION`, which the file's `tag` must match; the Cosmos SDK module on
the public Buf registry at the commit `ark`'s own `proto/buf.lock` pins, so the transaction, bank, staking, and
governance types are the ones the chain was built against; and wasmd's git repository at the version the chain
embeds. A later input overwrites a shared file, so the chain's Cosmos pin is generated last and wins.
`scripts/gen-files.mjs` then writes `src/codec/files.ts`, the list every generated file the type registry is built
from. The output is committed: a consumer reads source without running `buf`, and
[ci.yml](.github/workflows/ci.yml) regenerates on every pull request and fails if the committed files or the pin
differ. To move to a new chain release, change both the tag and `ARK_VERSION`, then:

```sh
pnpm install
pnpm gen
pnpm fixtures:sync
pnpm check
pnpm test
```

A weekly [pin check](.github/workflows/pin-check.yml) generates at `ark`'s newest chain tag instead and fails if
that would change the files, so a release whose bump was forgotten shows within a week; it holds no token and opens
nothing. The decoding fixtures are copied from the same tag by `pnpm fixtures:sync`, a sparse clone of their one
directory, and `pnpm fixtures:check` fails if the copy differs, so the generated types, the fixtures, and the
network registry move together.

One gap is known and pinned by name in the tests: `ark`'s `proto/buf.lock` pins a cosmos-sdk registry commit older
than the v0.54.4 module the chain is built from, so the generated `cosmos.consensus.v1.MsgUpdateParams` lacks the
`auth` field. The bytes still round-trip as an unknown field; only the JSON view cannot name it. The test fails on
purpose once the schema gains the field, so a pin bump retires the gap.

## Tests

```sh
pnpm check
pnpm lint
pnpm test
```

The tests run on `node:test` through `tsx`; `pnpm test:coverage` adds coverage thresholds, and `pnpm check:package`
and `pnpm check:browser` prove the built tarball installs, its types resolve, and the library bundles for a browser.
[CONTRIBUTING.md](CONTRIBUTING.md) lists every command and the rules. Every one of the 85 transaction fixtures is reproduced byte for byte
from its messages and declared fee: the body and auth-info bytes, the direct sign document, the amino sign bytes a
Ledger would sign, the deterministic signature with the fixture's key, the raw bytes, and the hash; its declared fee
is recomputed from the tax, gas price, gas limit, and pads it records; and its transaction, every typed event in it
and in the recorded blocks, and its result decode to what the files pin. Every one of the 16 signup vectors
reproduces its sign bytes and, where valid, its signature, and the stateless rules return its refusal.

Against `ark`'s Docker localnet (`make localnet-start` in `ark`), the smoke test reads the open member tranche,
then simulates, prices, signs, broadcasts, and confirms a bank send from node0's development key, and decodes the
result. It runs only when the endpoint is named, so CI without Docker skips it:

```sh
ARK_LOCALNET_REST=http://localhost:1317 pnpm test:smoke
```

`ARK_LOCALNET_DATA` points at the localnet's data directory when it is not `../ark/.testnets`.

## Stack

The SDK builds on generated code and small, audited primitives rather than on CosmJS: `protoc-gen-es` for the types,
and the noble and scure libraries for secp256k1, hashing, BIP-39, BIP-32, and Bech32. The chain is SDK v0.54, whose
types CosmJS lags, Ark's own messages are not in any shared library, and Ledger signing needs amino names only Ark's
protos carry; the fixtures prove the encoding byte for byte instead. Queries go over the node's gRPC gateway, which
every node serves and the fee contract names; gRPC-web left the SDK in v0.50 and would need a proxy. pnpm is the
package manager, TypeScript the only language, `tsx` the test runner's one dependency, Biome the linter and formatter,
and nothing in the package holds or sees a key. The type registry holds every generated type so any message decodes; a consumer that wants a smaller
bundle builds its own with `createRegistry` and passes it to the gateway client and the decoders.
