// Finding committed transactions: by a CometBFT event query, by hash, or by
// block, each result decoded the one way. The node must index transactions;
// one that does not answers with an error the caller sees as it is.
import type { Registry } from "@bufbuild/protobuf";

import type { RegistryOption } from "../codec/any.js";
import { type DecodedEvent, decodeEvents } from "../decode/events.js";
import { decodeMsgResponses } from "../decode/responses.js";
import { classifyResult, type Outcome } from "../decode/result.js";
import { type DecodedMessage, decodeTxMessages } from "../decode/tx.js";
import { ArkSdkError } from "../errors.js";
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

/** `registry` is the client's own by default: the types its answers were read with. */
export interface SearchOptions extends RegistryOption {
  page?: bigint;
  limit?: bigint;
  orderBy?: OrderBy;
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
export function foundTx(response: TxResponse, tx: Tx | undefined, registry: Registry): FoundTx {
  const options = { registry };
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

/** Committed transactions matching a query, newest first by default, decoded with the client's registry unless another is given. */
export async function searchTxs(client: QueryClient, query: string, options: SearchOptions = {}): Promise<SearchResult> {
  const { registry = client.gateway.registry, ...paging } = options;
  const result = await client.tx.search(query, paging);
  return {
    total: result.total,
    items: result.txResponses.map((response, i) => foundTx(response, result.txs[i], registry)),
  };
}

/** The node answered a lookup with a different transaction than the one asked for, or with one it did not name: `answered` is then empty. */
export class WrongTransaction extends ArkSdkError {
  override readonly name: string = "WrongTransaction";
  constructor(
    readonly hash: string,
    readonly answered: string,
  ) {
    super(answered === "" ? `the node answered for a transaction with no hash, not ${hash}` : `the node answered for transaction ${answered}, not ${hash}`);
  }
}

/**
 * The node's answer for one committed transaction by hash, as it sent it, or
 * undefined while the node has none under the hash: NotFound means pending or
 * unknown, not a failure. An answer for another hash, or for none, is refused,
 * so a faulty endpoint cannot pass one transaction's result off as another's.
 */
export async function lookUpTx(client: QueryClient, hash: string): Promise<{ response: TxResponse; tx: Tx | undefined } | undefined> {
  try {
    const found = await client.tx.getTx(hash);
    const response = found.txResponse;
    if (!response) return undefined;
    // A node names the transaction it answers for. An answer with no hash is refused as one for another hash is:
    // an empty result reads as code zero, a success, for a transaction that may be in no block.
    if (response.txhash.toUpperCase() !== hash.toUpperCase()) throw new WrongTransaction(hash, response.txhash);
    return { response, tx: found.tx };
  } catch (err) {
    if (err instanceof QueryError && err.isNotFound) return undefined;
    throw err;
  }
}

/** One committed transaction by hash, decoded with the client's registry unless another is given, or undefined while it is pending or unknown. */
export async function fetchTx(client: QueryClient, hash: string, registry: Registry = client.gateway.registry): Promise<FoundTx | undefined> {
  const found = await lookUpTx(client, hash);
  return found && foundTx(found.response, found.tx, registry);
}
