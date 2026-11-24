// Typed queries for the modules the app reads, Ark's and the Cosmos SDK's,
// each a thin call through the gateway. A facade returns the response
// message; `gateway.call` returns the same with the height the node answered
// at, for a reader that must carry it.
import type { MessageInitShape } from "@bufbuild/protobuf";
import type { Any } from "@bufbuild/protobuf/wkt";
import { type DecodedAccount, decodeAccount } from "../decode/account.js";
import { ArkSdkError, errorMessage } from "../errors.js";
import type { QueryGrantsRequestSchema } from "../gen/ark/disbursement/v1/query_pb.js";
import { Query as DisbursementQuery } from "../gen/ark/disbursement/v1/query_pb.js";
import { Query as MarketQuery } from "../gen/ark/market/v1/query_pb.js";
import { Query as OracleQuery } from "../gen/ark/oracle/v1/query_pb.js";
import { Query as TreasuryQuery } from "../gen/ark/treasury/v1/query_pb.js";
import { Query as AuthQuery } from "../gen/cosmos/auth/v1beta1/query_pb.js";
import { Query as BankQuery } from "../gen/cosmos/bank/v1beta1/query_pb.js";
import { Service as NodeService } from "../gen/cosmos/base/tendermint/v1beta1/query_pb.js";
import { Query as DistributionQuery } from "../gen/cosmos/distribution/v1beta1/query_pb.js";
import type { QueryProposalsRequestSchema } from "../gen/cosmos/gov/v1/query_pb.js";
import { Query as GovQuery } from "../gen/cosmos/gov/v1/query_pb.js";
import { Query as StakingQuery } from "../gen/cosmos/staking/v1beta1/query_pb.js";
import { BroadcastMode, OrderBy, Service as TxService } from "../gen/cosmos/tx/v1beta1/service_pb.js";
import { fetchOk, type Network } from "../registry/network.js";
import { RegistryError } from "../registry/parse.js";
import { type CallOptions, GatewayClient, type GatewayOptions } from "./gateway.js";
import type { PageRequestInit } from "./pagination.js";

export class NetworkMismatch extends ArkSdkError {
  override readonly name: string = "NetworkMismatch";
  constructor(
    readonly expected: string,
    readonly actual: string,
  ) {
    super(`node is on chain ${actual}, expected ${expected}`);
  }
}

