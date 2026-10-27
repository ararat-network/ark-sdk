// Typed queries for the modules the app reads, Ark's and the Cosmos SDK's,
// each a thin call through the gateway. A facade returns the response
// message; `gateway.call` returns the same with the height the node answered
// at, for a reader that must carry it.
import type { MessageInitShape } from "@bufbuild/protobuf";
import type { Any } from "@bufbuild/protobuf/wkt";

import { Query as DisbursementQuery } from "../gen/ark/disbursement/v1/query_pb.js";
import { Query as MarketQuery } from "../gen/ark/market/v1/query_pb.js";
import { Query as OracleQuery } from "../gen/ark/oracle/v1/query_pb.js";
import { Query as TreasuryQuery } from "../gen/ark/treasury/v1/query_pb.js";
import { Query as AuthQuery } from "../gen/cosmos/auth/v1beta1/query_pb.js";
import { Query as BankQuery } from "../gen/cosmos/bank/v1beta1/query_pb.js";
import { Service as NodeService } from "../gen/cosmos/base/tendermint/v1beta1/query_pb.js";
import { Query as DistributionQuery } from "../gen/cosmos/distribution/v1beta1/query_pb.js";
import { Query as GovQuery } from "../gen/cosmos/gov/v1/query_pb.js";
import { Query as StakingQuery } from "../gen/cosmos/staking/v1beta1/query_pb.js";
import { BroadcastMode, Service as TxService } from "../gen/cosmos/tx/v1beta1/service_pb.js";
import type { PageRequestSchema } from "../gen/cosmos/base/query/v1beta1/pagination_pb.js";
import type { QueryGrantsRequestSchema } from "../gen/ark/disbursement/v1/query_pb.js";
import type { QueryProposalsRequestSchema } from "../gen/cosmos/gov/v1/query_pb.js";
import type { Network } from "../registry/network.js";
import { GatewayClient, type GatewayOptions } from "./gateway.js";

export class NetworkMismatch extends Error {
  override readonly name: string = "NetworkMismatch";
  constructor(
    readonly expected: string,
    readonly actual: string,
  ) {
    super(`node is on chain ${actual}, expected ${expected}`);
  }
}

type Page = MessageInitShape<typeof PageRequestSchema> | undefined;

export class QueryClient {
  readonly gateway: GatewayClient;

  constructor(restUrl: string, options: GatewayOptions = {}) {
    this.gateway = new GatewayClient(restUrl, options);
  }

  /** A client for the network's first REST endpoint. */
  static forNetwork(network: Network, options: GatewayOptions = {}): QueryClient {
    const url = network.restUrl;
    if (!url) throw new Error(`network ${network.chainId} lists no REST endpoint`);
    return new QueryClient(url, options);
  }

  /** Checks the node is on the network's chain, refusing another chain under the same endpoint. */
  async verifyNetwork(network: Network): Promise<void> {
    const info = await this.node.info();
    const actual = info.defaultNodeInfo?.network ?? "";
    if (actual !== network.chainId) throw new NetworkMismatch(network.chainId, actual);
  }

  readonly disbursement = {
    params: () => this.#value(DisbursementQuery, "params", {}),
    member: (address: string) => this.#value(DisbursementQuery, "member", { address }),
    members: (pagination?: Page) => this.#value(DisbursementQuery, "members", { pagination }),
    grant: (id: bigint) => this.#value(DisbursementQuery, "grant", { id }),
    grants: (request: MessageInitShape<typeof QueryGrantsRequestSchema> = {}) => this.#value(DisbursementQuery, "grants", request),
    grantJournal: (grantId: bigint, pagination?: Page) => this.#value(DisbursementQuery, "grantJournal", { grantId, pagination }),
    /** Custody balances and the member NOAH open to registration. */
    balance: (denom = "") => this.#value(DisbursementQuery, "balance", { denom }),
    beneficiary: (address: string) => this.#value(DisbursementQuery, "beneficiary", { address }),
    grantsMandate: () => this.#value(DisbursementQuery, "grantsMandate", {}),
    registrarMandate: () => this.#value(DisbursementQuery, "registrarMandate", {}),
  };

  readonly treasury = {
    params: () => this.#value(TreasuryQuery, "params", {}),
    /** The whole gas price sheet: every accepted denomination and the reference row. */
    gasPrices: () => this.#value(TreasuryQuery, "gasPrices", {}),
    gasPrice: (denom: string) => this.#value(TreasuryQuery, "gasPrice", { denom }),
    /** The transfer tax these exact messages owe, and the principal it was computed over. */
    computeTax: (messages: Any[]) => this.#value(TreasuryQuery, "computeTax", { messages }),
    taxCaps: () => this.#value(TreasuryQuery, "taxCaps", {}),
    economicPolicy: () => this.#value(TreasuryQuery, "economicPolicy", {}),
  };

