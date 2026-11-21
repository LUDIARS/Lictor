import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { AgyConversationLog, bindAgyConversation, selectAgyConversation } from "../src/agy-binding.js";
import { readAgyRows } from "../src/agy-database.js";
import { AgyTerminalStatus } from "../src/agy-pty.js";
import { decodeAgyStep } from "../src/agy-steps.js";
import { startAgyTranscript } from "../src/agy-transcript.js";
import { AgyTurns, isUnsettledTail } from "../src/agy-turns.js";
import type { TranscriptFrameInput } from "../src/transcript-sink.js";
import { answer, prompt, tool } from "./fixtures/agy-transcript.js";

const OWN = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const requireBuiltin = createRequire(import.meta.url);

function streaming(id: string): string {
  return "I1121 07:29:23.530924 464 conversation_manager.go:1082] Streaming conversation " + id + "\n";
}

test("agy binding requires the process log, cwd mapping and a new presence lock", (t) => {
  const root = mkdtempSync(join(tmpdir(), "agy-binding-test-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const dir of ["cache", "presence", "conversations"]) mkdirSync(join(root, dir));
  const cwd = join(root, "workspace");
  const log = join(root, "own.log");
  writeFileSync(log, streaming(OWN).slice(0, -1));
  const reader = new AgyConversationLog(log);
  assert.deepEqual(reader.scan(), { id: null, caughtUp: false });
  appendFileSync(log, "\n");
  const id = reader.scan().id;
  assert.equal(id, OWN);
  for (const candidate of [OWN, OTHER]) {
    writeFileSync(join(root, "presence", candidate + ".lock"), "");
    writeFileSync(join(root, "conversations", candidate + ".db"), "");
  }
  const mapping = join(root, "cache", "last_conversations.json");
  writeFileSync(mapping, JSON.stringify({ [cwd]: OTHER }));
  assert.equal(bindAgyConversation(root, cwd, id, 0), null);
  writeFileSync(mapping, JSON.stringify({ [cwd]: OWN }));
  assert.equal(bindAgyConversation(root, cwd, id, 0)?.id, OWN);
  assert.equal(selectAgyConversation([OWN], OWN, 99, 100), null);
  assert.equal(selectAgyConversation([OWN, OTHER], OWN, 100, 100), null);
  appendFileSync(log, "I1121 07:29:23.600000 464 conversation_manager.go:1023] Stopping conversation\n");
  assert.deepEqual(reader.scan(), { id: null, caughtUp: true });
});

test("agy protobuf extraction uses displayed text and never emits thought, metadata or tool arguments", () => {
  assert.deepEqual(decodeAgyStep(prompt(2, "日本語\nhello", 1_700_000_000_045)), {
    kind: "user", idx: 2, text: "日本語\nhello", timestamp: 1_700_000_000_045,
  });
  assert.deepEqual(decodeAgyStep(answer(3, { response: "raw", rendered: "display" })), {
    kind: "assistant", idx: 3, status: 3, text: "display", published: true, hasToolCalls: false,
  });
  assert.equal(decodeAgyStep(answer(4)).kind, "assistant");
  assert.deepEqual(decodeAgyStep(tool(5, 3)), { kind: "tool", idx: 5, name: "run_command", id: "tool-call-1" });
  assert.deepEqual(decodeAgyStep({ ...answer(6), step_payload: Uint8Array.of(8, 15, 162, 1, 200, 1) }), {
    kind: "unreadable", idx: 6,
  });
  assert.equal(decodeAgyStep({ ...answer(7), step_format: 1 }).kind, "unreadable");
});

test("agy turns ignore resumed history, defer pending work and finalize one terminal response", () => {
  const turns = new AgyTurns(1_000);
  const commentary = answer(3, { response: "starting" });
  const final = answer(5, { response: "complete", rendered: "done" });
  assert.deepEqual(turns.consume([
    prompt(0, "old", 999), answer(1, { response: "old" }),
    prompt(2, "injected", 1_100), commentary, tool(4, 2),
  ], 32, 1_200, null), [
    { kind: "text", payload: { role: "user", text: "injected" } },
    { kind: "text", payload: { role: "assistant", text: "starting", phase: "commentary" } },
  ]);
  assert.equal(turns.cursor, 3);
  assert.deepEqual(turns.consume([tool(4, 3), final], 32, 1_500, null), [
    { kind: "tool-use", payload: { role: "assistant", name: "run_command", tool_use_id: "tool-call-1" } },
  ]);
  assert.equal(turns.cursor, 4);
  assert.deepEqual(turns.consume([final], 32, 3_499, null), []);
  assert.deepEqual(turns.consume([final], 32, 3_500, null), [
    { kind: "text", payload: { role: "assistant", text: "done", phase: "final_answer" } },
  ]);
  assert.deepEqual(turns.consume([], 32, 3_900, 3_899), []);
});

test("agy tail answer without text is unsettled only while it has no successor", () => {
  const empty = decodeAgyStep(answer(3));
  const filled = decodeAgyStep(answer(3, { response: "hello" }));
  const working = decodeAgyStep({ ...answer(3, { response: "hello" }), status: 4 });
  const queued = decodeAgyStep(answer(3, { tool: true }));
  assert.ok(empty.kind === "assistant" && filled.kind === "assistant" && working.kind === "assistant" && queued.kind === "assistant");
  assert.equal(isUnsettledTail(empty, undefined), true);
  assert.equal(isUnsettledTail(working, undefined), true);
  assert.equal(isUnsettledTail(filled, undefined), false);
  assert.equal(isUnsettledTail(queued, undefined), false);
  assert.equal(isUnsettledTail(empty, tool(4, 3)), false);
});

test("agy turns re-read a tail answer that was marked done before its text arrived", () => {
  const turns = new AgyTurns(1_000);
  assert.deepEqual(turns.consume([prompt(0, "hi", 1_100), answer(1)], 32, 1_200, null), [
    { kind: "text", payload: { role: "user", text: "hi" } },
  ]);
  assert.equal(turns.cursor, 0);
  const filled = answer(1, { response: "hello" });
  assert.deepEqual(turns.consume([filled], 32, 1_300, null), []);
  assert.equal(turns.cursor, 0);
  assert.deepEqual(turns.consume([filled], 32, 1_400, 1_350), [
    { kind: "text", payload: { role: "assistant", text: "hello", phase: "final_answer" } },
  ]);
  assert.equal(turns.cursor, 1);
  assert.deepEqual(turns.consume([], 32, 1_500, 1_350), []);

  const followed = new AgyTurns(1_000);
  followed.consume([prompt(0, "hi", 1_100), answer(1)], 32, 1_200, null);
  assert.deepEqual(followed.consume([answer(1, { response: "hello" }), prompt(2, "next", 1_600)], 32, 1_700, null), [
    { kind: "text", payload: { role: "assistant", text: "hello", phase: "final_answer" } },
    { kind: "text", payload: { role: "user", text: "next" } },
  ]);
  assert.equal(followed.cursor, 2);
});

test("agy turns hold a generating (status 8) tail answer until it settles as done with text", () => {
  for (const fields of [{}, { response: "partial" }]) {
    const turns = new AgyTurns(1_000);
    assert.deepEqual(turns.consume([prompt(0, "hi", 1_100), { ...answer(1, fields), status: 8 }], 32, 1_200, 1_150), [
      { kind: "text", payload: { role: "user", text: "hi" } },
    ]);
    assert.equal(turns.cursor, 0);
    assert.deepEqual(turns.consume([{ ...answer(1, { response: "partial" }), status: 8 }], 32, 1_300, 1_250), []);
    assert.equal(turns.cursor, 0);
    const done = answer(1, { response: "hello" });
    assert.deepEqual(turns.consume([done], 32, 1_400, 1_350), [
      { kind: "text", payload: { role: "assistant", text: "hello", phase: "final_answer" } },
    ]);
    assert.equal(turns.cursor, 1);
    assert.deepEqual(turns.consume([], 32, 1_500, 1_450), []);
  }
});

test("agy turns skip an empty answer that already has a successor", () => {
  const turns = new AgyTurns(1_000);
  assert.deepEqual(turns.consume([prompt(0, "hi", 1_100), answer(1), tool(2, 3)], 32, 1_200, null), [
    { kind: "text", payload: { role: "user", text: "hi" } },
    { kind: "tool-use", payload: { role: "assistant", name: "run_command", tool_use_id: "tool-call-1" } },
  ]);
  assert.equal(turns.cursor, 2);
});

test("agy terminal state ignores unrelated, split or incomplete OSC 7501 reports", () => {
  const state = new AgyTerminalStatus();
  const phases: string[] = [];
  const note = (value: string) => phases.push(value);
  state.push("other text\x1b]", note);
  state.push("7501;state=working:app=agy\x07\x1b]7501;state=done:id=child\x07", note);
  state.push("\x1b]7501;state=done:app=agy\x1b", note);
  assert.deepEqual(phases, ["working"]);
  state.push("\\", note);
  assert.deepEqual(phases, ["working", "done"]);
});

test("agy relay reads an uncheckpointed SQLite WAL, signals input acceptance and emits ordered frames", async (t) => {
  let sqlite: typeof import("node:sqlite");
  try { sqlite = requireBuiltin("node:sqlite"); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ERR_UNKNOWN_BUILTIN_MODULE") throw error;
    t.skip("node:sqlite requires Node.js 22.13 or newer");
    return;
  }
  const root = mkdtempSync(join(tmpdir(), "agy-wal-test-"));
  for (const dir of ["cache", "presence", "conversations"]) mkdirSync(join(root, dir));
  const cwd = join(root, "workspace");
  const logPath = join(root, "own.log");
  writeFileSync(logPath, streaming(OWN));
  writeFileSync(join(root, "cache", "last_conversations.json"), JSON.stringify({ [cwd]: OWN }));
  writeFileSync(join(root, "presence", OWN + ".lock"), "");
  const path = join(root, "conversations", OWN + ".db");
  const db = new sqlite.DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL; PRAGMA wal_autocheckpoint = 0;"
    + " CREATE TABLE steps(idx INTEGER PRIMARY KEY, step_type INTEGER, status INTEGER, step_format INTEGER, metadata BLOB, step_payload BLOB)");
  const insert = db.prepare("INSERT INTO steps VALUES (?, ?, ?, ?, ?, ?)");
  for (const row of [prompt(0, "remote prompt", 100), answer(1, { response: "terminal answer" })]) {
    insert.run(row.idx, row.step_type, row.status, row.step_format, row.metadata, row.step_payload);
  }
  assert.equal(readAgyRows(path, -1, 32).length, 2);
  const relayed: TranscriptFrameInput[] = [];
  let accepted = 0;
  const tail = startAgyTranscript({
    root, cwd, launch: { logPath, spawnedAt: 0, dispose() {} }, pollMs: 5,
    send: async (frame) => { relayed.push(frame); },
    onUserMessage: () => { accepted++; },
    warn: (message) => assert.fail(message),
  });
  t.after(() => {
    tail.stop();
    db.close();
    rmSync(root, { recursive: true, force: true });
  });
  tail.observeTerminal?.("\x1b]7501;state=working\x07\x1b]7501;state=done\x07");
  for (let attempt = 0; attempt < 50 && relayed.length < 2; attempt++) await delay(10);
  assert.equal(accepted, 1);
  assert.deepEqual(relayed, [
    { kind: "text", payload: { role: "user", text: "remote prompt" } },
    { kind: "text", payload: { role: "assistant", text: "terminal answer", phase: "final_answer" } },
  ]);
  assert.deepEqual(tail.readRecent(10).frames, relayed);
});
