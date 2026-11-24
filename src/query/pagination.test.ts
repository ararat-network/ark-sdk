import assert from "node:assert/strict";
import { test } from "node:test";

import { create } from "@bufbuild/protobuf";

import { type PageResponse, PageResponseSchema } from "../gen/cosmos/base/query/v1beta1/pagination_pb.js";
import { collectAll, type PageRequestInit, PaginationError, paginate } from "./pagination.js";

interface Page {
  items: number[];
  pagination?: PageResponse;
}

function pages(total: number, perPage: number): (p: PageRequestInit) => Promise<Page> {
  return async (p) => {
    const start = p.key && p.key.length > 0 ? Number(new TextDecoder().decode(p.key)) : 0;
    const limit = Number(p.limit ?? 100n);
    assert.equal(limit, perPage);
    const items = Array.from({ length: Math.min(perPage, total - start) }, (_, i) => start + i);
    const next = start + perPage < total ? new TextEncoder().encode(String(start + perPage)) : new Uint8Array();
    return { items, pagination: create(PageResponseSchema, { nextKey: next, total: BigInt(total) }) };
  };
}

test("paginate follows next keys until the last page", async () => {
  const all = await collectAll(pages(7, 3), (p) => p.items, { limit: 3n });
  assert.deepEqual(all, [0, 1, 2, 3, 4, 5, 6]);
  const first: number[] = [];
  for await (const item of paginate(pages(7, 3), (p) => p.items, { limit: 3n })) {
    first.push(item);
    if (first.length === 4) break;
  }
  assert.deepEqual(first, [0, 1, 2, 3]);
  assert.deepEqual(
    await collectAll(
      async (): Promise<Page> => ({ items: [1] }),
      (p) => p.items,
      { limit: 100n },
    ),
    [1],
    "a page without pagination ends the walk",
  );
});

test("paginate stops at the page budget", async () => {
  await assert.rejects(
    collectAll(pages(10, 2), (p) => p.items, { limit: 2n, maxPages: 3 }),
    (err: unknown) => err instanceof PaginationError && err.partial.length === 6,
  );
});

/** A route that pages by offset, as the chain's GetBlockWithTxs does: a slice by offset and limit, the total, and never a next key. */
function offsetPages(total: number): { fetch: (p: PageRequestInit) => Promise<Page>; asked: PageRequestInit[] } {
  const asked: PageRequestInit[] = [];
  return {
    asked,
    fetch: async (p) => {
      asked.push(p);
      const start = Number(p.offset ?? 0n);
      const size = Number(p.limit ?? 100n);
      const items = Array.from({ length: Math.max(0, Math.min(size, total - start)) }, (_, i) => start + i);
      return { items, pagination: create(PageResponseSchema, { total: BigInt(total) }) };
    },
  };
}

test("a route that pages by offset is walked to its end by the total it reports", async () => {
  // 250 transactions in a block, 100 to a page: the first page is not the block.
  const block = offsetPages(250);
  const all = await collectAll(block.fetch, (r) => r.items);
  assert.equal(all.length, 250);
  assert.deepEqual([all[0], all[100], all[249]], [0, 100, 249]);
  assert.deepEqual(
    block.asked.map((p) => [p.limit, p.offset, p.key]),
    [
      [100n, undefined, undefined],
      [100n, 100n, undefined],
      [100n, 200n, undefined],
    ],
  );

  // One page that is all of it asks once.
  const small = offsetPages(40);
  assert.equal((await collectAll(small.fetch, (r) => r.items)).length, 40);
  assert.equal(small.asked.length, 1);
  // An exact multiple of the page ends without an empty request.
  const exact = offsetPages(200);
  assert.equal((await collectAll(exact.fetch, (r) => r.items)).length, 200);
  assert.equal(exact.asked.length, 2);

  // A total the pages never reach ends at the first page that brings nothing, and the budget still bounds a walk.
  const lying = offsetPages(30);
  const overstated = async (p: PageRequestInit) => ({ ...(await lying.fetch(p)), pagination: create(PageResponseSchema, { total: 10_000n }) });
  assert.equal((await collectAll(overstated, (r) => r.items)).length, 30);
  await assert.rejects(
    collectAll(offsetPages(250).fetch, (r) => r.items, { maxPages: 2 }),
    (err: unknown) => err instanceof PaginationError && err.partial.length === 200,
  );
});
