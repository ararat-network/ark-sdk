import assert from "node:assert/strict";
import { test } from "node:test";

import { create } from "@bufbuild/protobuf";
import { DurationSchema, TimestampSchema } from "@bufbuild/protobuf/wkt";

import {
  durationFromText,
  durationToAmino,
  durationToProtoJson,
  GO_ZERO_TIME_SECONDS,
  timestampFromText,
  timestampToAmino,
  timestampToProtoJson,
} from "./wkt.js";

test("timestamps render as jsonpb and as Go's RFC 3339 forms", () => {
  const cases: [bigint, number, string, string][] = [
    [1731536047n, 0, "2024-11-13T22:14:07Z", "2024-11-13T22:14:07Z"],
    [1731536047n, 120_000_000, "2024-11-13T22:14:07.120Z", "2024-11-13T22:14:07.12Z"],
    [1731536047n, 123_456_000, "2024-11-13T22:14:07.123456Z", "2024-11-13T22:14:07.123456Z"],
    [1731536047n, 100, "2024-11-13T22:14:07.000000100Z", "2024-11-13T22:14:07.0000001Z"],
    [GO_ZERO_TIME_SECONDS, 0, "0001-01-01T00:00:00Z", "0001-01-01T00:00:00Z"],
    [0n, 0, "1970-01-01T00:00:00Z", "1970-01-01T00:00:00Z"],
  ];
  for (const [seconds, nanos, proto, amino] of cases) {
    const ts = create(TimestampSchema, { seconds, nanos });
    assert.equal(timestampToProtoJson(ts), proto);
    assert.equal(timestampToAmino(ts), amino);
    const back = timestampFromText(proto);
    assert.equal(back.seconds, seconds, proto);
    assert.equal(back.nanos, nanos, proto);
  }
  assert.equal(timestampFromText("2024-11-13T23:14:07+01:00").seconds, 1731536047n);
  assert.throws(() => timestampFromText("2024-11-13"));
});

test("a duration past the chain's bounds, or with its parts at odds, is refused as the chain refuses it", () => {
  const cases: [string, { seconds: bigint; nanos: number }][] = [
    ["seconds past ten thousand years", { seconds: 315_576_000_001n, nanos: 0 }],
    ["negative seconds past the bound", { seconds: -315_576_000_001n, nanos: 0 }],
    ["a second of nanos", { seconds: 1n, nanos: 1_000_000_000 }],
    ["positive seconds with negative nanos", { seconds: 1n, nanos: -1 }],
    ["negative seconds with positive nanos", { seconds: -1n, nanos: 1 }],
  ];
  for (const [name, d] of cases) assert.throws(() => durationToAmino(create(DurationSchema, d)), /duration/, name);
  assert.equal(durationToAmino(create(DurationSchema, { seconds: 315_576_000_000n, nanos: 999_999_999 })), "315576000000999999999", "the bound itself encodes");
});

test("durations render as jsonpb seconds and amino nanoseconds", () => {
  const cases: [bigint, number, string, string][] = [
    [1814400n, 0, "1814400s", "1814400000000000"],
    [1n, 500_000_000, "1.500s", "1500000000"],
    [0n, 1_000, "0.000001s", "1000"],
    [-1n, -500_000_000, "-1.500s", "-1500000000"],
    [0n, 0, "0s", "0"],
  ];
  for (const [seconds, nanos, proto, amino] of cases) {
    const d = create(DurationSchema, { seconds, nanos });
    assert.equal(durationToProtoJson(d), proto);
    assert.equal(durationToAmino(d), amino);
    const back = durationFromText(proto);
    assert.equal(back.seconds, seconds, proto);
    assert.equal(back.nanos, nanos, proto);
  }
  assert.throws(() => durationFromText("5"));
});
