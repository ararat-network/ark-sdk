import assert from "node:assert/strict";
import { test } from "node:test";

import { create } from "@bufbuild/protobuf";

import { PageResponseSchema, type PageResponse } from "../gen/cosmos/base/query/v1beta1/pagination_pb.js";
import { PaginationError, collectAll, paginate, type PageRequestInit } from "./pagination.js";

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
  assert.deepEqual(await collectAll(async (): Promise<Page> => ({ items: [1] }), (p) => p.items, { limit: 100n }), [1], "a page without pagination ends the walk");
});

test("paginate stops at the page budget", async () => {
  await assert.rejects(collectAll(pages(10, 2), (p) => p.items, { limit: 2n, maxPages: 3 }), PaginationError);
});
