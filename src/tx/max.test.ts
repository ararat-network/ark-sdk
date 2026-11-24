// maxSendable against a node that prices the transfer tax as the chain does:
// x/treasury's taxOn takes rate × amount truncated, under the denomination's
// cap when it has one, and nothing for a denomination with no factor.
import assert from "node:assert/strict";
import { test } from "node:test";

import { create } from "@bufbuild/protobuf";

import { LegacyDec } from "../codec/dec.js";
import { QueryClient } from "../defaults.js";
import { MsgSendSchema } from "../gen/cosmos/bank/v1beta1/tx_pb.js";
import { fakeNode, json, stubFetch } from "../testing/node.js";
import { typed } from "./body.js";
import { arkdPolicy, FeeError } from "./fee.js";
import { maxSendable } from "./max.js";

interface Chain {
  rate: string;
  /** The tax cap per denomination; a denomination missing here is untaxed. */
  caps: Record<string, bigint>;
  /** Gas prices per unit of gas, base units, by denomination. */
  prices: Record<string, string>;
  reference?: string;
}

const ARK: Chain = { rate: "0.005", caps: { aeur: 0n, ausd: 0n }, prices: { aeur: "117000000000", ausd: "137000000000", anoah: "100000000000" } };

/** The chain's tax on one input: the truncated share, capped when the cap is positive. */
function chainTax(chain: Chain, denom: string, amount: bigint): bigint {
  const cap = chain.caps[denom];
  if (cap === undefined) return 0n;
  const due = LegacyDec.fromString(chain.rate).mulInt(amount).truncateInt();
  return cap > 0n && due > cap ? cap : due;
}

function node(chain: Chain) {
  return fakeNode([], {
    "POST /ark/treasury/v1/compute_tax": ({ body }) => {
      // Each message's coins are taxed on their own, and the tax summed per denomination, as taxOn does.
      const { messages } = JSON.parse(body!) as { messages: { amount: { denom: string; amount: string }[] }[] };
      const sent = messages.flatMap((m) => m.amount);
      const tax = new Map<string, bigint>();
      for (const c of sent) tax.set(c.denom, (tax.get(c.denom) ?? 0n) + chainTax(chain, c.denom, BigInt(c.amount)));
      const owed = [...tax].filter(([, amount]) => amount > 0n).sort(([a], [b]) => (a < b ? -1 : 1));
      return json({ tax: owed.map(([denom, amount]) => ({ denom, amount: amount.toString() })), tax_base: sent });
    },
    "GET /ark/treasury/v1/gas_prices": () => {
      const row = (denom: string) => ({ denom, gas_price: LegacyDec.fromString(chain.prices[denom]!).toString(), derived_height: "5" });
      return json({
        gas_prices: Object.keys(chain.prices)
          .filter((d) => d !== chain.reference)
          .map(row),
        reference_gas_price: chain.reference ? row(chain.reference) : null,
      });
    },
  });
}

const send = (denom: string) => (amount: bigint) => [
  typed(MsgSendSchema, create(MsgSendSchema, { fromAddress: "ark1from", toAddress: "ark1to", amount: [{ denom, amount: amount.toString() }] })),
];
const EUR = 10n ** 18n;
const base = (chain: Chain, denom: string, spendable: bigint, feeDenom: string) => ({
  client: node(chain).client,
  denom,
  spendable,
  messages: send(denom),
  feeDenom,
  gasLimit: 200000n,
  headroom: arkdPolicy.headroom,
});

/** The answer is the largest that fits: it and its tax fit beside the reserve, and one base unit more does not. */
function assertLargest(chain: Chain, denom: string, spendable: bigint, got: { amount: bigint; tax: bigint; reserved: bigint }) {
  assert.equal(got.tax, chainTax(chain, denom, got.amount), "the tax reported is the chain's for the amount");
  assert.ok(got.amount + got.tax + got.reserved <= spendable, `${got.amount} + ${got.tax} + ${got.reserved} fits in ${spendable}`);
  const more = got.amount + 1n;
  assert.ok(more + chainTax(chain, denom, more) + got.reserved > spendable, "one base unit more does not fit");
}

