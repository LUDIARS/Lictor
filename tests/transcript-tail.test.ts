import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, statSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { lineToFrame, tryClaimJsonl, readRecentFromFile } from "../src/transcript-tail.js";

test("lineToFrame: assistant text → text frame", () => {
  const f = lineToFrame(JSON.stringify({
    type: "assistant",
    uuid: "msg-1",
    message: { role: "assistant", content: [{ type: "text", text: "hello world" }] },
  }));
  assert.deepEqual(f, { kind: "text", payload: { role: "assistant", text: "hello world", claude_uuid: "msg-1" } });
});

test("lineToFrame: user text → text frame", () => {
  const f = lineToFrame(JSON.stringify({
    type: "user",
    uuid: "msg-2",
    message: { role: "user", content: [{ type: "text", text: "do the thing" }] },
  }));
  assert.deepEqual(f, { kind: "text", payload: { role: "user", text: "do the thing", claude_uuid: "msg-2" } });
});

test("lineToFrame: text frame includes null claude_uuid when missing", () => {
  const f = lineToFrame(JSON.stringify({
    type: "assistant",
    message: { content: [{ type: "text", text: "no-uuid" }] },
  }));
  assert.deepEqual(f, { kind: "text", payload: { role: "assistant", text: "no-uuid", claude_uuid: null } });
});

test("lineToFrame: tool_use → tool-use frame with input preview", () => {
  const f = lineToFrame(JSON.stringify({
    type: "assistant",
    message: { content: [{ type: "tool_use", name: "Bash", input: { command: "ls", description: "list" } }] },
  }));
  assert.equal(f?.kind, "tool-use");
  const payload = f?.payload as { name: string; input_preview: string };
  assert.equal(payload.name, "Bash");
  assert.match(payload.input_preview, /"command":"ls"/);
});

test("lineToFrame: tool_result with is_error preserved", () => {
  const f = lineToFrame(JSON.stringify({
    type: "user",
    message: { content: [{ type: "tool_result", tool_use_id: "abc123", is_error: true, content: "failed" }] },
  }));
  assert.equal(f?.kind, "tool-result");
  const payload = f?.payload as { tool_use_id: string; is_error: boolean; preview: string };
  assert.equal(payload.tool_use_id, "abc123");
  assert.equal(payload.is_error, true);
  assert.equal(payload.preview, "failed");
});

test("lineToFrame: thinking → thinking frame (preview capped at 400)", () => {
  const long = "x".repeat(1000);
  const f = lineToFrame(JSON.stringify({
    type: "assistant",
    message: { content: [{ type: "thinking", thinking: long }] },
  }));
  assert.equal(f?.kind, "thinking");
  const payload = f?.payload as { preview: string };
  assert.equal(payload.preview.length, 400);
});

test("lineToFrame: summary → summary frame", () => {
  const f = lineToFrame(JSON.stringify({ type: "summary", summary: "a quick recap" }));
  assert.deepEqual(f, { kind: "summary", payload: { text: "a quick recap" } });
});

test("lineToFrame: unknown type → raw frame", () => {
  const f = lineToFrame(JSON.stringify({ type: "weirdo", weird: "stuff" }));
  assert.equal(f?.kind, "raw");
  const payload = f?.payload as { type: string; keys: string[] };
  assert.equal(payload.type, "weirdo");
  assert.deepEqual(payload.keys.sort(), ["type", "weird"]);
});

test("lineToFrame: malformed JSON returns null", () => {
  assert.equal(lineToFrame("not-json"), null);
  assert.equal(lineToFrame(""), null);
});

test("lineToFrame: non-object JSON returns null", () => {
  assert.equal(lineToFrame("42"), null);
  assert.equal(lineToFrame("null"), null);
});

