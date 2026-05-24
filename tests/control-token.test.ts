import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ensureToken,
  extractToken,
  readToken,
  tokenLocation,
  tokenMatches,
} from "../src/control/token.js";

test("ensureToken generates a 64-hex token + persists", () => {
  const home = mkdtempSync(join(tmpdir(), "lictor-ctl-"));
  const t = ensureToken(home);
  assert.match(t, /^[a-f0-9]{64}$/);
  const onDisk = readFileSync(tokenLocation(home).path, "utf8").trim();
  assert.equal(onDisk, t);
  // re-call returns the same value (idempotent)
  assert.equal(ensureToken(home), t);
  rmSync(home, { recursive: true, force: true });
});

test("ensureToken rotates corrupt files", () => {
  const home = mkdtempSync(join(tmpdir(), "lictor-ctl-"));
  const loc = tokenLocation(home);
  // Pre-seed with garbage so ensureToken should rotate.
  // Note: dir doesn't exist yet — ensureToken creates it.
  ensureToken(home); // create dir + valid token
  writeFileSync(loc.path, "not-hex-and-too-short", "utf8");
  const rotated = ensureToken(home);
  assert.match(rotated, /^[a-f0-9]{64}$/);
  assert.notEqual(rotated, "not-hex-and-too-short");
  rmSync(home, { recursive: true, force: true });
});

test("readToken returns null when file absent", () => {
  const home = mkdtempSync(join(tmpdir(), "lictor-ctl-"));
  assert.equal(readToken(home), null);
  rmSync(home, { recursive: true, force: true });
});

test("readToken returns null on corrupt content", () => {
  const home = mkdtempSync(join(tmpdir(), "lictor-ctl-"));
  ensureToken(home);
  writeFileSync(tokenLocation(home).path, "garbage", "utf8");
  assert.equal(readToken(home), null);
  rmSync(home, { recursive: true, force: true });
});

test("tokenMatches is timing-safe and rejects length / format mismatches", () => {
  const a = "a".repeat(64);
  assert.equal(tokenMatches(a, a), true);
  assert.equal(tokenMatches(a, "b".repeat(64)), false);
  assert.equal(tokenMatches(a, "a".repeat(63)), false); // length mismatch
  assert.equal(tokenMatches(a, "Z".repeat(64)), false); // non-hex
  assert.equal(tokenMatches(a, ""), false);
  assert.equal(tokenMatches(a, null as unknown as string), false);
});

test("extractToken parses Bearer auth and X-Lictor-Token", () => {
  assert.equal(extractToken({ authorization: "Bearer abc" }), "abc");
  assert.equal(extractToken({ Authorization: "bearer xyz" }), "xyz");
  assert.equal(extractToken({ "x-lictor-token": "tok" }), "tok");
  assert.equal(extractToken({}), null);
  assert.equal(extractToken({ authorization: "Basic creds" }), null);
});
