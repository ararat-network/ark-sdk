import assert from "node:assert/strict";
import { test } from "node:test";

import { CoinError, coin, sumCoins } from "./coins.js";

test("sumCoins merges per denomination in denomination order and drops zero legs", () => {
  const out = sumCoins([coin("ausd", "5"), coin("anoah", "0")], [coin("ausd", "1"), coin("aeur", "2")]);
  assert.deepEqual(
    out.map((c) => c.amount + c.denom),
    ["2aeur", "6ausd"],
  );
  assert.throws(() => sumCoins([coin("ausd", "-1")]), CoinError);
});
