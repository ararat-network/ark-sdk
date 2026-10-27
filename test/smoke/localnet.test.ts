// Against ark's Docker localnet (make localnet-start in ark): reads the open
// member tranche, then simulates, prices, signs, broadcasts, and confirms a
// bank send from node0's development key, reads the result back through the
// decoder, and finds it again by search. A second send goes through sendTx.
// Runs only with ARK_LOCALNET_REST set, so CI without Docker skips it:
// ARK_LOCALNET_REST=http://localhost:1317 pnpm test:smoke
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { create } from "@bufbuild/protobuf";
import { MsgSendSchema } from "../../src/gen/cosmos/bank/v1beta1/tx_pb.js";
import {
  type ArkJson,
  type AssetListJson,
  adjustGas,
  arkdPolicy,
  broadcastAndConfirm,
  type ChainJson,
  classifyResult,
  coin,
  decodeEvents,
  decodeTx,
  feeFromQuote,
  fetchTx,
  formatCoin,
  MemorySigner,
  Network,
  packMessages,
  QueryClient,
  quoteFee,
  searchTxs,
  sendTx,
  signTx,
  simulationTxBytes,
  txQuery,
  typed,
  vestedCoins,
} from "../../src/index.js";

const rest = process.env.ARK_LOCALNET_REST;
const data = process.env.ARK_LOCALNET_DATA ?? new URL("../../../ark/.testnets", import.meta.url).pathname;

const read = <T>(file: string): T => JSON.parse(readFileSync(new URL(`../../testdata/registry/arklocal/${file}`, import.meta.url), "utf8")) as T;

test("localnet: tranche, simulate, price, sign, broadcast, confirm, decode", { skip: rest ? false : "ARK_LOCALNET_REST is not set" }, async () => {
  const network = Network.fromRegistry({ chain: read<ChainJson>("chain.json"), assets: read<AssetListJson>("assetlist.json"), ark: read<ArkJson>("ark.json") });
  const client = new QueryClient(rest!);
  await client.verifyNetwork(network);

  const seed = JSON.parse(readFileSync(`${data}/node0/arkd/key_seed.json`, "utf8")) as { secret: string };
  const signer = MemorySigner.fromMnemonic(seed.secret);
  const [account] = await signer.accounts();
  assert.ok(account);

  const balance = await client.disbursement.balance();
  assert.match(balance.memberTranche, /^\d+$/, "the member tranche is an integer amount");
  const noah = network.asset("anoah")!;
  console.log(`member tranche open: ${formatCoin({ denom: noah.base, amount: balance.memberTranche }, network, { locale: "en-GB" })}`);

  const info = await client.auth.accountInfo(signer.address);
  assert.ok(info.info, `${signer.address} has an account`);
  const recipient = MemorySigner.random().address;
  const amount = coin("anoah", 10n ** 18n);
  const send = typed(MsgSendSchema, create(MsgSendSchema, { fromAddress: signer.address, toAddress: recipient, amount: [amount] }));

  const simulation = await client.tx.simulate(simulationTxBytes({ messages: [send], publicKey: account.publicKey, sequence: info.info.sequence }));
  assert.ok(simulation.gasInfo && simulation.gasInfo.gasUsed > 0n, "simulation metered gas");
  const gasLimit = adjustGas(simulation.gasInfo.gasUsed, arkdPolicy.gasAdjustment);

  const tax = await client.treasury.computeTax(packMessages([send]));
  assert.deepEqual(tax.tax, [], "NOAH is never taxed");
  const sheet = await client.treasury.gasPrices();
  const noahPrice = sheet.gasPrices.find((p) => p.denom === "anoah");
  assert.ok(noahPrice, "the sheet prices NOAH");
  const quote = quoteFee({ tax: tax.tax, gasPrice: noahPrice, gasLimit, headroom: arkdPolicy.headroom });
  console.log(`gas ${gasLimit}, declared ${quote.declared.map((c) => c.amount + c.denom).join(",")}, tip at most ${quote.maxTip?.amount ?? "0"}anoah`);

  const signed = await signTx({
    signer,
    address: signer.address,
    chainId: network.chainId,
    accountNumber: info.info.accountNumber,
    sequence: info.info.sequence,
    messages: [send],
    memo: "ark-sdk smoke test",
    fee: feeFromQuote(quote),
  });
  const { broadcast, response } = await broadcastAndConfirm(client, signed.txBytes, { timeoutMs: 90_000, pollMs: 1_000 });
  assert.equal(broadcast.hash, signed.hash);
  assert.equal(response.txhash, signed.hash);
  assert.deepEqual(classifyResult(response), { kind: "ok" }, response.rawLog);
  assert.ok(response.height > 0n);
  console.log(`included at height ${response.height}, gas used ${response.gasUsed} of ${response.gasWanted}`);

  const events = decodeEvents(response.events);
  const transfer = events.find((e) => e.type === "transfer" && e.attributes.some((a) => a.key === "recipient" && a.value === recipient));
  assert.ok(transfer, "the send's transfer event names the recipient");
  const after = await client.bank.balance(recipient, "anoah");
  assert.equal(after.balance?.amount, amount.amount);

  const fetched = await client.tx.getTx(signed.hash);
  assert.ok(fetched.tx?.body?.messages[0]);
  const decoded = decodeTx(signed.txBytes);
  assert.equal(decoded.messages[0]?.typeUrl, "/cosmos.bank.v1beta1.MsgSend");
  assert.equal(decoded.memo, "ark-sdk smoke test");

  const found = await fetchTx(client, signed.hash);
  assert.ok(found);
  assert.deepEqual(found.outcome, { kind: "ok" });
  assert.deepEqual(
    found.responses.map((r) => r.typeUrl),
    ["/cosmos.bank.v1beta1.MsgSendResponse"],
  );
  const byRecipient = await searchTxs(client, txQuery.byRecipient(recipient));
  assert.ok(
    byRecipient.items.some((t) => t.hash === signed.hash),
    "search finds the send by recipient",
  );

  // A localnet validator holds a seat: a continuous vesting account from the testnet artefact.
  const decodedAccount = await client.auth.decodedAccount(signer.address);
  assert.equal(decodedAccount.kind, "continuous_vesting");
  assert.ok(decodedAccount.sequence > info.info.sequence);
  const now = BigInt(Math.floor(Date.now() / 1000));
  console.log(
    `seat: ${formatCoin(decodedAccount.vesting!.originalVesting[0]!, network, { locale: "en-GB" })} vesting, ${vestedCoins(decodedAccount, now).length === 0 ? "none vested yet" : "some vested"}`,
  );

  const again = await sendTx(
    {
      client,
      signer,
      address: signer.address,
      chainId: network.chainId,
      messages: [send],
      memo: "ark-sdk smoke test 2",
      feeDenom: "anoah",
      headroom: arkdPolicy.headroom,
      gasAdjustment: arkdPolicy.gasAdjustment,
    },
    { timeoutMs: 90_000, pollMs: 1_000 },
  );
  assert.deepEqual(classifyResult(again.response), { kind: "ok" }, again.response.rawLog);
  assert.equal(again.sequence, decodedAccount.sequence);
  console.log(`sendTx included at height ${again.response.height}, declared ${again.quote.declared.map((c) => c.amount + c.denom).join(",")}`);
  const balanceAfter = await client.bank.balance(recipient, "anoah");
  assert.equal(balanceAfter.balance?.amount, (2n * 10n ** 18n).toString());
});
