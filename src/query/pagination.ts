// Walking a paginated query: the gateway returns a page and the key of the
// next; the walker asks again until the key is empty, within a page budget.
import type { MessageInitShape } from "@bufbuild/protobuf";

import type { PageRequestSchema, PageResponse } from "../gen/cosmos/base/query/v1beta1/pagination_pb.js";

export type PageRequestInit = MessageInitShape<typeof PageRequestSchema>;

export interface PaginateOptions {
  /** Items per page; 100 by default. */
  limit?: bigint;
  /** Pages to fetch at most; 100 by default, so a runaway listing stops. */
  maxPages?: number;
}

export class PaginationError extends Error {
  override readonly name: string = "PaginationError";
}

/** Yields every item of a paginated query, page by page. */
export async function* paginate<R extends { pagination?: PageResponse | undefined }, T>(
  fetchPage: (pagination: PageRequestInit) => Promise<R>,
  items: (page: R) => readonly T[],
  options: PaginateOptions = {},
): AsyncGenerator<T, void, undefined> {
  const limit = options.limit ?? 100n;
  const maxPages = options.maxPages ?? 100;
  let key: Uint8Array | undefined;
  for (let page = 0; ; page++) {
    if (page >= maxPages) throw new PaginationError(`more than ${maxPages} pages`);
    const response = await fetchPage(key === undefined ? { limit } : { limit, key });
    yield* items(response);
    const next = response.pagination?.nextKey;
    if (next === undefined || next.length === 0) return;
    key = next;
  }
}

/** Every item of a paginated query as one array. */
export async function collectAll<R extends { pagination?: PageResponse | undefined }, T>(
  fetchPage: (pagination: PageRequestInit) => Promise<R>,
  items: (page: R) => readonly T[],
  options: PaginateOptions = {},
): Promise<T[]> {
  const out: T[] = [];
  for await (const item of paginate(fetchPage, items, options)) out.push(item);
  return out;
}
