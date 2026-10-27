import assert from "node:assert/strict";
import { test } from "node:test";

import { create } from "@bufbuild/protobuf";
import { AnySchema } from "@bufbuild/protobuf/wkt";

import { packAny } from "../codec/any.js";
import { BaseAccountSchema, ModuleAccountSchema } from "../gen/cosmos/auth/v1beta1/auth_pb.js";
import { ContinuousVestingAccountSchema, DelayedVestingAccountSchema, PeriodicVestingAccountSchema, PermanentLockedAccountSchema } from "../gen/cosmos/vesting/v1beta1/vesting_pb.js";
import { QueryClient } from "../query/client.js";
import { coin } from "../tx/body.js";
import { decodeAccount, vestedCoins, vestingCoins } from "./account.js";

const address = "ark1fec7dnxl3fre9zmc3kyvtt357de3ek9fnlu96j";
const NOAH = 10n ** 18n;
const YEAR = 31_536_000n;
const genesis = 1_800_000_000n;
const base = { address, accountNumber: 5n, sequence: 1n };
const amounts = (coins: { denom: string; amount: string }[]) => coins.map((c) => c.amount + c.denom);

test("a seat is a continuous vesting account that vests linearly between its cliff and its end", () => {
  const seat = create(ContinuousVestingAccountSchema, {
    baseVestingAccount: { baseAccount: base, originalVesting: [coin("anoah", 5_000_000n * NOAH)], endTime: genesis + 8n * YEAR },
    startTime: genesis + 4n * YEAR,
  });
  const a = decodeAccount(packAny(ContinuousVestingAccountSchema, seat));
  assert.equal(a.kind, "continuous_vesting");
  assert.equal(a.address, address);
  assert.equal(a.accountNumber, 5n);
  assert.equal(a.vesting?.startTime, genesis + 4n * YEAR);
  assert.deepEqual(amounts(vestedCoins(a, genesis)), []);
  assert.deepEqual(amounts(vestedCoins(a, genesis + 4n * YEAR)), [], "nothing at the cliff instant");
  assert.deepEqual(amounts(vestedCoins(a, genesis + 6n * YEAR)), [`${2_500_000n * NOAH}anoah`]);
  assert.deepEqual(amounts(vestingCoins(a, genesis + 6n * YEAR)), [`${2_500_000n * NOAH}anoah`]);
  assert.deepEqual(amounts(vestedCoins(a, genesis + 9n * YEAR)), [`${5_000_000n * NOAH}anoah`]);
  assert.deepEqual(amounts(vestingCoins(a, genesis + 9n * YEAR)), []);
});

test("continuous vesting rounds as the SDK's Dec does", () => {
  const odd = create(ContinuousVestingAccountSchema, {
    baseVestingAccount: { baseAccount: base, originalVesting: [coin("anoah", 7n)], endTime: 300n },
    startTime: 0n,
  });
  const a = decodeAccount(packAny(ContinuousVestingAccountSchema, odd));
  // 7 × (100/300) = 7 × 0.333333333333333333 = 2.333…, rounded to 2; 7 × (200/300) = 4.666…67, rounded to 5.
  assert.deepEqual(amounts(vestedCoins(a, 100n)), ["2anoah"]);
  assert.deepEqual(amounts(vestedCoins(a, 200n)), ["5anoah"]);
});