/** The node runs a binary version the registry does not list as compatible, and the caller asked for one it does. */
export class NodeVersionUnlisted extends ArkSdkError {
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

/** The network's REST endpoints, in the registry's order; a network that lists none is refused. */
export function restEndpoints(network: Network): string[] {
  const urls = network.endpoints.rest.map((e) => e.address);
  if (urls.length === 0) throw new RegistryError(`network ${network.chainId} lists no REST endpoint`);
  return urls;
}

/** Calls one method through the gateway and returns the response message, without the height it was answered at. */
async function value<S extends Parameters<GatewayClient["call"]>[0], M extends keyof S["method"] & string>(
  gateway: GatewayClient,
  service: S,
  method: M,
  request: MessageInitShape<S["method"][M]["input"]>,
  options?: CallOptions,
) {
  return (await gateway.call(service, method, request, options)).value;
}

// One client to a service, each over a gateway: `bankClient(gateway).balance(address, denom)`. QueryClient holds them
// all, and so bundles every service it has a facade for. A caller of the core entry who needs a small bundle builds
// the few it calls over a GatewayClient of its own, and hands the SDK's flows an object holding those: each flow's
// `client` is typed by the services it reads.

/** Ark's disbursement module: members, grants and their journal, custody balances, and the mandates. */
export const disbursementClient = (gateway: GatewayClient) => ({
  params: () => value(gateway, DisbursementQuery, "params", {}),
  member: (address: string) => value(gateway, DisbursementQuery, "member", { address }),
  members: (pagination?: PageRequestInit) => value(gateway, DisbursementQuery, "members", { pagination }),
  grant: (id: bigint) => value(gateway, DisbursementQuery, "grant", { id }),
  grants: (request: MessageInitShape<typeof QueryGrantsRequestSchema> = {}) => value(gateway, DisbursementQuery, "grants", request),
  grantJournal: (grantId: bigint, pagination?: PageRequestInit) => value(gateway, DisbursementQuery, "grantJournal", { grantId, pagination }),
  /** Custody balances and the member NOAH open to registration. */
  balance: (denom = "") => value(gateway, DisbursementQuery, "balance", { denom }),
  beneficiary: (address: string) => value(gateway, DisbursementQuery, "beneficiary", { address }),
  grantsMandate: () => value(gateway, DisbursementQuery, "grantsMandate", {}),
  registrarMandate: () => value(gateway, DisbursementQuery, "registrarMandate", {}),
});

/** Ark's treasury: the gas price sheet, the transfer tax on a set of messages, and its policy. */
export const treasuryClient = (gateway: GatewayClient) => ({
  params: () => value(gateway, TreasuryQuery, "params", {}),
  /** The whole gas price sheet: every accepted denomination and the reference row. */
  gasPrices: () => value(gateway, TreasuryQuery, "gasPrices", {}),
  gasPrice: (denom: string) => value(gateway, TreasuryQuery, "gasPrice", { denom }),
  /** The transfer tax these exact messages owe, and the principal it was computed over. */
  computeTax: (messages: Any[]) => value(gateway, TreasuryQuery, "computeTax", { messages }),
  taxCaps: () => value(gateway, TreasuryQuery, "taxCaps", {}),
  economicPolicy: () => value(gateway, TreasuryQuery, "economicPolicy", {}),
});

/** Ark's oracle: exchange rates against the reference denomination, and the feeds behind them. */
export const oracleClient = (gateway: GatewayClient) => ({
  exchangeRate: (denom: string) => value(gateway, OracleQuery, "exchangeRate", { denom }),
  exchangeRates: () => value(gateway, OracleQuery, "exchangeRates", {}),
  storedRates: () => value(gateway, OracleQuery, "storedRates", {}),
  referenceDenom: () => value(gateway, OracleQuery, "referenceDenom", {}),
  feeds: () => value(gateway, OracleQuery, "feeds", {}),
  params: () => value(gateway, OracleQuery, "params", {}),
});

/** Ark's market: what a sell or a buy returns, the pool, and the conversion policy. */
export const marketClient = (gateway: GatewayClient) => ({
  /** What a sell of offerCoin returns in askDenom, and the spread it pays. */
  sell: (offerCoin: string, askDenom: string) => value(gateway, MarketQuery, "sell", { offerCoin, askDenom }),
  /** The least offer in offerDenom that buys askCoin, and the spread. */
  buy: (askCoin: string, offerDenom: string) => value(gateway, MarketQuery, "buy", { askCoin, offerDenom }),
  pool: () => value(gateway, MarketQuery, "pool", {}),
  params: () => value(gateway, MarketQuery, "params", {}),
  conversionPolicy: () => value(gateway, MarketQuery, "conversionPolicy", {}),
  tobinTax: (denom: string) => value(gateway, MarketQuery, "tobinTax", { denom }),
});

/** Accounts: number and sequence, the account as the chain holds it, and the account decoded by type. */
export const authClient = (gateway: GatewayClient) => ({
  /** Account number and sequence, whatever the account's type. */
  accountInfo: (address: string) => value(gateway, AuthQuery, "accountInfo", { address }),
  account: (address: string) => value(gateway, AuthQuery, "account", { address }),
  /** The account decoded by type: base, module, or one of the vesting accounts, with its schedule. */
  decodedAccount: async (address: string): Promise<DecodedAccount> => {
    const { account } = await value(gateway, AuthQuery, "account", { address });
    if (!account) throw new ArkSdkError(`no account at ${address}`);
    return decodeAccount(account, gateway.registry);
  },
});

/** Balances and supply. */
export const bankClient = (gateway: GatewayClient) => ({
  balance: (address: string, denom: string) => value(gateway, BankQuery, "balance", { address, denom }),
  allBalances: (address: string, pagination?: PageRequestInit) => value(gateway, BankQuery, "allBalances", { address, pagination }),
  spendableBalances: (address: string, pagination?: PageRequestInit) => value(gateway, BankQuery, "spendableBalances", { address, pagination }),
  supplyOf: (denom: string) => value(gateway, BankQuery, "supplyOf", { denom }),
});

/** Validators, delegations, and the staking pool. */
export const stakingClient = (gateway: GatewayClient) => ({
  params: () => value(gateway, StakingQuery, "params", {}),
  validators: (status = "", pagination?: PageRequestInit) => value(gateway, StakingQuery, "validators", { status, pagination }),
  validator: (validatorAddr: string) => value(gateway, StakingQuery, "validator", { validatorAddr }),
  delegatorDelegations: (delegatorAddr: string, pagination?: PageRequestInit) =>
    value(gateway, StakingQuery, "delegatorDelegations", { delegatorAddr, pagination }),
  delegatorUnbondingDelegations: (delegatorAddr: string, pagination?: PageRequestInit) =>
    value(gateway, StakingQuery, "delegatorUnbondingDelegations", { delegatorAddr, pagination }),
  delegation: (delegatorAddr: string, validatorAddr: string) => value(gateway, StakingQuery, "delegation", { delegatorAddr, validatorAddr }),
  pool: () => value(gateway, StakingQuery, "pool", {}),
});

/** A delegator's rewards. */
export const distributionClient = (gateway: GatewayClient) => ({
  delegationTotalRewards: (delegatorAddress: string) => value(gateway, DistributionQuery, "delegationTotalRewards", { delegatorAddress }),
  delegationRewards: (delegatorAddress: string, validatorAddress: string) =>
    value(gateway, DistributionQuery, "delegationRewards", { delegatorAddress, validatorAddress }),
});

/** Proposals, votes, tallies, and the governance parameters. */
export const govClient = (gateway: GatewayClient) => ({
  proposals: (request: MessageInitShape<typeof QueryProposalsRequestSchema> = {}) => value(gateway, GovQuery, "proposals", request),
  proposal: (proposalId: bigint) => value(gateway, GovQuery, "proposal", { proposalId }),
  vote: (proposalId: bigint, voter: string) => value(gateway, GovQuery, "vote", { proposalId, voter }),
  votes: (proposalId: bigint, pagination?: PageRequestInit) => value(gateway, GovQuery, "votes", { proposalId, pagination }),
  tallyResult: (proposalId: bigint) => value(gateway, GovQuery, "tallyResult", { proposalId }),
  /** The route needs a params type, "voting", "tallying", or "deposit"; `params` in the answer holds them all whichever is named. */
  params: (paramsType: "voting" | "tallying" | "deposit") => value(gateway, GovQuery, "params", { paramsType }),
});

/** The transaction service: simulate, broadcast, and committed transactions by hash, event query, or block. */
export const txClient = (gateway: GatewayClient) => ({
  /** Runs the transaction without committing it: gas used and the result. */
  simulate: (txBytes: Uint8Array) => value(gateway, TxService, "simulate", { txBytes }),
  /** Hands the transaction to the node's mempool, once, to one endpoint; sync mode returns the CheckTx result. */
  broadcast: (txBytes: Uint8Array, mode: BroadcastMode = BroadcastMode.SYNC) =>
    value(gateway, TxService, "broadcastTx", { txBytes, mode }, { idempotent: false }),
  /** A committed transaction by hash; NotFound while it is pending. */
  getTx: (hash: string) => value(gateway, TxService, "getTx", { hash }),
  /** Committed transactions matching a CometBFT event query such as message.sender='ark1...'; needs a node that indexes transactions. */
  search: (query: string, options: { page?: bigint; limit?: bigint; orderBy?: OrderBy } = {}) =>
    value(gateway, TxService, "getTxsEvent", { query, page: options.page ?? 1n, limit: options.limit ?? 50n, orderBy: options.orderBy ?? OrderBy.DESC }),
  /** The transactions of one block as the node returns them, messages still packed; decodeTx reads each. */
  byBlock: (height: bigint, pagination?: PageRequestInit) => value(gateway, TxService, "getBlockWithTxs", { height, pagination }),
});

/** The node itself: the chain and binary it reports, whether it is catching up, and its latest block. */
export const nodeClient = (gateway: GatewayClient) => ({
  info: () => value(gateway, NodeService, "getNodeInfo", {}),
  syncing: () => value(gateway, NodeService, "getSyncing", {}),
  latestBlock: () => value(gateway, NodeService, "getLatestBlock", {}),
});

/** Every service the app reads, over one gateway: each member is that service's client. */
export class QueryClient {
  readonly gateway: GatewayClient;
  readonly #fetch: typeof fetch;
  readonly disbursement: ReturnType<typeof disbursementClient>;
  readonly treasury: ReturnType<typeof treasuryClient>;
  readonly oracle: ReturnType<typeof oracleClient>;
  readonly market: ReturnType<typeof marketClient>;
  readonly auth: ReturnType<typeof authClient>;
  readonly bank: ReturnType<typeof bankClient>;
  readonly staking: ReturnType<typeof stakingClient>;
  readonly distribution: ReturnType<typeof distributionClient>;
  readonly gov: ReturnType<typeof govClient>;
  readonly tx: ReturnType<typeof txClient>;
  readonly node: ReturnType<typeof nodeClient>;