test("gas paid in another denomination: the balance is the amount and its tax, and nothing is kept back for gas", async () => {
  const input = base(ARK, "aeur", 1005n * EUR, "ausd");
  const got = await maxSendable(input);
  assert.deepEqual({ amount: got.amount, tax: got.tax, reserved: got.reserved }, { amount: 1000n * EUR, tax: 5n * EUR, reserved: 0n });
  assertLargest(ARK, "aeur", 1005n * EUR, got);
  assert.ok(got.taxQueries <= 5, `settled in ${got.taxQueries} tax queries`);
});

test("gas paid in the denomination sent: the gas leg's ceiling is kept back, and the tax is counted as it is", async () => {
  const input = base(ARK, "aeur", 1005n * EUR, "aeur");
  const got = await maxSendable(input);
  // ceil(117000000000 × 200000 × 1.1): today's gas fee lifted, since its price can rise before inclusion.
  assert.equal(got.reserved, 25_740_000_000_000_000n);
  assertLargest(ARK, "aeur", 1005n * EUR, got);
  assert.ok(got.amount < 1000n * EUR && got.amount > 999n * EUR);
  assert.ok(got.taxQueries <= 6, `settled in ${got.taxQueries} tax queries`);

  // The sheet's reference row is a fee denomination too.
  const xdr: Chain = { ...ARK, caps: { ...ARK.caps, axdr: 0n }, prices: { ...ARK.prices, axdr: "100000000000" }, reference: "axdr" };
  const viaReference = await maxSendable(base(xdr, "axdr", 1005n * EUR, "axdr"));
  assert.equal(viaReference.reserved, 22_000_000_000_000_000n);
  assertLargest(xdr, "axdr", 1005n * EUR, viaReference);

  await assert.rejects(maxSendable(base(ARK, "ajpy", 1005n * EUR, "ajpy")), FeeError, "a fee denomination the sheet does not list");
});

test("a capped tax, an untaxed denomination, and a rate of zero", async () => {
  // Past the cap the tax stops growing: 2 EUR on anything from 400 EUR up.
  const capped: Chain = { ...ARK, caps: { ...ARK.caps, aeur: 2n * EUR } };
  const atCap = await maxSendable(base(capped, "aeur", 1005n * EUR, "ausd"));
  assert.deepEqual([atCap.amount, atCap.tax], [1003n * EUR, 2n * EUR]);
  assertLargest(capped, "aeur", 1005n * EUR, atCap);
  // A balance on the cap's knee, where the share and the cap meet.
  for (const spendable of [401n * EUR, 402n * EUR, 402n * EUR + 1n, 403n * EUR]) {
    assertLargest(capped, "aeur", spendable, await maxSendable(base(capped, "aeur", spendable, "ausd")));
  }

  // NOAH is never taxed: all of it goes, less the gas leg's ceiling and the tip when it pays them.
  const noah = await maxSendable({ ...base(ARK, "anoah", 10n * EUR, "anoah"), tip: 7n });
  assert.deepEqual([noah.amount, noah.tax, noah.reserved], [10n * EUR - 21_000_000_000_000_007n, 0n, 21_000_000_000_000_007n]);
  assert.equal(noah.taxQueries, 1, "one query says the whole of it owes nothing");
  const noahBesideStableGas = await maxSendable({ ...base(ARK, "anoah", 10n * EUR, "ausd"), tip: 7n });
  assert.deepEqual([noahBesideStableGas.amount, noahBesideStableGas.reserved], [10n * EUR - 7n, 7n], "the tip is NOAH drawn whole");

  const free: Chain = { ...ARK, rate: "0" };
  assert.equal((await maxSendable(base(free, "aeur", 1005n * EUR, "ausd"))).amount, 1005n * EUR);
});

