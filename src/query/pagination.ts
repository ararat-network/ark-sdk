// Walking a paginated query, within a page budget. Most routes return a page
// and the key of the next, and the walker asks again until the key is empty.
// A few page by offset: they give no key and say how many there are in all,
// and the walker asks for the rest by how many it has read.
import type { MessageInitShape } from "@bufbuild/protobuf";
import { ArkSdkError } from "../errors.js";
import type { PageRequestSchema, PageResponse } from "../gen/cosmos/base/query/v1beta1/pagination_pb.js";

export type PageRequestInit = MessageInitShape<typeof PageRequestSchema>;

export interface PaginateOptions {
  /** Items per page; 100 by default. */
  limit?: bigint;
  /** Pages to fetch at most; 100 by default, so a runaway listing stops. */
  maxPages?: number;
}

export class PaginationError extends ArkSdkError {
  override readonly name: string = "PaginationError";
  constructor(
    message: string,
    /** What collectAll had gathered when the budget ran out, so nothing read is lost. */
    readonly partial: readonly unknown[] = [],
  ) {
    super(message);
  }
}

/** Yields every item of a paginated query, page by page, whether the route pages by key or by offset. */
export async function* paginate<R extends { pagination?: PageResponse | undefined }, T>(
  fetchPage: (pagination: PageRequestInit) => Promise<R>,
  items: (page: R) => readonly T[],
  options: PaginateOptions = {},
): AsyncGenerator<T, void, undefined> {
  const limit = options.limit ?? 100n;
  const maxPages = options.maxPages ?? 100;
  let key: Uint8Array | undefined;
  let offset: bigint | undefined;
  let read = 0n;
  for (let page = 0; ; page++) {
    if (page >= maxPages) throw new PaginationError(`more than ${maxPages} pages`);
    const response = await fetchPage(key !== undefined ? { limit, key } : offset !== undefined ? { limit, offset } : { limit });
    const got = items(response);
    yield* got;
    read += BigInt(got.length);
    const next = response.pagination?.nextKey;
    if (next !== undefined && next.length > 0) {
      key = next;
      offset = undefined;
      continue;
    }
    // No key for a next page. A route that pages by offset never gives one, a block's transactions among them: its
    // total says whether more exist, and a walk that stopped here would return the first page as if it were all.
    // A page that brought nothing ends the walk whatever the total says.
    const total = response.pagination?.total ?? 0n;
    if (got.length === 0 || total <= read) return;
    key = undefined;
    offset = read;
  }
}

/** Every item of a paginated query as one array. */
export async function collectAll<R extends { pagination?: PageResponse | undefined }, T>(
  fetchPage: (pagination: PageRequestInit) => Promise<R>,
  items: (page: R) => readonly T[],
  options: PaginateOptions = {},
): Promise<T[]> {
  const out: T[] = [];
  try {
    for await (const item of paginate(fetchPage, items, options)) out.push(item);
  } catch (err) {
    if (err instanceof PaginationError) throw new PaginationError(err.message, out);
    throw err;
  }
  return out;
}
