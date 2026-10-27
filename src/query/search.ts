// Finding committed transactions: by a CometBFT event query, by hash, or by
// block, each result decoded the one way. The node must index transactions;
// one that does not answers with an error the caller sees as it is.
import type { Registry } from "@bufbuild/protobuf";

import { decodeEvents, type DecodedEvent } from "../decode/events.js";
import { decodeMsgResponses } from "../decode/responses.js";
import { classifyResult, type Outcome } from "../decode/result.js";
import { decodeTxMessages, type DecodedMessage } from "../decode/tx.js";
import type { TxResponse } from "../gen/cosmos/base/abci/v1beta1/abci_pb.js";
import type { OrderBy } from "../gen/cosmos/tx/v1beta1/service_pb.js";
import type { Tx } from "../gen/cosmos/tx/v1beta1/tx_pb.js";
import type { QueryClient } from "./client.js";
import { QueryError } from "./gateway.js";

export interface FoundTx {
  hash: string;
  height: bigint;
  /** Block time as the node reports it, RFC 3339; empty when the node sends none. */
  timestamp: string;
  outcome: Outcome;
  response: TxResponse;
  tx: Tx | undefined;
  messages: DecodedMessage[];
  /** The messages' typed responses from the result's data. */
  responses: DecodedMessage[];
  events: DecodedEvent[];
  gasWanted: bigint;
  gasUsed: bigint;
}

export interface SearchOptions {
  page?: bigint;
  limit?: bigint;
  orderBy?: OrderBy;
  registry?: Registry;
}

export interface SearchResult {
  total: bigint;
  items: FoundTx[];
}

/** Event queries the app asks most; CometBFT's syntax joins conditions with AND only. */
export const txQuery = {
  bySender: (address: string): string => `message.sender='${address}'`,
  byRecipient: (address: string): string => `transfer.recipient='${address}'`,
  byHeight: (height: bigint): string => `tx.height=${height}`,
  and: (...conditions: string[]): string => conditions.join(" AND "),
};

/** Builds the decoded view of one committed transaction. */
export function foundTx(response: TxResponse, tx: Tx | undefined, registry?: Registry): FoundTx {
  const options = registry ? { registry } : {};
  return {
    hash: response.txhash,
    height: response.height,
    timestamp: response.timestamp,
    outcome: classifyResult(response),
    response,
    tx,
    messages: tx ? decodeTxMessages(tx, options) : [],
    responses: response.code === 0 ? decodeMsgResponses(response.data, registry) : [],
    events: decodeEvents(response.events, options),
    gasWanted: response.gasWanted,
    gasUsed: response.gasUsed,
  };
}

/** Committed transactions matching a query, newest first by default. */
export async function searchTxs(client: QueryClient, query: string, options: SearchOptions = {}): Promise<SearchResult> {
  const { registry, ...paging } = options;
  const result = await client.tx.search(query, paging);
  return {
    total: result.total,
    items: result.txResponses.map((response, i) => foundTx(response, result.txs[i], registry)),
  };
}

/** One committed transaction by hash, or undefined while it is pending or unknown. */
export async function fetchTx(client: QueryClient, hash: string, registry?: Registry): Promise<FoundTx | undefined> {
  try {
    const result = await client.tx.getTx(hash);
    if (!result.txResponse) return undefined;
    return foundTx(result.txResponse, result.tx, registry);
  } catch (err) {
    if (err instanceof QueryError && err.isNotFound) return undefined;
    throw err;
  }
}
