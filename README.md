# ark-sdk

The TypeScript SDK for [Ark](https://github.com/ararat-network/ark) and the home of the client contracts it
implements. The [tooling direction](https://github.com/ararat-network/ark/blob/main/docs/direction/TOOLING_DIRECTION.md)
says what the SDK is for and where it sits among Ark's repositories.

Today the repository holds the generated types, one contract and its vectors; the rest of the SDK follows.

| Path | Holds |
| --- | --- |
| [src/gen/](src/gen/) | Every Ark message, query, and event, and the Cosmos types they use, generated from `ark`'s protos at the tag in [ARK_VERSION](ARK_VERSION). |
| [docs/SIGNUP_PROTOCOL.md](docs/SIGNUP_PROTOCOL.md) | The member signup protocol: the proof of possession and the vouch, as ADR-036 signatures. |
| [testdata/signup/vectors.json](testdata/signup/vectors.json) | Its test vectors, which every producer and verifier of the protocol must reproduce. |

The vectors are generated with the chain's own secp256k1 and JSON sorting and checked against Keplr's ADR-36
implementation. The Go verifier lives with the member platform; the TypeScript producer will live here.

## Generated code

[buf.gen.yaml](buf.gen.yaml) generates `src/gen` with `protoc-gen-es` straight from `ark`'s git repository at the
tag named in `ARK_VERSION`, which the file's `tag` must match; the Cosmos dependencies resolve from the public Buf
registry, so no account is needed. The output is committed: a consumer reads source without running `buf`, and
[ci.yml](.github/workflows/ci.yml) regenerates on every pull request and fails if the committed files or the pin
differ. To move to a new chain release, change both the tag and `ARK_VERSION`, then:

```sh
pnpm install
pnpm gen
pnpm check
```

A weekly [pin check](.github/workflows/pin-check.yml) generates at `ark`'s newest chain tag instead and fails if
that would change the files, so a release whose bump was forgotten shows within a week; it holds no token and opens
nothing. The pin is also where the decoding fixtures and the network registry are read from, so the three move
together.

## Stack

The SDK builds on generated code and small, audited primitives rather than on CosmJS: `protoc-gen-es` for the types,
and the noble and scure libraries for secp256k1, hashing, BIP-39, BIP-32, and Bech32 when the transaction builder
arrives. The chain is SDK v0.54, whose types CosmJS lags, Ark's own messages are not in any shared library, and Ledger
signing needs amino names only Ark's protos carry; the fixtures prove the encoding byte for byte instead. pnpm is the
package manager, TypeScript the only language, and nothing in the package holds or sees a key: signing is requested
through an interface that `ark-signer` implements.
