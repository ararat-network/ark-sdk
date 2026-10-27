// Typed queries for the modules the app reads, Ark's and the Cosmos SDK's,
// each a thin call through the gateway. A facade returns the response
// message; `gateway.call` returns the same with the height the node answered
// at, for a reader that must carry it.
import type { MessageInitShape } from "@bufbuild/protobuf";
import type { Any } from "@bufbuild/protobuf/wkt";
import { type DecodedAccount, decodeAccount } from "../decode/account.js";
import type { QueryGrantsRequestSchema } from "../gen/ark/disbursement/v1/query_pb.js";
import { Query as DisbursementQuery } from "../gen/ark/disbursement/v1/query_pb.js";
import { Query as MarketQuery } from "../gen/ark/market/v1/query_pb.js";
import { Query as OracleQuery } from "../gen/ark/oracle/v1/query_pb.js";
import { Query as TreasuryQuery } from "../gen/ark/treasury/v1/query_pb.js";
import { Query as AuthQuery } from "../gen/cosmos/auth/v1beta1/query_pb.js";
import { Query as BankQuery } from "../gen/cosmos/bank/v1beta1/query_pb.js";
import type { PageRequestSchema } from "../gen/cosmos/base/query/v1beta1/pagination_pb.js";
import { Service as NodeService } from "../gen/cosmos/base/tendermint/v1beta1/query_pb.js";
import { Query as DistributionQuery } from "../gen/cosmos/distribution/v1beta1/query_pb.js";
import type { QueryProposalsRequestSchema } from "../gen/cosmos/gov/v1/query_pb.js";
import { Query as GovQuery } from "../gen/cosmos/gov/v1/query_pb.js";
import { Query as StakingQuery } from "../gen/cosmos/staking/v1beta1/query_pb.js";
import { BroadcastMode, OrderBy, Service as TxService } from "../gen/cosmos/tx/v1beta1/service_pb.js";
import { type Network, RegistryError } from "../registry/network.js";
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

/** The node runs a binary version the registry does not list as compatible, and the caller asked for one it does. */
export class NodeVersionUnlisted extends Error {
  override readonly name: string = "NodeVersionUnlisted";
  constructor(
    readonly version: string,
    readonly listed: readonly string[],
  ) {
    super(`node runs ${version === "" ? "an unnamed version" : version}; the registry lists ${listed.join(", ")}`);
  }
}

export interface VerifyOptions {
  /** Refuse a node whose binary version the registry does not list; off by default, since a development build reports none of them. */
  requireListedVersion?: boolean;
  /** Fetch the genesis file the registry names and hash it against the registry's hash. */
  genesis?: boolean;
}

export interface NetworkVerification {
  /** The chain the node reports, equal to the network's. */
  chainId: string;
  /** The binary the node reports: its application name and version. */
  appName: string;
  version: string;
  /** Whether the registry lists the node's version as compatible; undefined when it lists none. */
  versionListed: boolean | undefined;
  /** The genesis file against the registry's hash: skipped unless asked for, unverifiable without a hash or a URL. */
  genesis: "verified" | "unverifiable" | "skipped";
}

type Page = MessageInitShape<typeof PageRequestSchema> | undefined;

export class QueryClient {
  readonly gateway: GatewayClient;
  readonly #fetch: typeof fetch;

  constructor(restUrl: string | readonly string[], options: GatewayOptions = {}) {
    this.gateway = new GatewayClient(restUrl, options);
    this.#fetch = options.fetch ?? globalThis.fetch;
  }

  /** A client over the network's REST endpoints, in the registry's order, moving on when one cannot answer. */
  static forNetwork(network: Network, options: GatewayOptions = {}): QueryClient {
    const urls = network.endpoints.rest.map((e) => e.address);
    if (urls.length === 0) throw new Error(`network ${network.chainId} lists no REST endpoint`);
    return new QueryClient(urls, options);
  }

  /**
   * Checks the node is on the network's chain, refusing another chain under
   * the same endpoint, and reports what else it could see: the binary the
   * node runs against the versions the registry lists, and, on request, the
   * genesis file against the registry's hash. A node can still lie about all
   * of it; what this rules out is a wrong or stale endpoint, not a hostile one.
   */
  async verifyNetwork(network: Network, options: VerifyOptions = {}): Promise<NetworkVerification> {
    const info = await this.node.info();
    const actual = info.defaultNodeInfo?.network ?? "";
    if (actual !== network.chainId) throw new NetworkMismatch(network.chainId, actual);
    const appName = info.applicationVersion?.appName ?? "";
    const version = info.applicationVersion?.version ?? "";
    const listed = network.compatibleVersions;
    const versionListed = listed.length === 0 ? undefined : listed.includes(version);
    if (options.requireListedVersion && versionListed === false) throw new NodeVersionUnlisted(version, listed);
    const genesis = options.genesis ? await this.#verifyGenesis(network) : "skipped";
    return { chainId: actual, appName, version, versionListed, genesis };
  }

  async #verifyGenesis(network: Network): Promise<"verified" | "unverifiable"> {
    if (network.genesisSha256 === undefined || network.genesisUrl === undefined) return "unverifiable";
    const response = await this.#fetch(network.genesisUrl);
    if (!response.ok) throw new RegistryError(`${network.genesisUrl}: ${response.status} ${response.statusText}`);
    return network.verifyGenesis(new Uint8Array(await response.arrayBuffer()));
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
    /** The account decoded by type: base, module, or one of the vesting accounts, with its schedule. */
    decodedAccount: async (address: string): Promise<DecodedAccount> => {
      const { account } = await this.#value(AuthQuery, "account", { address });
      if (!account) throw new Error(`no account at ${address}`);
      return decodeAccount(account);
    },
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
    /** Committed transactions matching a CometBFT event query such as message.sender='ark1...'; needs a node that indexes transactions. */
    search: (query: string, options: { page?: bigint; limit?: bigint; orderBy?: OrderBy } = {}) =>
      this.#value(TxService, "getTxsEvent", { query, page: options.page ?? 1n, limit: options.limit ?? 50n, orderBy: options.orderBy ?? OrderBy.DESC }),
    /** The transactions of one block as the node returns them, messages still packed; decodeTx reads each. */
    byBlock: (height: bigint, pagination?: Page) => this.#value(TxService, "getBlockWithTxs", { height, pagination }),
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

export { BroadcastMode, OrderBy };