test("only the tax in the denomination sent comes out of its balance", async () => {
  // The same transaction also sends 400 USD, which owes 2 USD of tax: that is the USD balance's to cover.
  const withUsd = (amount: bigint) => [...send("aeur")(amount), ...send("ausd")(400n * EUR)];
  const got = await maxSendable({ ...base(ARK, "aeur", 1005n * EUR, "ausd"), messages: withUsd });
  assert.deepEqual([got.amount, got.tax], [1000n * EUR, 5n * EUR]);
});

test("nothing to send: a balance no larger than what is kept back, and one the tax consumes", async () => {
  const { client, calls } = node(ARK);
  const short = await maxSendable({ ...base(ARK, "aeur", 25_740_000_000_000_000n, "aeur"), client });
  assert.deepEqual(short, { amount: 0n, tax: 0n, reserved: 25_740_000_000_000_000n, taxQueries: 0 });
  assert.ok(!calls.some((c) => c.includes("compute_tax")), "no tax is asked for an amount of nothing");
  assert.equal((await maxSendable(base(ARK, "aeur", 0n, "ausd"))).amount, 0n);
  // A rate of the whole amount leaves nothing to send.
  assert.equal((await maxSendable(base({ ...ARK, rate: "1" }, "aeur", 1005n * EUR, "ausd"))).amount, 0n);
  await assert.rejects(maxSendable({ ...base(ARK, "aeur", 1005n * EUR, "ausd"), tip: -1n }), FeeError);
  await assert.rejects(maxSendable(base(ARK, "aeur", -1n, "ausd")), FeeError);
  await assert.rejects(maxSendable(base(ARK, "aeur", 1005n * EUR, "")), (err: unknown) => err instanceof FeeError && /no fee denomination/.test(err.message));
});

test("the answer is the largest for every small balance, and for awkward large ones, in a handful of queries", async () => {
  // Small balances, where truncation decides: checked against every amount below.
  const steep: Chain = { ...ARK, rate: "0.3", caps: { aeur: 0n } };
  for (const chain of [ARK, steep, { ...steep, caps: { aeur: 7n } }]) {
    for (let spendable = 1n; spendable <= 120n; spendable++) {
      const got = await maxSendable(base(chain, "aeur", spendable, "ausd"));
      let largest = 0n;
      for (let amount = 1n; amount <= spendable; amount++) if (amount + chainTax(chain, "aeur", amount) <= spendable) largest = amount;
      assert.equal(got.amount, largest, `spendable ${spendable} at rate ${chain.rate}, cap ${chain.caps.aeur}`);
    }
  }
  // Large ones, where the search has far to go if it is not led straight there.
  let most = 0;
  for (const spendable of [1005n * EUR + 1n, 123_456_789_012_345_678_901n, 10n ** 30n + 7n, 999_999_999_999_999_999n, 2n ** 200n]) {
    for (const feeDenom of ["ausd", "aeur"]) {
      const got = await maxSendable(base(ARK, "aeur", spendable, feeDenom));
      assertLargest(ARK, "aeur", spendable, got);
      most = Math.max(most, got.taxQueries);
    }
  }
  assert.ok(most <= 6, `the most tax queries any of them took: ${most}`);
});

test("a tax that falls as the amount rises is refused, not searched", async () => {
  // Not the chain's: its tax is a truncated share under a cap. A node answering otherwise would mislead the search.
  const { fetch } = stubFetch(({ body }) => {
    const sent = (JSON.parse(body!) as { messages: { amount: { denom: string; amount: string }[] }[] }).messages[0]!.amount[0]!;
    const tax = BigInt(sent.amount) >= 1000n ? 10n : 500n;
    return json({ tax: [{ denom: sent.denom, amount: tax.toString() }], tax_base: [sent] });
  });
  const client = new QueryClient("http://node", { fetch });
  await assert.rejects(
    maxSendable({ ...base(ARK, "aeur", 1000n, "ausd"), client }),
    (err: unknown) => err instanceof FeeError && /does not fall as the amount rises/.test(err.message),
  );
});
