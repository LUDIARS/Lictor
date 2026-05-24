import { test } from "node:test";
import assert from "node:assert/strict";
import { sanitizeTitle } from "../src/osc.js";

test("sanitizeTitle strips C0 controls", () => {
  assert.equal(sanitizeTitle("hello\x07world"), "helloworld");
  assert.equal(sanitizeTitle("a\x00b\x1bc"), "abc");
});

test("sanitizeTitle strips DEL", () => {
  assert.equal(sanitizeTitle("x\x7fy"), "xy");
});

test("sanitizeTitle caps length", () => {
  const long = "a".repeat(500);
  assert.equal(sanitizeTitle(long).length, 200);
});

test("sanitizeTitle preserves multibyte (Japanese, emoji)", () => {
  assert.equal(sanitizeTitle("[Ar] 作業中 🛠"), "[Ar] 作業中 🛠");
});
