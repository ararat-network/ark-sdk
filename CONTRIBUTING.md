# Contributing

## Set up

Node 22 or later and pnpm through corepack:

```sh
corepack enable
pnpm install
```

## Commands

| Command | Does |
| --- | --- |
| `pnpm check` | Type check. |
| `pnpm lint`, `pnpm lint:fix`, `pnpm format` | Biome: lint and format check, apply both, or format alone. |
| `pnpm test`, `pnpm test:coverage` | The unit tests, or the same with coverage thresholds. |
| `ARK_LOCALNET_REST=http://localhost:1317 pnpm test:smoke` | The smoke test against ark's Docker localnet (`make localnet-start` in ark). |
| `pnpm build`, `pnpm check:package`, `pnpm check:browser` | Build `dist/`, prove the tarball installs and its types resolve, bundle for a browser. |
| `pnpm gen`, `pnpm gen:check` | Regenerate `src/gen` from the pinned protos, from empty; check it matches, added and removed files included. |
| `pnpm fixtures:sync`, `pnpm fixtures:check` | Copy the decoding fixtures from ark at `ARK_VERSION`; check the copy matches, added and removed files included. |

[ci.yml](.github/workflows/ci.yml) runs the generated and fixture checks, lint, the type check, the unit tests with
coverage, and the package and browser checks on every pull request; the release workflow runs them all again from
the tag, which must sit on `main`. The localnet smoke test runs in its own workflow on pull requests that touch the
SDK and weekly.

## Rules

- **The fixtures are the contract.** `testdata/decoding` holds ark's decoding fixtures at the tag in `ARK_VERSION`, and
  the tests reproduce them byte for byte. A change that breaks one is a change to the chain's encoding or a bug here;
  find out which before touching the test. Never edit a fixture by hand.
- **Chain policy stays on the chain.** The SDK asks Treasury for the tax and the gas price sheet and never recomputes
  them; headroom, gas adjustment, and fee denomination are the caller's. See the
  [fee contract](https://github.com/ararat-network/ark/blob/main/docs/clients/CLIENT_FEES.md).
- **Nothing holds a key.** Signing goes through the `Signer` interface; `MemorySigner` is for tests and development.
- **Decs stay in wire form** in generated messages; `LegacyDec` reads and writes them.
- **Moving the pin.** A new chain release changes `ARK_VERSION` and the `tag` in `buf.gen.yaml` together, then
  `pnpm gen`, `pnpm fixtures:sync`, `pnpm check`, `pnpm test`. The weekly pin check says when a release was missed.
- **Style.** British spelling in identifiers (`materialise`, `serialise`); comments say what a reader cannot see in the
  code and no more; tests are table-driven and name the case they check.
- **Commits** have a subject and a body saying what changed and why, one logical area each.
