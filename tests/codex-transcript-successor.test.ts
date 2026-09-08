// 同一 wrapper 内で codex TUI が新会話へ切り替わったとき (restart / new chat) に、
// session_id 施錠を「固有 originator + 作成時刻」 で検証して追従する選択ロジックのテスト。
// 2026-09-08 の実害 (PTY 生存のまま relay が旧会話に張り付く) の再発防止。
//
// 鉄のルールの担保: 別 wrapper / 別 cwd / exec / subagent / 曖昧 (同時刻) / mtime 推測へは
// 絶対に降りない。ここが破れると crosstalk が復活する。

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  findCodexTranscriptSuccessor,
  type CodexTranscriptCandidate,
} from "../src/codex-transcript-successor.js";

const OWNER = "sess-owner-1";
const ORIGINATOR = `lictor:${OWNER}`;

function meta(payload: Record<string, unknown>, timestamp: string): string {
  return JSON.stringify({ timestamp, type: "session_meta", payload });
}

function candidate(
  path: string,
  sessionId: string,
  timestamp: string,
  extra: Record<string, unknown> = {},
): CodexTranscriptCandidate {
  return {
    path,
    firstLine: meta(
      { session_id: sessionId, originator: ORIGINATOR, source: "cli", ...extra },
      timestamp,
    ),
  };
}

const CURRENT = candidate("/r/old.jsonl", "old-id", "2026-09-08T05:57:01.235Z");

test("同一 wrapper の新しい CLI 会話へ追従する", () => {
  const next = candidate("/r/new.jsonl", "new-id", "2026-09-08T10:39:14.633Z");
  const found = findCodexTranscriptSuccessor(CURRENT, [CURRENT, next], OWNER, ORIGINATOR);
  assert.deepEqual(found, {
    path: "/r/new.jsonl",
    sessionId: "new-id",
    startedAt: Date.parse("2026-09-08T10:39:14.633Z"),
  });
});

test("source が variant オブジェクト形式 ({ cli: {} }) でも追従する", () => {
  const next: CodexTranscriptCandidate = {
    path: "/r/new.jsonl",
    firstLine: meta(
      { session_id: "new-id", originator: ORIGINATOR, source: { cli: {} } },
      "2026-09-08T10:39:14.633Z",
    ),
  };
  const current: CodexTranscriptCandidate = {
    path: CURRENT.path,
    firstLine: meta(
      { session_id: "old-id", originator: ORIGINATOR, source: { cli: {} } },
      "2026-09-08T05:57:01.235Z",
    ),
  };
  assert.equal(
    findCodexTranscriptSuccessor(current, [current, next], OWNER, ORIGINATOR)?.sessionId,
    "new-id",
  );
});

test("最新が複数あるときは最も新しい会話を選ぶ", () => {
  const mid = candidate("/r/mid.jsonl", "mid-id", "2026-09-08T08:00:00.000Z");
  const newest = candidate("/r/newest.jsonl", "newest-id", "2026-09-08T10:39:14.633Z");
  assert.equal(
    findCodexTranscriptSuccessor(CURRENT, [CURRENT, mid, newest], OWNER, ORIGINATOR)?.sessionId,
    "newest-id",
  );
});

test("originator が期待値と違う (別 wrapper / 共有 originator) なら追従しない", () => {
  const next = candidate("/r/new.jsonl", "new-id", "2026-09-08T10:39:14.633Z");
  // 呼び出し側の期待値がそもそも自分のマーカーでない (custom originator 運用)。
  assert.equal(findCodexTranscriptSuccessor(CURRENT, [CURRENT, next], OWNER, "codex_cli_rs"), null);
  assert.equal(findCodexTranscriptSuccessor(CURRENT, [CURRENT, next], OWNER, null), null);
  assert.equal(findCodexTranscriptSuccessor(CURRENT, [CURRENT, next], "", ORIGINATOR), null);
  // 候補側が別 wrapper のマーカーを持つ。
  const foreign: CodexTranscriptCandidate = {
    path: "/r/foreign.jsonl",
    firstLine: meta(
      { session_id: "foreign-id", originator: "lictor:other", source: "cli" },
      "2026-09-08T10:39:14.633Z",
    ),
  };
  assert.equal(findCodexTranscriptSuccessor(CURRENT, [CURRENT, foreign], OWNER, ORIGINATOR), null);
});

