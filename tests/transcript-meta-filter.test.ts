// Codex rollout の先頭行 session_meta による discover 候補フィルタのテスト。
// 「別ウインドウ / 別リポ / delegation (codex exec) の JSONL を mtime discover が
// 誤掴みして無関係なメッセージが混線する」 crosstalk (2026-07-02 報告) の再発防止。

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { codexTranscriptMetaAccepts, codexTranscriptMetaStartedAt, normalizePathForCompare, PROVIDERS } from "../src/provider.js";
import { readTranscriptFirstLine } from "../src/transcript-tail.js";

const CWD = "E:/Document/Ars";

function metaLine(payload: Record<string, unknown>): string {
  return JSON.stringify({ timestamp: "2026-07-02T00:00:00.000Z", type: "session_meta", payload });
}

test("codex provider wires transcriptMetaAccepts", () => {
  assert.equal(PROVIDERS.codex.transcriptMetaAccepts, codexTranscriptMetaAccepts);
  // claude は session pin で構造的に守られているためフィルタ不要。
  assert.equal(PROVIDERS.claude.transcriptMetaAccepts, undefined);
});

test("normalizePathForCompare: バックスラッシュ / 大文字小文字 / 末尾スラッシュを吸収", () => {
  assert.equal(normalizePathForCompare("E:\\Document\\Ars"), "e:/document/ars");
  assert.equal(normalizePathForCompare("e:/document/Ars/"), "e:/document/ars");
});

test("accepts: 同一 cwd の対話セッションは許可", () => {
  const line = metaLine({ session_id: "x", cwd: "E:\\Document\\Ars", originator: "codex_cli_rs", source: "cli" });
  assert.equal(codexTranscriptMetaAccepts(line, { cwd: CWD }), true);
});

test("rejects: cwd 不一致 (別リポのウインドウ) は除外", () => {
  const line = metaLine({ session_id: "x", cwd: "E:\\Document\\Ars\\Pagus", originator: "codex_cli_rs", source: "cli" });
  assert.equal(codexTranscriptMetaAccepts(line, { cwd: CWD }), false);
});

test("rejects: codex exec (delegation ヘッドレス実行) の rollout は cwd 一致でも除外", () => {
  const bySource = metaLine({ session_id: "x", cwd: "E:\\Document\\Ars", originator: "codex_exec", source: "exec" });
  assert.equal(codexTranscriptMetaAccepts(bySource, { cwd: CWD }), false);
  const byOriginator = metaLine({ session_id: "x", cwd: "E:\\Document\\Ars", originator: "codex_exec" });
  assert.equal(codexTranscriptMetaAccepts(byOriginator, { cwd: CWD }), false);
});

test("fail-open: parse 不能 / session_meta 以外 / cwd 欠落は許可 (claim ガードに委ねる)", () => {
  assert.equal(codexTranscriptMetaAccepts("not-json{", { cwd: CWD }), true);
  assert.equal(codexTranscriptMetaAccepts(JSON.stringify({ type: "message", payload: {} }), { cwd: CWD }), true);
  assert.equal(codexTranscriptMetaAccepts(metaLine({ session_id: "x" }), { cwd: CWD }), true);
  assert.equal(codexTranscriptMetaAccepts(JSON.stringify({ type: "session_meta", payload: null }), { cwd: CWD }), true);
});

