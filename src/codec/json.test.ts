import assert from "node:assert/strict";
import { test } from "node:test";

import { compareUtf8, goJsonNumber, goJsonString, marshalGoJson, sortKeys } from "./json.js";

test("marshalGoJson sorts keys at every level and stays compact", () => {
  const out = marshalGoJson({ b: [{ z: 1, a: "x" }], a: { c: null, b: true } });
  assert.equal(out, '{"a":{"b":true,"c":null},"b":[{"a":"x","z":1}]}');
});

test("goJsonString escapes as Go does", () => {
  const cases: [string, string][] = [
    ["plain", '"plain"'],
    ['q"b\\', '"q\\"b\\\\"'],
    ["<a>&", '"\\u003ca\\u003e\\u0026"'],
    ["\n\r\t\b\f", '"\\n\\r\\t\\b\\f"'],
    ["\u0001\u001f", '"\\u0001\\u001f"'],
    ["  ", '"\\u2028\\u2029"'],
    ["é€😀", '"é€😀"'],
    ["\ud800", '"\\ufffd"'],
    ["\x7f", '"\x7f"'],
  ];
  for (const [input, want] of cases) assert.equal(goJsonString(input), want, JSON.stringify(input));
});

test("goJsonNumber pads the exponent like Go", () => {
  const cases: [number, string][] = [
    [0, "0"],
    [-3, "-3"],
    [1.5, "1.5"],
    [1e21, "1e+21"],
    [1.5e22, "1.5e+22"],
    [1e-7, "1e-07"],
    [123456789012345680000, "123456789012345680000"],
  ];
  for (const [input, want] of cases) assert.equal(goJsonNumber(input), want);
  assert.throws(() => goJsonNumber(Number.NaN), RangeError);
});

test("compareUtf8 orders by code point, not UTF-16 unit", () => {
  assert.equal(compareUtf8("a", "b"), -1);
  assert.equal(compareUtf8("ab", "a"), 1);
  assert.equal(compareUtf8("", ""), 0);
  // U+FF5E (BMP) sorts before U+1F600 (astral) in UTF-8, after it in UTF-16 units.
  assert.equal(compareUtf8("～", "\u{1f600}"), -1);
  assert.equal(["\u{1f600}", "～"].sort(compareUtf8).join(""), "～\u{1f600}");
});

test("sortKeys does not alter arrays or scalars", () => {
  assert.deepEqual(sortKeys({ b: [3, { y: 1, x: 2 }], a: "s" }), { a: "s", b: [3, { x: 2, y: 1 }] });
});