test("delayed, periodic, and permanently locked accounts follow their schedules", () => {
  const delayed = decodeAccount(packAny(DelayedVestingAccountSchema, create(DelayedVestingAccountSchema, { baseVestingAccount: { baseAccount: base, originalVesting: [coin("anoah", 10n)], endTime: 1000n } })));
  assert.equal(delayed.kind, "delayed_vesting");
  assert.equal(delayed.vesting?.startTime, undefined);
  assert.deepEqual(amounts(vestedCoins(delayed, 999n)), []);
  assert.deepEqual(amounts(vestedCoins(delayed, 1000n)), ["10anoah"]);

  const periodic = decodeAccount(
    packAny(
      PeriodicVestingAccountSchema,
      create(PeriodicVestingAccountSchema, {
        baseVestingAccount: { baseAccount: base, originalVesting: [coin("anoah", 10n), coin("ausd", 4n)], endTime: 1_000n + 2n * 2_592_000n },
        startTime: 1_000n,
        vestingPeriods: [
          { length: 2_592_000n, amount: [coin("anoah", 5n), coin("ausd", 4n)] },
          { length: 2_592_000n, amount: [coin("anoah", 5n)] },
        ],
      }),
    ),
  );
  assert.equal(periodic.kind, "periodic_vesting");
  assert.equal(periodic.vesting?.periods?.length, 2);
  assert.deepEqual(amounts(vestedCoins(periodic, 1_000n + 2_591_999n)), []);
  assert.deepEqual(amounts(vestedCoins(periodic, 1_000n + 2_592_000n)), ["5anoah", "4ausd"]);
  assert.deepEqual(amounts(vestingCoins(periodic, 1_000n + 2_592_000n)), ["5anoah"]);
  assert.deepEqual(amounts(vestedCoins(periodic, 1_000n + 2n * 2_592_000n)), ["10anoah", "4ausd"]);

  const locked = decodeAccount(packAny(PermanentLockedAccountSchema, create(PermanentLockedAccountSchema, { baseVestingAccount: { baseAccount: base, originalVesting: [coin("anoah", 10n)] } })));
  assert.equal(locked.kind, "permanent_locked");
  assert.deepEqual(amounts(vestedCoins(locked, 10n ** 12n)), []);
  assert.deepEqual(amounts(vestingCoins(locked, 10n ** 12n)), ["10anoah"]);
});

test("base, module, and unknown accounts", () => {
  const plain = decodeAccount(packAny(BaseAccountSchema, create(BaseAccountSchema, base)));
  assert.equal(plain.kind, "base");
  assert.equal(plain.sequence, 1n);
  assert.equal(plain.vesting, undefined);
  const mod = decodeAccount(packAny(ModuleAccountSchema, create(ModuleAccountSchema, { baseAccount: { address: "ark1d0sh6wpev05edp6tdxjs6alazqd7suyqzxee35", accountNumber: 9n }, name: "treasury", permissions: ["burner", "minter"] })));
  assert.equal(mod.kind, "module");
  assert.deepEqual(mod.module, { name: "treasury", permissions: ["burner", "minter"] });
  assert.equal(mod.accountNumber, 9n);
  const unknown = decodeAccount(create(AnySchema, { typeUrl: "/ark.future.v1.OddAccount", value: new Uint8Array([8, 1]) }));
  assert.equal(unknown.kind, "unknown");
  assert.equal(unknown.typeUrl, "/ark.future.v1.OddAccount");
  assert.deepEqual(vestedCoins(unknown, 0n), []);
});

test("decodedAccount reads the gateway's JSON for a vesting account", async () => {
  const body = {
    account: {
      "@type": "/cosmos.vesting.v1beta1.ContinuousVestingAccount",
      base_vesting_account: {
        base_account: { address, pub_key: null, account_number: "5", sequence: "1" },
        original_vesting: [{ denom: "anoah", amount: "5000000000000000000000000" }],
        delegated_free: [],
        delegated_vesting: [],
        end_time: String(genesis + 8n * YEAR),
      },
      start_time: String(genesis + 4n * YEAR),
    },
  };
  const client = new QueryClient("http://node", { fetch: (async () => new Response(JSON.stringify(body))) as typeof fetch });
  const a = await client.auth.decodedAccount(address);
  assert.equal(a.kind, "continuous_vesting");
  assert.deepEqual(amounts(vestedCoins(a, genesis + 6n * YEAR)), [`${2_500_000n * NOAH}anoah`]);
});