test("head-ts filter: wrapper 起動より 60s 以上古い会話は除外 (スリープ復帰の奪い合い防止)", () => {
  const startedAtMs = new Date("2026-07-02T10:00:00.000Z").getTime();
  const oldLine = metaLine({
    cwd: "E:\\Document\\Ars", originator: "codex_cli_rs", source: "cli",
    timestamp: "2026-07-02T08:00:00.000Z",
  });
  assert.equal(codexTranscriptMetaAccepts(oldLine, { cwd: CWD, startedAtMs }), false);
  // startedAtMs 無指定 (旧呼び出し) は従来どおり許可
  assert.equal(codexTranscriptMetaAccepts(oldLine, { cwd: CWD }), true);
  // 猶予内 (起動直前) は許可
  const freshLine = metaLine({
    cwd: "E:\\Document\\Ars", originator: "codex_cli_rs", source: "cli",
    timestamp: "2026-07-02T09:59:30.000Z",
  });
  assert.equal(codexTranscriptMetaAccepts(freshLine, { cwd: CWD, startedAtMs }), true);
  // timestamp が一切読めないメタは fail-open (metaLine はトップレベル timestamp を
  // 持つため、 ここは素の JSON で組む)
  const noTs = JSON.stringify({
    type: "session_meta",
    payload: { cwd: "E:\\Document\\Ars", originator: "codex_cli_rs", source: "cli" },
  });
  assert.equal(codexTranscriptMetaAccepts(noTs, { cwd: CWD, startedAtMs }), true);
});

test("head-ts filter: LICTOR_CODEX_HEAD_TS_FILTER=0 で無効化できる (escape hatch)", () => {
  const prev = process.env.LICTOR_CODEX_HEAD_TS_FILTER;
  process.env.LICTOR_CODEX_HEAD_TS_FILTER = "0";
  try {
    const startedAtMs = new Date("2026-07-02T10:00:00.000Z").getTime();
    const oldLine = metaLine({
      cwd: "E:\\Document\\Ars", originator: "codex_cli_rs", source: "cli",
      timestamp: "2026-07-02T08:00:00.000Z",
    });
    assert.equal(codexTranscriptMetaAccepts(oldLine, { cwd: CWD, startedAtMs }), true);
  } finally {
    if (prev === undefined) delete process.env.LICTOR_CODEX_HEAD_TS_FILTER;
    else process.env.LICTOR_CODEX_HEAD_TS_FILTER = prev;
  }
});

test("codexTranscriptMetaStartedAt: payload.timestamp 優先、トップレベル fallback", () => {
  const payloadTs = metaLine({ cwd: CWD, timestamp: "2026-07-02T09:00:00.000Z" });
  assert.equal(codexTranscriptMetaStartedAt(payloadTs), new Date("2026-07-02T09:00:00.000Z").getTime());
  // metaLine はトップレベル timestamp (2026-07-02T00:00:00Z) を常に持つ
  const topOnly = metaLine({ cwd: CWD });
  assert.equal(codexTranscriptMetaStartedAt(topOnly), new Date("2026-07-02T00:00:00.000Z").getTime());
  assert.equal(codexTranscriptMetaStartedAt("not-json{"), null);
  assert.equal(codexTranscriptMetaStartedAt(JSON.stringify({ type: "message" })), null);
});

test("codex provider wires transcriptMetaStartedAt", () => {
  assert.equal(PROVIDERS.codex.transcriptMetaStartedAt, codexTranscriptMetaStartedAt);
});

test("readTranscriptFirstLine: 先頭行のみ返す / 無ファイルは null", () => {
  const dir = mkdtempSync(join(tmpdir(), "lictor-meta-"));
  try {
    const p = join(dir, "rollout.jsonl");
    writeFileSync(p, `${metaLine({ cwd: CWD })}\n{"type":"message"}\n`);
    const first = readTranscriptFirstLine(p);
    assert.ok(first);
    assert.equal(JSON.parse(first!).type, "session_meta");
    assert.equal(readTranscriptFirstLine(join(dir, "missing.jsonl")), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("readTranscriptFirstLine: 改行の無い巨大 1 行は maxBytes で打ち切って返す", () => {
  const dir = mkdtempSync(join(tmpdir(), "lictor-meta-"));
  try {
    const p = join(dir, "one-line.jsonl");
    writeFileSync(p, "a".repeat(20000));
    const first = readTranscriptFirstLine(p, 1024);
    assert.equal(first?.length, 1024);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
