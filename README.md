# ark-sdk

The TypeScript SDK for [Ark](https://github.com/ararat-network/ark) and the home of the client contracts it
implements. The [tooling direction](https://github.com/ararat-network/ark/blob/main/docs/direction/TOOLING_DIRECTION.md)
says what the SDK is for and where it sits among Ark's repositories.

Today the repository holds one contract and its vectors; the SDK code follows.

| Path | Holds |
| --- | --- |
| [docs/SIGNUP_PROTOCOL.md](docs/SIGNUP_PROTOCOL.md) | The member signup protocol: the proof of possession and the vouch, as ADR-036 signatures. |
| [testdata/signup/vectors.json](testdata/signup/vectors.json) | Its test vectors, which every producer and verifier of the protocol must reproduce. |

The vectors are generated with the chain's own secp256k1 and JSON sorting and checked against Keplr's ADR-36
implementation. The Go verifier lives with the member platform; the TypeScript producer will live here.
