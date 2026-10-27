// Accounts by type: a base account, a module account, or one of the SDK's
// vesting accounts, which the seats are. The vesting arithmetic mirrors
// x/auth/vesting's GetVestedCoins exactly, Dec division and rounding
// included, so a view agrees with what the chain lets the account move.
import { type Message, type Registry } from "@bufbuild/protobuf";
import type { Any } from "@bufbuild/protobuf/wkt";

import { unpackAny } from "../codec/any.js";
import { LegacyDec } from "../codec/dec.js";
import { registry as defaultRegistry } from "../codec/registry.js";
import type { BaseAccount, ModuleAccount } from "../gen/cosmos/auth/v1beta1/auth_pb.js";
import type { Coin } from "../gen/cosmos/base/v1beta1/coin_pb.js";
import type { BaseVestingAccount, ContinuousVestingAccount, DelayedVestingAccount, PeriodicVestingAccount, PermanentLockedAccount } from "../gen/cosmos/vesting/v1beta1/vesting_pb.js";
import { coin } from "../tx/body.js";
import { sumCoins } from "../tx/fee.js";

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

const KINDS: Record<string, AccountKind> = {
  "cosmos.auth.v1beta1.BaseAccount": "base",
  "cosmos.auth.v1beta1.ModuleAccount": "module",
  "cosmos.vesting.v1beta1.ContinuousVestingAccount": "continuous_vesting",
  "cosmos.vesting.v1beta1.DelayedVestingAccount": "delayed_vesting",
  "cosmos.vesting.v1beta1.PeriodicVestingAccount": "periodic_vesting",
  "cosmos.vesting.v1beta1.PermanentLockedAccount": "permanent_locked",
};

/** Decodes the Any an account query returns. */
export function decodeAccount(any: Any, registry: Registry = defaultRegistry): DecodedAccount {
  const unknown: DecodedAccount = { kind: "unknown", typeUrl: any.typeUrl, address: "", accountNumber: 0n, sequence: 0n, publicKey: undefined, message: undefined, module: undefined, vesting: undefined };
  const unpacked = unpackAny(any, registry);
  if (!unpacked) return unknown;
  const kind = KINDS[unpacked.schema.typeName] ?? "unknown";
  const message = unpacked.message;
  const withBase = (base: BaseAccount | undefined, extra: Partial<DecodedAccount>): DecodedAccount => ({
    ...unknown,
    kind,
    message,
    address: base?.address ?? "",
    accountNumber: base?.accountNumber ?? 0n,
    sequence: base?.sequence ?? 0n,
    publicKey: base?.pubKey,
    ...extra,
  });
  switch (kind) {
    case "base":
      return withBase(message as BaseAccount, {});
    case "module": {
      const m = message as ModuleAccount;
      return withBase(m.baseAccount, { module: { name: m.name, permissions: [...m.permissions] } });
    }
    case "continuous_vesting": {
      const m = message as ContinuousVestingAccount;
      return withBase(m.baseVestingAccount?.baseAccount, { vesting: schedule(m.baseVestingAccount, m.startTime, undefined) });
    }
    case "delayed_vesting": {
      const m = message as DelayedVestingAccount;
      return withBase(m.baseVestingAccount?.baseAccount, { vesting: schedule(m.baseVestingAccount, undefined, undefined) });
    }
    case "periodic_vesting": {
      const m = message as PeriodicVestingAccount;
      return withBase(m.baseVestingAccount?.baseAccount, { vesting: schedule(m.baseVestingAccount, m.startTime, m.vestingPeriods.map((p) => ({ length: p.length, amount: [...p.amount] }))) });
    }
    case "permanent_locked": {
      const m = message as PermanentLockedAccount;
      return withBase(m.baseVestingAccount?.baseAccount, { vesting: schedule(m.baseVestingAccount, undefined, undefined) });
    }
    default:
      return { ...unknown, message };
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
      return v.originalVesting.map((c) => coin(c.denom, LegacyDec.fromInt(BigInt(c.amount)).mul(share).roundInt()));
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
  const vested = new Map(vestedCoins(account, atSeconds).map((c) => [c.denom, BigInt(c.amount)]));
  return v.originalVesting.map((c) => coin(c.denom, BigInt(c.amount) - (vested.get(c.denom) ?? 0n))).filter((c) => c.amount !== "0");
}