// ─── Codex CLI 形式 (rollout-*.jsonl) ──────────────────────────────────
//
// Codex は `{timestamp, type, payload}` の三段構成で、 user 発言は
// event_msg.user_message / response_item.message+role=user の両方に出る.
// 重複は許容して両方流す方針.

test("lineToFrame: codex event_msg.user_message → text frame (user)", () => {
  const f = lineToFrame(JSON.stringify({
    timestamp: "2026-05-26T21:44:35.329Z",
    type: "event_msg",
    payload: { type: "user_message", message: "こんにちは", images: [] },
  }));
  assert.deepEqual(f, { kind: "text", payload: { role: "user", text: "こんにちは" } });
});

test("lineToFrame: codex event_msg.agent_message → text frame (assistant)", () => {
  const f = lineToFrame(JSON.stringify({
    timestamp: "2026-05-26T21:44:40.325Z",
    type: "event_msg",
    payload: { type: "agent_message", message: "了解しました", phase: "commentary" },
  }));
  assert.deepEqual(f, { kind: "text", payload: { role: "assistant", text: "了解しました" } });
});

test("lineToFrame: codex response_item.message(role=user,input_text) → text frame", () => {
  const f = lineToFrame(JSON.stringify({
    timestamp: "2026-05-26T21:44:35.329Z",
    type: "response_item",
    payload: {
      type: "message",
      role: "user",
      content: [{ type: "input_text", text: "ユーザの入力" }],
    },
  }));
  assert.deepEqual(f, { kind: "text", payload: { role: "user", text: "ユーザの入力" } });
});

test("lineToFrame: codex response_item.message(role=assistant,output_text) → text frame", () => {
  const f = lineToFrame(JSON.stringify({
    timestamp: "2026-05-26T21:44:40.325Z",
    type: "response_item",
    payload: {
      type: "message",
      role: "assistant",
      content: [{ type: "output_text", text: "AIの出力" }],
      phase: "commentary",
    },
  }));
  assert.deepEqual(f, { kind: "text", payload: { role: "assistant", text: "AIの出力" } });
});

test("lineToFrame: codex response_item.reasoning → thinking frame", () => {
  const f = lineToFrame(JSON.stringify({
    type: "response_item",
    payload: {
      type: "reasoning",
      summary: [],
      content: null,
      encrypted_content: "gAAAA...",
    },
  }));
  assert.equal(f?.kind, "thinking");
  const p = f?.payload as { role: string; preview: string };
  assert.equal(p.role, "assistant");
  assert.equal(p.preview, "(encrypted)");
});

test("lineToFrame: codex response_item.reasoning with summary preview", () => {
  const f = lineToFrame(JSON.stringify({
    type: "response_item",
    payload: {
      type: "reasoning",
      summary: ["仕様を確認した", { text: "次にビルドを試す" }],
    },
  }));
  assert.equal(f?.kind, "thinking");
  const p = f?.payload as { preview: string };
  assert.equal(p.preview, "仕様を確認した 次にビルドを試す");
});

test("lineToFrame: codex response_item.message with developer role falls through to raw", () => {
  // role=developer/system は user/assistant ではないので text 化せず raw に落とす.
  const f = lineToFrame(JSON.stringify({
    type: "response_item",
    payload: {
      type: "message",
      role: "developer",
      content: [{ type: "input_text", text: "<permissions instructions>..." }],
    },
  }));
  assert.equal(f?.kind, "raw");
});

test("lineToFrame: codex session_meta is raw", () => {
  const f = lineToFrame(JSON.stringify({
    timestamp: "2026-05-26T21:44:34.646Z",
    type: "session_meta",
    payload: { id: "019e663d-...", cwd: "E:\\Document\\Ars" },
  }));
  assert.equal(f?.kind, "raw");
});

test("lineToFrame: codex multi-part content joins with newline", () => {
  const f = lineToFrame(JSON.stringify({
    type: "response_item",
    payload: {
      type: "message",
      role: "user",
      content: [
        { type: "input_text", text: "first" },
        { type: "input_text", text: "second" },
      ],
    },
  }));
  assert.deepEqual(f, { kind: "text", payload: { role: "user", text: "first\nsecond" } });
});

