import { test } from "node:test";
import assert from "node:assert/strict";
import { buildAnswerSequence, sanitizeKeySeq, sanitizeSlashCmd } from "../src/sidecar.js";

test("sanitizeSlashCmd accepts valid names", () => {
  assert.equal(sanitizeSlashCmd("clear"), "clear");
  assert.equal(sanitizeSlashCmd("/clear"), "clear");
  assert.equal(sanitizeSlashCmd("//compact"), "compact");
  assert.equal(sanitizeSlashCmd(" model "), "model");
  assert.equal(sanitizeSlashCmd("foo-bar-baz"), "foo-bar-baz");
});

test("sanitizeSlashCmd rejects invalid names", () => {
  assert.equal(sanitizeSlashCmd(""), null);
  assert.equal(sanitizeSlashCmd("with space"), null);
  assert.equal(sanitizeSlashCmd("1starts"), null);
  assert.equal(sanitizeSlashCmd("../etc"), null);
  assert.equal(sanitizeSlashCmd("CAPS"), "caps"); // case folded
  assert.equal(sanitizeSlashCmd("$inject"), null);
  assert.equal(sanitizeSlashCmd("a".repeat(50)), null);
});

test("sanitizeKeySeq allows TUI-relevant controls", () => {
  // \b \t \n \r \x1b 7f are kept
  assert.equal(sanitizeKeySeq("a\rb"), "a\rb");
  assert.equal(sanitizeKeySeq("\x1b[B"), "\x1b[B");
  assert.equal(sanitizeKeySeq("hello\t"), "hello\t");
  assert.equal(sanitizeKeySeq("x\x7f"), "x\x7f");
});

test("sanitizeKeySeq strips dangerous controls (incl. Ctrl-C)", () => {
  // \x00, \x03 (SIGINT), \x07 (BEL), \x0b, \x1c-\x1f get dropped
  assert.equal(sanitizeKeySeq("a\x03b"), "ab");
  assert.equal(sanitizeKeySeq("a\x00\x01\x07b"), "ab");
  assert.equal(sanitizeKeySeq("a\x1c\x1d\x1e\x1fb"), "ab");
});

test("sanitizeKeySeq preserves UTF-8 multibyte", () => {
  assert.equal(sanitizeKeySeq("日本語😀"), "日本語😀");
});

test("buildAnswerSequence: choice 1 is just Enter", () => {
  assert.equal(buildAnswerSequence(1), "\r");
});

test("buildAnswerSequence: choice 3 is two Down + Enter", () => {
  assert.equal(buildAnswerSequence(3), "\x1b[B\x1b[B\r");
});

test("buildAnswerSequence: escape_first prepends ESC", () => {
  assert.equal(buildAnswerSequence(2, true), "\x1b\x1b[B\r");
});

test("buildAnswerSequence: throws on bad choice", () => {
  assert.throws(() => buildAnswerSequence(0), /integer in \[1, 50\]/);
  assert.throws(() => buildAnswerSequence(-1), /integer in \[1, 50\]/);
  assert.throws(() => buildAnswerSequence(1.5), /integer in \[1, 50\]/);
  assert.throws(() => buildAnswerSequence(100), /integer in \[1, 50\]/);
});
