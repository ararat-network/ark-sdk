// Accounts by type: a base account, a module account, or one of the SDK's
// vesting accounts, which the seats are. The vesting arithmetic mirrors
// x/auth/vesting's GetVestedCoins exactly, Dec division and rounding
// included, so a view agrees with what the chain lets the account move.
import type { Message, Registry } from "@bufbuild/protobuf";
import type { Any } from "@bufbuild/protobuf/wkt";

import { requireRegistry, unpackAny } from "../codec/any.js";
import { coin, intFromWire, sumCoins } from "../codec/coins.js";
import { LegacyDec } from "../codec/dec.js";
import type { BaseAccount, ModuleAccount } from "../gen/cosmos/auth/v1beta1/auth_pb.js";
import type { Coin } from "../gen/cosmos/base/v1beta1/coin_pb.js";
import type {
  BaseVestingAccount,
  ContinuousVestingAccount,
  DelayedVestingAccount,
  PeriodicVestingAccount,
  PermanentLockedAccount,
} from "../gen/cosmos/vesting/v1beta1/vesting_pb.js";

export type AccountKind = "base" | "module" | "continuous_vesting" | "delayed_vesting" | "periodic_vesting" | "permanent_locked" | "unknown";

export interface VestingPeriod {
  /** Seconds the period lasts. */
  length: bigint;
  amount: Coin[];
}

export interface VestingSchedule {
  originalVesting: Coin[];
  delegatedFree: Coin[];
  delegatedVesting: Coin[];
  /** Unix seconds; undefined for a delayed or permanently locked account, which has no start. */
  startTime: bigint | undefined;
  /** Unix seconds. */
  endTime: bigint;
  /** A periodic account's periods, in order. */
  periods: VestingPeriod[] | undefined;
}

export interface DecodedAccount {
  kind: AccountKind;
  typeUrl: string;
  address: string;
  accountNumber: bigint;
  sequence: bigint;
  publicKey: Any | undefined;
  /** The decoded account message; undefined for an unknown type. */
  message: Message | undefined;
  module: { name: string; permissions: string[] } | undefined;
  vesting: VestingSchedule | undefined;
}

/** The account messages the decoder reads, told apart by type name. */
type AccountMessage = BaseAccount | ModuleAccount | ContinuousVestingAccount | DelayedVestingAccount | PeriodicVestingAccount | PermanentLockedAccount;

/** Decodes the Any an account query returns. */
export function decodeAccount(any: Any, registry: Registry): DecodedAccount {
  requireRegistry(registry, "decodeAccount");
  const unknown: DecodedAccount = {
    kind: "unknown",
    typeUrl: any.typeUrl,
    address: "",
    accountNumber: 0n,
    sequence: 0n,
    publicKey: undefined,
    message: undefined,
    module: undefined,
    vesting: undefined,
  };
  const unpacked = unpackAny(any, registry);
  if (!unpacked) return unknown;
  const withBase = (kind: AccountKind, base: BaseAccount | undefined, extra: Partial<DecodedAccount>): DecodedAccount => ({
    ...unknown,
    kind,
    message: unpacked.message,
    address: base?.address ?? "",
    accountNumber: base?.accountNumber ?? 0n,
    sequence: base?.sequence ?? 0n,
    publicKey: base?.pubKey,
    ...extra,
  });
  // A message under one of these type names is that account, and each case below narrows to it; any other falls
  // to the default, which reads nothing from it.
  const account = unpacked.message as AccountMessage;
  switch (account.$typeName) {
    case "cosmos.auth.v1beta1.BaseAccount":
      return withBase("base", account, {});
    case "cosmos.auth.v1beta1.ModuleAccount":
      return withBase("module", account.baseAccount, { module: { name: account.name, permissions: [...account.permissions] } });
    case "cosmos.vesting.v1beta1.ContinuousVestingAccount":
      return withBase("continuous_vesting", account.baseVestingAccount?.baseAccount, {
        vesting: schedule(account.baseVestingAccount, account.startTime, undefined),
      });
    case "cosmos.vesting.v1beta1.DelayedVestingAccount":
      return withBase("delayed_vesting", account.baseVestingAccount?.baseAccount, { vesting: schedule(account.baseVestingAccount, undefined, undefined) });
    case "cosmos.vesting.v1beta1.PeriodicVestingAccount":
      return withBase("periodic_vesting", account.baseVestingAccount?.baseAccount, {
        vesting: schedule(
          account.baseVestingAccount,
          account.startTime,
          account.vestingPeriods.map((p) => ({ length: p.length, amount: [...p.amount] })),
        ),
      });
    case "cosmos.vesting.v1beta1.PermanentLockedAccount":
      return withBase("permanent_locked", account.baseVestingAccount?.baseAccount, { vesting: schedule(account.baseVestingAccount, undefined, undefined) });
    default:
      return { ...unknown, message: unpacked.message };
  }
}

function schedule(base: BaseVestingAccount | undefined, startTime: bigint | undefined, periods: VestingPeriod[] | undefined): VestingSchedule {
  return {
    originalVesting: [...(base?.originalVesting ?? [])],
    delegatedFree: [...(base?.delegatedFree ?? [])],
    delegatedVesting: [...(base?.delegatedVesting ?? [])],
    startTime,
    endTime: base?.endTime ?? 0n,
    periods,
  };
}

/** The coins vested at a time, as x/auth/vesting computes them. */
export function vestedCoins(account: DecodedAccount, atSeconds: bigint): Coin[] {
  const v = account.vesting;
  if (!v) return [];
  switch (account.kind) {
    case "continuous_vesting": {
      const start = v.startTime ?? 0n;
      if (atSeconds <= start) return [];
      if (atSeconds >= v.endTime) return [...v.originalVesting];
      const share = LegacyDec.fromInt(atSeconds - start).quo(LegacyDec.fromInt(v.endTime - start));
      return v.originalVesting.map((c) => coin(c.denom, LegacyDec.fromInt(intFromWire(c.amount)).mul(share).roundInt()));
    }
    case "delayed_vesting":
      return atSeconds >= v.endTime ? [...v.originalVesting] : [];
    case "periodic_vesting": {
      const start = v.startTime ?? 0n;
      if (atSeconds <= start) return [];
      if (atSeconds >= v.endTime) return [...v.originalVesting];
      let periodStart = start;
      const vested: Coin[][] = [];
      for (const period of v.periods ?? []) {
        if (atSeconds - periodStart < period.length) break;
        vested.push(period.amount);
        periodStart += period.length;
      }
      return sumCoins(...vested);
    }
    case "permanent_locked":
      return [];
    default:
      return [...v.originalVesting];
  }
}

/** The coins still vesting at a time: the original vesting less what has vested. */
export function vestingCoins(account: DecodedAccount, atSeconds: bigint): Coin[] {
  const v = account.vesting;
  if (!v) return [];
  const vested = new Map(vestedCoins(account, atSeconds).map((c) => [c.denom, intFromWire(c.amount)]));
  return v.originalVesting.map((c) => coin(c.denom, intFromWire(c.amount) - (vested.get(c.denom) ?? 0n))).filter((c) => c.amount !== "0");
}