test("exec / subagent / parent_thread_id 付き rollout へは追従しない", () => {
  const ts = "2026-09-08T10:39:14.633Z";
  const exec: CodexTranscriptCandidate = {
    path: "/r/exec.jsonl",
    firstLine: meta({ session_id: "exec-id", originator: ORIGINATOR, source: "exec" }, ts),
  };
  const subagent = candidate("/r/sub.jsonl", "sub-id", ts, { thread_source: "subagent" });
  const child = candidate("/r/child.jsonl", "child-id", ts, { parent_thread_id: "old-id" });
  const subVariant: CodexTranscriptCandidate = {
    path: "/r/subv.jsonl",
    firstLine: meta({ session_id: "subv-id", originator: ORIGINATOR, source: { subagent: {} } }, ts),
  };
  for (const bad of [exec, subagent, child, subVariant]) {
    assert.equal(findCodexTranscriptSuccessor(CURRENT, [CURRENT, bad], OWNER, ORIGINATOR), null);
  }
});

test("作成時刻が同点の候補が並ぶときは曖昧として追従しない", () => {
  const ts = "2026-09-08T10:39:14.633Z";
  const a = candidate("/r/a.jsonl", "a-id", ts);
  const b = candidate("/r/b.jsonl", "b-id", ts);
  assert.equal(findCodexTranscriptSuccessor(CURRENT, [CURRENT, a, b], OWNER, ORIGINATOR), null);
});

test("現束縛より古い会話 (mtime が新しくても) へは降りない", () => {
  const older = candidate("/r/older.jsonl", "older-id", "2026-09-08T01:00:00.000Z");
  assert.equal(findCodexTranscriptSuccessor(CURRENT, [CURRENT, older], OWNER, ORIGINATOR), null);
  // 同一 session_id の再出現 (同じ会話) も切替対象にならない。
  const same = candidate("/r/same.jsonl", "old-id", "2026-09-08T10:39:14.633Z");
  assert.equal(findCodexTranscriptSuccessor(CURRENT, [CURRENT, same], OWNER, ORIGINATOR), null);
});

test("メタが欠損 / 壊れている候補は無視し、現束縛が読めなければ追従しない", () => {
  const ts = "2026-09-08T10:39:14.633Z";
  const broken: CodexTranscriptCandidate = { path: "/r/broken.jsonl", firstLine: "{partial" };
  const empty: CodexTranscriptCandidate = { path: "/r/empty.jsonl", firstLine: null };
  const notMeta: CodexTranscriptCandidate = {
    path: "/r/notmeta.jsonl",
    firstLine: JSON.stringify({ type: "response_item", payload: {} }),
  };
  const noTs: CodexTranscriptCandidate = {
    path: "/r/nots.jsonl",
    firstLine: JSON.stringify({
      type: "session_meta",
      payload: { session_id: "x", originator: ORIGINATOR, source: "cli" },
    }),
  };
  assert.equal(
    findCodexTranscriptSuccessor(CURRENT, [CURRENT, broken, empty, notMeta, noTs], OWNER, ORIGINATOR),
    null,
  );
  // 現束縛のメタが読めないうちは切替判断そのものを保留する。
  const good = candidate("/r/new.jsonl", "new-id", ts);
  assert.equal(findCodexTranscriptSuccessor(broken, [broken, good], OWNER, ORIGINATOR), null);
});

test("連続した会話切替は 1 段ずつ前進する", () => {
  const first = candidate("/r/1.jsonl", "id-1", "2026-09-08T10:00:00.000Z");
  const second = candidate("/r/2.jsonl", "id-2", "2026-09-08T11:00:00.000Z");
  const step1 = findCodexTranscriptSuccessor(CURRENT, [CURRENT, first], OWNER, ORIGINATOR);
  assert.equal(step1?.sessionId, "id-1");
  const step2 = findCodexTranscriptSuccessor(first, [CURRENT, first, second], OWNER, ORIGINATOR);
  assert.equal(step2?.sessionId, "id-2");
  // さらに新しい会話が無ければ現束縛のまま。
  assert.equal(findCodexTranscriptSuccessor(second, [CURRENT, first, second], OWNER, ORIGINATOR), null);
});
