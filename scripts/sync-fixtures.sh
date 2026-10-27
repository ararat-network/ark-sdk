#!/bin/sh
# Copies ark's decoding fixtures into testdata/decoding at the tag in
# ARK_VERSION, the same pin the generated types come from. A sparse clone
# fetches the one directory; nothing else of ark is needed.
set -eu

cd "$(dirname "$0")/.."
tag=$(cat ARK_VERSION)
repo=${ARK_REPO:-https://github.com/ararat-network/ark.git}
subdir=tests/fixtures/testdata/decoding

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

git -c advice.detachedHead=false clone --quiet --depth 1 --branch "$tag" --filter=blob:none --sparse "$repo" "$work/ark"
git -C "$work/ark" sparse-checkout set --no-cone "$subdir" >/dev/null

rm -rf testdata/decoding
mkdir -p testdata/decoding
cp "$work/ark/$subdir"/*.json testdata/decoding/
echo "testdata/decoding: $(ls testdata/decoding | wc -l | tr -d ' ') files from ark $tag"