  constructor(restUrl: string | readonly string[], options: GatewayOptions) {
    this.gateway = new GatewayClient(restUrl, options);
    this.#fetch = options?.fetch ?? globalThis.fetch;
    this.disbursement = disbursementClient(this.gateway);
    this.treasury = treasuryClient(this.gateway);
    this.oracle = oracleClient(this.gateway);
    this.market = marketClient(this.gateway);
    this.auth = authClient(this.gateway);
    this.bank = bankClient(this.gateway);
    this.staking = stakingClient(this.gateway);
    this.distribution = distributionClient(this.gateway);
    this.gov = govClient(this.gateway);
    this.tx = txClient(this.gateway);
    this.node = nodeClient(this.gateway);
  }

  /** A client over the network's REST endpoints, in the registry's order, moving on when one cannot answer. */
  static forNetwork(network: Network, options: GatewayOptions): QueryClient {
    return new QueryClient(restEndpoints(network), options);
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
    const response = await fetchOk(this.#fetch, network.genesisUrl);
    let genesis: Uint8Array;
    try {
      genesis = new Uint8Array(await response.arrayBuffer());
    } catch (err) {
      throw new RegistryError(`${network.genesisUrl}: ${errorMessage(err)}`, { cause: err });
    }
    return network.verifyGenesis(genesis);
  }
}
