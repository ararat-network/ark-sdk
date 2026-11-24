# ark-sdk

The TypeScript SDK for [Ark](https://github.com/ararat-network/ark) and the home of the client contracts it
implements. The [tooling direction](https://github.com/ararat-network/ark/blob/main/docs/direction/TOOLING_DIRECTION.md)
says what the SDK is for and where it sits among Ark's repositories.

The package is `@ararat-network/sdk`. It holds what the first member tranche needs: the network registry, keys and
addresses behind a signer interface, typed queries, transaction construction under the fee contract, and a decoder,
every byte checked against the chain's own fixtures.

| Path | Holds |
| --- | --- |
| [src/registry/](src/registry/) | The network registry: chain ID, prefix, coin type, assets and display units, endpoints, feature flags, and the genesis hash check, from [ark-registry](https://github.com/ararat-network/ark-registry), every member checked on load. |
| [src/keys/](src/keys/) | Bech32 addresses, secp256k1, BIP-39 derivation at coin type 330, the `Signer` interface, and an in-memory signer for tests and development. |
| [src/codec/](src/codec/) | The chain's JSON dialect both ways, the amino JSON encoder a Ledger signs, `LegacyDec`, Any packing, and the type registry. |
| [src/query/](src/query/) | The gateway client over one endpoint or several, routes read from the generated descriptors, typed facades for Ark's and the Cosmos modules, pagination, and transaction search. |
| [src/tx/](src/tx/) | Body, fee, sign documents, signing in direct or amino mode, broadcast, confirmation by polling, and the whole flow in one call. |
| [src/decode/](src/decode/) | Transactions, typed events, results, message responses, and accounts with their vesting schedules, read the one way every Ark reader must. |
| [src/format/](src/format/) | Amounts in display units for a locale, coin text, shortened addresses. |
| [src/gen/](src/gen/) | Every message, query, and event the SDK can meet, generated from the protos at the pins below; importable as `@ararat-network/sdk/gen/...`. |
| [testdata/decoding/](testdata/decoding/) | `ark`'s decoding fixtures at the tag in [ARK_VERSION](ARK_VERSION): the byte-for-byte contract the codec, builder, and decoder are tested against. |

## Use

```sh
pnpm add @ararat-network/sdk @bufbuild/protobuf@2.17.0
```

`@bufbuild/protobuf` is the runtime the generated types need and the one you call `create` on; install it beside the
SDK, at the version the SDK pins, since a package manager that keeps dependencies strict does not expose it through
the SDK.

A network comes from the registry, read at `main` unless `ref` pins a commit: every member the SDK reads is checked,
the prefix and coin type must be Ark's, and an endpoint is accepted over https, or http on the loopback. The name is
a registry directory's and the ref a branch, tag, or commit, neither anything that could name other files, and the
network the files describe must be the one asked for. A client
comes from the network's REST endpoints and checks it reached that chain; the check also reports whether the node's
binary is a version the registry lists, refuses one that is not on request, and can hash the genesis file the
registry names against the registry's hash. Given several endpoints, a call that cannot reach one, or finds it
unavailable, moves to the next and stays there; an answer that blames the request is final, and a broadcast is never
re-sent:

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
if (!info) throw new Error(`no account at ${fromAddress}`);

const simulated = await client.tx.simulate(simulationTxBytes({ messages: [send], publicKey: account.publicKey, sequence: info.sequence }));
const gasLimit = adjustGas(simulated.gasInfo.gasUsed, arkdPolicy.gasAdjustment);
const { tax } = await client.treasury.computeTax(packMessages([send]));
const sheet = await client.treasury.gasPrices();
const price = sheet.gasPrices.find((p) => p.denom === "ausd");
if (!price) throw new Error("ausd is not on the gas price sheet");
const quote = quoteFee({ tax, gasPrice: price, gasLimit, headroom: arkdPolicy.headroom });

const signed = await signTx({ signer, address: fromAddress, chainId: network.chainId, accountNumber: info.accountNumber, sequence: info.sequence, messages: [send], fee: feeFromQuote(quote) });
const { response } = await broadcastAndConfirm(client, signed.txBytes);
const outcome = classifyResult(response);
```

`sendTx` runs those steps in that order on the same messages, with the headroom, gas adjustment, and fee
denomination still yours, and, when another transaction took the sequence, signs once more at the sequence the
chain names, whether the mismatch surfaced at simulation or at CheckTx. It signs again only while the first
transaction cannot be in the mempool; once a broadcast is accepted, or its outcome is unknown, nothing is signed
again whatever the node then answers. `prepareAndSign` stops before the broadcast:

```ts
import { arkdPolicy, sendTx } from "@ararat-network/sdk";

const sent = await sendTx({ client, signer, address: fromAddress, chainId: network.chainId, messages: [send], feeDenom: "ausd", headroom: arkdPolicy.headroom, gasAdjustment: arkdPolicy.gasAdjustment });
```

`maxSendable` answers how much of a balance can be sent: the largest amount such that it, the tax the chain computes
for it, and whatever else comes out of that balance all fit. The tax is asked of the chain for the messages you will
sign, so a cap or an exemption counts as it will, and it is counted exact: it is a share of the amount. The gas leg
is kept back, at its ceiling, only when `feeDenom` is the denomination being sent; paid in another, the whole balance
is the amount and its tax. Nothing is signed or sent, and an amount of zero means nothing fits:

```ts
import { maxSendable } from "@ararat-network/sdk";

const { amount, tax } = await maxSendable({
  client, denom: "aeur", spendable: balance, feeDenom: "ausd", gasLimit, headroom: arkdPolicy.headroom,
  messages: (amount) => [typed(MsgSendSchema, create(MsgSendSchema, { fromAddress, toAddress, amount: [coin("aeur", amount)] }))],
});
```

`quote` says what is declared and why: the tax legs, the gas leg at the sheet's price and the height that priced it,
each leg's lift, and the tip, exact, when NOAH carries the gas. The fee denomination is yours, and a stable one's leg
is encoded first: the ante charges the first stable leg, in encoded order, whose slack covers the base fee, and in
denomination order a lifted tax leg that sorts ahead would pay it, in a denomination you did not choose. `legOrder`
sets another order, and an empty one gives the denominations', which is what arkd signs. Beside a stable gas
leg every lift is free; beside a NOAH gas leg the tax legs are declared exact, since the ante takes the base fee from
a stable leg's slack before it lets NOAH pay and would then charge the whole NOAH leg as tip, so a tax that rises
before inclusion refuses the transaction for a new quote. `tip`, in NOAH base units, buys priority: its own leg
beside a stable gas leg, part of the NOAH leg when NOAH carries the gas, and `quote.tip` is what will be charged as
tip, exact, since NOAH is charged whole. `broadcastAndConfirm` keeps the mempool's verdict and the block's result
apart: a broadcast whose answer never arrives, or arrives and cannot be read, is an unknown outcome that carries the
hash to poll, a node that already holds the transaction counts as an acceptance, and polling rides out an
unavailable endpoint until the deadline. A lookup answered for another hash, or for none, is refused. After an
acceptance every failure carries the hash: the wait's own verdicts, and `InclusionUnknown` around anything else the
wait met, so that `sendTx`, whose caller holds neither the bytes nor the hash, never leaves one unnamed in the mempool. Past a
transaction's timeout height the wait says it expired only once it has stayed unfound for a grace period on a node
that is not catching up, since a node indexes a block's transactions after it reports the block. `classifyResult` names an SDK refusal, an execution failure, or a module error with its log.
`decodeMsgResponses` reads the responses the messages returned from the result's data. Nothing summarises a tax, a
tip, a price age, or a pending transaction away.

A transaction a node returns, and each event it emitted, decode to typed messages and to the chain's own JSON:

```ts
import { decodeEvents, decodeTx } from "@ararat-network/sdk";

const { messages, json } = decodeTx(txBytes);
const events = decodeEvents(response.events);
```

Three things to know when reading messages. A `cosmos.Dec` field holds the chain's wire form, the 18-decimal scaled
integer; `LegacyDec.fromWire` reads it and the JSON view shows the decimal. A coin's amount, like any `cosmos.Int`,
holds the text its sender wrote, and the chain takes the base from that text: `"0100"` is 64 to it, octal, not 100.
`intFromWire` reads it as the chain does, and so do `sumCoins`, the formatters, and the JSON view; `BigInt` does
not. For the same reason `coin` and the builder refuse amount text the chain would not write, a leading zero
included, where they could have signed one number for the chain to execute another. And a message type the registry does
not know decodes as unknown, never under a label it did not earn: with its type URL and bytes from a transaction's
bytes, and from a gateway answer, which has no bytes for it, with its type URL and the JSON the node rendered, which
`unknownAnyJson` returns. An enum value named by a name the SDK's types lack is read the same way from a gateway
answer: the field holds its zero value and `unknownEnumNames` returns the name it arrived as, so one new status does
not fail a list. A known message that carries one, an authz exec around it or an account whose key type is
missing, is kept the same way, whole. Such a message holds no bytes, so the builder refuses to put it in a
transaction, alone or inside a message built around it.

## The core entry

The main entry resolves every `Any` against a registry of all the generated types, which is why any message decodes
and why importing a decoder or a client bundles every generated file. `@ararat-network/sdk/core` exports the same
names without that registry: whatever reads an `Any` takes the registry as an argument, so an app that names the
types it uses bundles only those.

```ts
import { createRegistry } from "@bufbuild/protobuf";
import { decodeTx, QueryClient } from "@ararat-network/sdk/core";
import { file_cosmos_bank_v1beta1_tx } from "@ararat-network/sdk/gen/cosmos/bank/v1beta1/tx_pb.js";

const registry = createRegistry(file_cosmos_bank_v1beta1_tx);
const client = new QueryClient(network.endpoints.rest.map((e) => e.address), { registry });
const { messages } = decodeTx(txBytes, { registry });
```

A client's search and account helpers decode with the client's registry, and `prepareAndSign` and `sendTx` encode an
amino document through it. A message of a type the registry lacks decodes as unknown, as it does everywhere. The main
entry's `QueryClient` and `GatewayClient` extend the core's, so anything that takes a core client takes either.
Passing a registry to the main entry changes what is decoded, a newer release's types or fewer, but not the bundle:
use one entry or the other.

## The signer

Nothing in the package holds a private key but `MemorySigner`, which exists for tests and development against a
localnet. `Signer` is what the SDK asks of whatever does: the accounts it can sign for, `signDirect` over the
protobuf sign document and `signAmino` over the amino document for a Ledger. The app's signer package implements it
for device keys and the Ledger; `fromOfflineSigner` wraps a wallet with CosmJS's OfflineSigner shape, such as Keplr or
Leap. The member signup protocol's documents and their ADR-036 signature are not here: they are the
[app's signer's](https://github.com/ararat-network/ark-app/tree/main/signer), since signup is completed in the app
alone. The builder refuses to continue if a signer returns a different document than it was given, and refuses
direct mode for a multisig key; a wallet that lets its user edit the fee or memo in its prompt therefore has to be
asked not to, which for Keplr is `preferNoSetFee` and `preferNoSetMemo` on the offline signer.

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
and in the recorded blocks, and its result decode to what the files pin.

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
and nothing in the package holds or sees a key. The type registry holds every generated type so any message decodes, and the main entry
defaults to it; the [core entry](#the-core-entry) takes a registry as an argument for a consumer that wants a smaller
bundle. The tarball ships `src` beside `dist`, so the source maps resolve in a debugger.