  readonly oracle = {
    exchangeRate: (denom: string) => this.#value(OracleQuery, "exchangeRate", { denom }),
    exchangeRates: () => this.#value(OracleQuery, "exchangeRates", {}),
    storedRates: () => this.#value(OracleQuery, "storedRates", {}),
    referenceDenom: () => this.#value(OracleQuery, "referenceDenom", {}),
    feeds: () => this.#value(OracleQuery, "feeds", {}),
    params: () => this.#value(OracleQuery, "params", {}),
  };

  readonly market = {
    /** What a sell of offerCoin returns in askDenom, and the spread it pays. */
    sell: (offerCoin: string, askDenom: string) => this.#value(MarketQuery, "sell", { offerCoin, askDenom }),
    /** The least offer in offerDenom that buys askCoin, and the spread. */
    buy: (askCoin: string, offerDenom: string) => this.#value(MarketQuery, "buy", { askCoin, offerDenom }),
    pool: () => this.#value(MarketQuery, "pool", {}),
    params: () => this.#value(MarketQuery, "params", {}),
    conversionPolicy: () => this.#value(MarketQuery, "conversionPolicy", {}),
    tobinTax: (denom: string) => this.#value(MarketQuery, "tobinTax", { denom }),
  };

  readonly auth = {
    /** Account number and sequence, whatever the account's type. */
    accountInfo: (address: string) => this.#value(AuthQuery, "accountInfo", { address }),
    account: (address: string) => this.#value(AuthQuery, "account", { address }),
  };

  readonly bank = {
    balance: (address: string, denom: string) => this.#value(BankQuery, "balance", { address, denom }),
    allBalances: (address: string, pagination?: Page) => this.#value(BankQuery, "allBalances", { address, pagination }),
    spendableBalances: (address: string, pagination?: Page) => this.#value(BankQuery, "spendableBalances", { address, pagination }),
    supplyOf: (denom: string) => this.#value(BankQuery, "supplyOf", { denom }),
  };

  readonly staking = {
    params: () => this.#value(StakingQuery, "params", {}),
    validators: (status = "", pagination?: Page) => this.#value(StakingQuery, "validators", { status, pagination }),
    validator: (validatorAddr: string) => this.#value(StakingQuery, "validator", { validatorAddr }),
    delegatorDelegations: (delegatorAddr: string, pagination?: Page) => this.#value(StakingQuery, "delegatorDelegations", { delegatorAddr, pagination }),
    delegatorUnbondingDelegations: (delegatorAddr: string, pagination?: Page) =>
      this.#value(StakingQuery, "delegatorUnbondingDelegations", { delegatorAddr, pagination }),
    delegation: (delegatorAddr: string, validatorAddr: string) => this.#value(StakingQuery, "delegation", { delegatorAddr, validatorAddr }),
    pool: () => this.#value(StakingQuery, "pool", {}),
  };

  readonly distribution = {
    delegationTotalRewards: (delegatorAddress: string) => this.#value(DistributionQuery, "delegationTotalRewards", { delegatorAddress }),
    delegationRewards: (delegatorAddress: string, validatorAddress: string) =>
      this.#value(DistributionQuery, "delegationRewards", { delegatorAddress, validatorAddress }),
  };

  readonly gov = {
    proposals: (request: MessageInitShape<typeof QueryProposalsRequestSchema> = {}) => this.#value(GovQuery, "proposals", request),
    proposal: (proposalId: bigint) => this.#value(GovQuery, "proposal", { proposalId }),
    vote: (proposalId: bigint, voter: string) => this.#value(GovQuery, "vote", { proposalId, voter }),
    votes: (proposalId: bigint, pagination?: Page) => this.#value(GovQuery, "votes", { proposalId, pagination }),
    tallyResult: (proposalId: bigint) => this.#value(GovQuery, "tallyResult", { proposalId }),
    params: (paramsType = "") => this.#value(GovQuery, "params", { paramsType }),
  };

  readonly tx = {
    /** Runs the transaction without committing it: gas used and the result. */
    simulate: (txBytes: Uint8Array) => this.#value(TxService, "simulate", { txBytes }),
    /** Hands the transaction to the node's mempool; sync mode returns the CheckTx result. */
    broadcast: (txBytes: Uint8Array, mode: BroadcastMode = BroadcastMode.SYNC) => this.#value(TxService, "broadcastTx", { txBytes, mode }),
    /** A committed transaction by hash; NotFound while it is pending. */
    getTx: (hash: string) => this.#value(TxService, "getTx", { hash }),
  };

  readonly node = {
    info: () => this.#value(NodeService, "getNodeInfo", {}),
    syncing: () => this.#value(NodeService, "getSyncing", {}),
    latestBlock: () => this.#value(NodeService, "getLatestBlock", {}),
  };

  async #value<S extends Parameters<GatewayClient["call"]>[0], M extends keyof S["method"] & string>(
    service: S,
    method: M,
    request: MessageInitShape<S["method"][M]["input"]>,
  ) {
    return (await this.gateway.call(service, method, request)).value;
  }
}

export { BroadcastMode };
