# Security policy

## Development status

The SDK is under active development and has no published releases. Report vulnerabilities
against the current `main` branch and include the exact commit you tested. A supported
release policy will be defined when releases are published.

## Report a vulnerability privately

Use **Report a vulnerability** on the repository's
[Security advisories page](https://github.com/ararat-network/ark-sdk/security/advisories), or email
[chitpole@proton.me](mailto:chitpole@proton.me).

Do not put exploit details in public issues, pull requests or discussions. Ordinary
bugs without a security impact can use the public issue tracker.

Include:

- The affected module, commit or version, and the runtime it ran on.
- The expected behaviour, observed behaviour and potential impact.
- Reproduction steps or a minimal proof of concept, preferably against a disposable localnet.
- Relevant logs with credentials, personal data and signing material removed.

Never send private keys, seed phrases or live wallet credentials. Test only on systems
you own or have permission to test.

## What the SDK trusts

The SDK holds no key: signing goes through the `Signer` interface, and `MemorySigner`
exists for tests and development. What it does trust, and checks as far as it can:

- **The network registry**, read from `ark-registry` at a git ref, `main` by default. Every
  member the SDK reads is checked by name, the prefix and coin type are held to the SDK's
  own, and an endpoint is accepted over https, or http on the loopback. A pinned ref makes
  what is read immutable; the endpoints themselves are the registry's to keep.
- **The node**, over its gRPC gateway. Its answers are JSON parsed through the generated
  types with every `Any` resolved against the type registry; a type the registry does not
  know decodes as unknown, never under another label. `verifyNetwork` refuses a node on
  another chain and reports its binary against the versions the registry lists; it cannot
  tell a hostile node from a truthful one, and nothing in the SDK verifies consensus.
- **The chain's fixtures**, copied from `ark` at the tag in `ARK_VERSION` and reproduced byte
  for byte by the tests: the contract the codec, builder, and decoder are held to.
- **A wallet** behind `fromOfflineSigner`: the builder refuses a sign document the wallet
  altered, and the signup proof checks the wallet's key against the address it signed for.

The chain's own trust boundaries are in
[ark's threat model](https://github.com/ararat-network/ark/blob/main/docs/security/THREAT_MODEL.md).

## Scope and handling

Reports may concern the codec and sign bytes, transaction construction and fee pricing,
the signup protocol's proof, the query client, the registry loader, or the repository's
build and release tooling. Include any relevant upstream dependency and version when
the issue involves third-party code.

Maintainers will assess the report and coordinate fixes and disclosure through the
private channel. Keep follow-up details there while a vulnerability remains unresolved.