// ─── tryClaimJsonl: 並走 wrapper の jsonl pick 排他 ───────────────────
//
// 同 cwd で複数 lictor wrapper が並走するとき、 mtime 最新の jsonl を全 wrapper
// が pick すると「他セッションの transcript を自分の session_id で Concordia に
// 送る」 race が発生し、 AI 応答が別 channel に混在する. それを防ぐための
// `<path>.lictor-claim` の atomic create を unit test で固定する.

test("tryClaimJsonl: 初回は claim 取得、 同 path への 2 回目は null", () => {
  const dir = mkdtempSync(join(tmpdir(), "lictor-claim-"));
  try {
    const jsonl = join(dir, "abc.jsonl");
    writeFileSync(jsonl, "");
    const first = tryClaimJsonl(jsonl);
    assert.ok(first, "first claim should succeed");
    assert.equal(first, `${jsonl}.lictor-claim`);
    assert.ok(existsSync(first));

    const second = tryClaimJsonl(jsonl);
    assert.equal(second, null, "second claim on same path returns null while first holder is alive");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("tryClaimJsonl: claim 解放後は再取得可能", () => {
  const dir = mkdtempSync(join(tmpdir(), "lictor-claim-"));
  try {
    const jsonl = join(dir, "abc.jsonl");
    writeFileSync(jsonl, "");
    const first = tryClaimJsonl(jsonl);
    assert.ok(first);
    unlinkSync(first); // wrapper 終了相当

    const second = tryClaimJsonl(jsonl);
    assert.ok(second, "claim is available again after release");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("tryClaimJsonl: stale claim (1h 以上) は剥がして再取得する", () => {
  const dir = mkdtempSync(join(tmpdir(), "lictor-claim-"));
  try {
    const jsonl = join(dir, "abc.jsonl");
    writeFileSync(jsonl, "");
    const claim = `${jsonl}.lictor-claim`;
    writeFileSync(claim, "");
    // mtime を 2h 前に巻き戻す
    const old = (Date.now() - 2 * 60 * 60 * 1000) / 1000;
    utimesSync(claim, old, old);

    const acquired = tryClaimJsonl(jsonl);
    assert.equal(acquired, claim, "stale claim is reclaimed");
    // mtime を再確認: 直前に新規 create されているので now 近辺
    const fresh = statSync(claim).mtimeMs;
    assert.ok(Date.now() - fresh < 5000, "claim file is freshly recreated");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("tryClaimJsonl: 2 候補 jsonl で並走 wrapper が別 jsonl を pick できる", () => {
  // 同じ cwd で複数 lictor wrapper が並走するシナリオ. wrapper A が先に
  // 新しい方の jsonl を claim 済 → wrapper B は次点 (古い方) を pick できる.
  const dir = mkdtempSync(join(tmpdir(), "lictor-claim-"));
  try {
    const jsonlA = join(dir, "a.jsonl");
    const jsonlB = join(dir, "b.jsonl");
    writeFileSync(jsonlA, "");
    writeFileSync(jsonlB, "");

    const claimA = tryClaimJsonl(jsonlA);
    assert.ok(claimA, "wrapper A claims jsonl A");

    // wrapper B が A は claim 失敗、 B を pick する
    const failA = tryClaimJsonl(jsonlA);
    assert.equal(failA, null);
    const claimB = tryClaimJsonl(jsonlB);
    assert.ok(claimB, "wrapper B claims jsonl B");
    assert.notEqual(claimA, claimB);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ─── readRecentFromFile: GET /v1/transcript の実体 ───────────────────────
//
// transcript-tail は通常 push だけだが、 ローカルから直近を引く読み出し口を
// 提供する純関数. 末尾 N 行 → frame / 生オブジェクト変換 + 母数カウントを固定.

function writeJsonl(dir: string, name: string, objs: unknown[]): string {
  const p = join(dir, name);
  writeFileSync(p, objs.map((o) => JSON.stringify(o)).join("\n") + "\n");
  return p;
}

test("readRecentFromFile: path=null は available:false", () => {
  const r = readRecentFromFile(null, 10, false);
  assert.deepEqual(r, { path: null, available: false, total_lines: 0, returned: 0 });
});

test("readRecentFromFile: 存在しない path は available:false (path は返す)", () => {
  const dir = mkdtempSync(join(tmpdir(), "lictor-tr-"));
  try {
    const missing = join(dir, "nope.jsonl");
    const r = readRecentFromFile(missing, 10, false);
    assert.equal(r.available, false);
    assert.equal(r.path, missing);
    assert.equal(r.returned, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("readRecentFromFile: 末尾 N 行を古い順で frame 化する", () => {
  const dir = mkdtempSync(join(tmpdir(), "lictor-tr-"));
  try {
    const p = writeJsonl(dir, "s.jsonl", [
      { type: "assistant", message: { content: [{ type: "text", text: "one" }] } },
      { type: "assistant", message: { content: [{ type: "text", text: "two" }] } },
      { type: "assistant", message: { content: [{ type: "text", text: "three" }] } },
    ]);
    const r = readRecentFromFile(p, 2, false);
    assert.equal(r.available, true);
    assert.equal(r.total_lines, 3);
    assert.equal(r.returned, 2);
    assert.ok(r.frames);
    const texts = r.frames!.map((f) => (f.payload as { text: string }).text);
    assert.deepEqual(texts, ["two", "three"]); // 古い順 (tail の前半→後半)
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("readRecentFromFile: limit > 行数 は全件返す", () => {
  const dir = mkdtempSync(join(tmpdir(), "lictor-tr-"));
  try {
    const p = writeJsonl(dir, "s.jsonl", [
      { type: "summary", summary: "a" },
      { type: "summary", summary: "b" },
    ]);
    const r = readRecentFromFile(p, 100, false);
    assert.equal(r.total_lines, 2);
    assert.equal(r.returned, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("readRecentFromFile: raw=true はパース済の生オブジェクトを返す", () => {
  const dir = mkdtempSync(join(tmpdir(), "lictor-tr-"));
  try {
    const p = writeJsonl(dir, "s.jsonl", [
      { type: "event_msg", payload: { type: "agent_message", message: "hi" } },
    ]);
    const r = readRecentFromFile(p, 10, true);
    assert.equal(r.available, true);
    assert.equal(r.returned, 1);
    assert.equal(r.frames, undefined);
    assert.ok(r.lines);
    const obj = r.lines![0] as { type: string; payload: { message: string } };
    assert.equal(obj.type, "event_msg");
    assert.equal(obj.payload.message, "hi");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("readRecentFromFile: 空行はスキップし母数に含めない", () => {
  const dir = mkdtempSync(join(tmpdir(), "lictor-tr-"));
  try {
    const p = join(dir, "s.jsonl");
    writeFileSync(p, '{"type":"summary","summary":"x"}\n\n\n{"type":"summary","summary":"y"}\n');
    const r = readRecentFromFile(p, 10, false);
    assert.equal(r.total_lines, 2);
    assert.equal(r.returned, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("readRecentFromFile: raw=true で壊れた行は捨てる", () => {
  const dir = mkdtempSync(join(tmpdir(), "lictor-tr-"));
  try {
    const p = join(dir, "s.jsonl");
    writeFileSync(p, '{"type":"summary","summary":"ok"}\nnot-json\n');
    const r = readRecentFromFile(p, 10, true);
    assert.equal(r.total_lines, 2); // 母数は非空行数
    assert.equal(r.returned, 1);    // パースできた 1 件だけ
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
