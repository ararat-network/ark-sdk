#!/bin/sh
# Proves the built package publishes and resolves: publint on the manifest,
# arethetypeswrong on the tarball's types under each resolution mode, then an
# install of the tarball into an empty project that imports the root and a
# generated module and runs the codec. Run after pnpm build.
set -eu

cd "$(dirname "$0")/.."
test -f dist/index.js || { echo "run pnpm build first" >&2; exit 1; }

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

# pnpm is on PATH after corepack enable; where it is not, publint still spawns
# it by name, so a shim that defers to corepack goes first on the PATH.
if ! command -v pnpm >/dev/null 2>&1; then
  mkdir -p "$work/bin"
  printf '#!/bin/sh\nexec corepack pnpm "$@"\n' > "$work/bin/pnpm"
  chmod +x "$work/bin/pnpm"
  PATH="$work/bin:$PATH"
fi

pnpm exec publint --strict
pnpm pack --pack-destination "$work" >/dev/null
tarball=$(ls "$work"/*.tgz)
pnpm exec attw "$tarball" --profile esm-only

mkdir "$work/consumer"
cd "$work/consumer"
printf '{"name":"consumer","private":true,"type":"module"}\n' > package.json
npm install --silent --no-audit --no-fund "$tarball"
cat > check.mjs <<'JS'
import { LegacyDec, decodeTx } from "@ararat-network/sdk";
import { MsgSendSchema } from "@ararat-network/sdk/gen/cosmos/bank/v1beta1/tx_pb.js";
if (LegacyDec.fromString("1.5").toWire() !== "1500000000000000000") throw new Error("LegacyDec");
if (MsgSendSchema.typeName !== "cosmos.bank.v1beta1.MsgSend") throw new Error("generated module");
if (typeof decodeTx !== "function") throw new Error("decodeTx");
console.log("package imports and runs");
JS
node check.mjs
