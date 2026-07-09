import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { lineToFrame, tryClaimJsonl, refreshClaim, readRecentFromFile, startTranscriptTail, decideCodexInitialBind } from "../src/transcript-tail.js";
import { PROVIDERS, makeLocalLlmProvider } from "../src/provider.js";
import { claudeTranscriptStatePath } from "../src/active-repos.js";

const ONE_HOUR_MS = 60 * 60 * 1000;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

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

test("lineToFrame: local-agent {ts,role,content} assistant → text frame", () => {
  const f = lineToFrame(JSON.stringify({ ts: 1, role: "assistant", content: "ローカル応答" }));
  assert.deepEqual(f, { kind: "text", payload: { role: "assistant", text: "ローカル応答" } });
});

test("lineToFrame: local-agent {ts,role,content} user → text frame", () => {
  const f = lineToFrame(JSON.stringify({ ts: 2, role: "user", content: "質問" }));
  assert.deepEqual(f, { kind: "text", payload: { role: "user", text: "質問" } });
});

test("lineToFrame: local-agent system role → system frame", () => {
  const f = lineToFrame(JSON.stringify({ ts: 3, role: "system", content: "[hook] ctx" }));
  assert.deepEqual(f, { kind: "system", payload: { text: "[hook] ctx" } });
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
  assert.deepEqual(f, { kind: "text", payload: { role: "assistant", text: "了解しました", phase: "commentary" } });
});

test("lineToFrame: codex event_msg.agent_message keeps final_answer phase", () => {
  const f = lineToFrame(JSON.stringify({
    timestamp: "2026-07-08T07:00:00.000Z",
    type: "event_msg",
    payload: { type: "agent_message", message: "done", phase: "final_answer" },
  }));
  assert.deepEqual(f, { kind: "text", payload: { role: "assistant", text: "done", phase: "final_answer" } });
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
  assert.deepEqual(f, { kind: "text", payload: { role: "assistant", text: "AIの出力", phase: "commentary" } });
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

test("tryClaimJsonl: owner id を claim file に記録する", () => {
  const dir = mkdtempSync(join(tmpdir(), "lictor-claim-"));
  try {
    const jsonl = join(dir, "abc.jsonl");
    writeFileSync(jsonl, "");
    const cp = tryClaimJsonl(jsonl, ONE_HOUR_MS, "lictor-OWNER");
    assert.ok(cp);
    assert.equal(readFileSync(cp, "utf8"), "lictor-OWNER", "claim file records the owner session id");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("refreshClaim: active claim を refresh すると stale 判定で剥がされない", () => {
  const dir = mkdtempSync(join(tmpdir(), "lictor-claim-"));
  try {
    const jsonl = join(dir, "a.jsonl");
    writeFileSync(jsonl, "");
    const claim = `${jsonl}.lictor-claim`;
    writeFileSync(claim, "owner-A");
    // 2h 前に巻き戻す (stale 相当) → refresh で now に戻す
    const old = (Date.now() - 2 * ONE_HOUR_MS) / 1000;
    utimesSync(claim, old, old);
    refreshClaim(claim);
    // 別 wrapper (owner-B) が 1h stale 閾値で claim を試みても、 refresh 済なので奪えない
    const stolen = tryClaimJsonl(jsonl, ONE_HOUR_MS, "owner-B");
    assert.equal(stolen, null, "refreshed active claim is not stolen as stale");
    assert.equal(readFileSync(claim, "utf8"), "owner-A", "original owner still holds the claim");
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

// ─── pinned transcript path (session-id 固定束縛) ──────────────────────────
// `--session-id <uuid>` で固定したセッションは、 mtime 推測を一切せず自分の
// uuid の jsonl だけを claim する。 同 dir に「より新しい別 jsonl (= 並走別
// wrapper / 先行起動した非 Lictor claude)」 があっても掴まない (= 投稿が 1 つ
// ズレて別チャンネルに出る crosstalk が構造的に起きない) ことを固定する。
test("startTranscriptTail: pinnedTranscriptPath は自分の jsonl だけを claim し、 より新しい decoy を無視する", async () => {
  const dir = mkdtempSync(join(tmpdir(), "lictor-pin-"));
  try {
    // decoy: 別セッションの jsonl を「より新しい mtime」 で先に置く。
    const decoyUuid = "11111111-1111-4111-8111-111111111111";
    const decoyPath = join(dir, `${decoyUuid}.jsonl`);
    writeFileSync(decoyPath, '{"type":"assistant","message":{"content":[{"type":"text","text":"decoy"}]}}\n');
    const future = Date.now() / 1000 + 600; // 10 分未来 → mtime 最新
    utimesSync(decoyPath, future, future);

    // 自分の固定 uuid。 transcriptDir を temp dir に差し替えた provider を渡す。
    const ownUuid = "22222222-2222-4222-8222-222222222222";
    const pinnedPath = join(dir, `${ownUuid}.jsonl`);
    const provider = { ...PROVIDERS.claude, transcriptDir: () => dir };

    const tail = startTranscriptTail({
      cwd: dir,
      sessionId: "lictor-test-session",
      concordiaBaseUrl: "http://127.0.0.1:1", // 到達不能 → postFrame は黙って drop
      provider,
      pinnedTranscriptPath: pinnedPath,
    });
    try {
      // 固定ファイルはまだ無い → poll しても何も claim しない (decoy も掴まない)。
      await sleep(700);
      assert.equal(tail.getTranscriptPath(), null, "固定ファイル未生成の間は何も discover しない");
      assert.equal(existsSync(`${decoyPath}.lictor-claim`), false, "decoy を mtime で誤掴みしない");

      // 自分の jsonl が生成された → これだけを claim する。
      writeFileSync(pinnedPath, '{"type":"assistant","message":{"content":[{"type":"text","text":"mine"}]}}\n');
      await sleep(700);
      assert.equal(tail.getTranscriptPath(), pinnedPath, "固定 path を tail する");
      assert.equal(existsSync(`${pinnedPath}.lictor-claim`), true, "固定 path を claim する");
      assert.equal(existsSync(`${decoyPath}.lictor-claim`), false, "より新しい decoy は最後まで掴まない");
      assert.equal(tail.getSessionUuid(), ownUuid, "session uuid は固定 uuid を返す");
    } finally {
      tail.stop();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// `/clear` 後の束縛し直し: SessionStart hook が state ファイルに書いた実 transcript_path を
// transcript-tail が権威ソースとして読み、 起動時の computed pin (旧 JSONL) から新しい実
// JSONL へ追従する。 これをしないと `/clear` 後に中継 (transcript-frame) が止まる。
test("startTranscriptTail: hook の transcript_path 変化で実 JSONL へ束縛し直す", async () => {
  const dir = mkdtempSync(join(tmpdir(), "lictor-rebind-"));
  try {
    const sessionId = "lictor-rebind-session";
    const statePath = claudeTranscriptStatePath(dir, sessionId);
    const provider = { ...PROVIDERS.claude, transcriptDir: () => dir };

    const uuidA = "33333333-3333-4333-8333-333333333333";
    const pathA = join(dir, `${uuidA}.jsonl`);
    const uuidB = "44444444-4444-4444-8444-444444444444";
    const pathB = join(dir, `${uuidB}.jsonl`);

    // 起動時の computed pin = A。 hook も実 transcript_path として A を報告。
    writeFileSync(statePath, pathA);
    const tail = startTranscriptTail({
      cwd: dir,
      sessionId,
      concordiaBaseUrl: "http://127.0.0.1:1", // 到達不能 → drop
      provider,
      pinnedTranscriptPath: pathA,
      lictorTranscriptStatePath: statePath,
    });
    try {
      writeFileSync(pathA, '{"type":"assistant","message":{"content":[{"type":"text","text":"A"}]}}\n');
      await sleep(700);
      assert.equal(tail.getTranscriptPath(), pathA, "起動時は A を tail");
      assert.equal(existsSync(`${pathA}.lictor-claim`), true, "A を claim");

      // `/clear`: SessionStart hook が新 transcript_path=B を state ファイルへ書き、
      // claude が B.jsonl を作る。
      writeFileSync(pathB, '{"type":"assistant","message":{"content":[{"type":"text","text":"B"}]}}\n');
      writeFileSync(statePath, pathB);
      await sleep(900);

      assert.equal(tail.getTranscriptPath(), pathB, "/clear 後は B へ束縛し直して tail");
      assert.equal(tail.getSessionUuid(), uuidB, "session uuid も B を返す");
      assert.equal(existsSync(`${pathB}.lictor-claim`), true, "B を claim");
      assert.equal(existsSync(`${pathA}.lictor-claim`), false, "旧 A の claim は解放する");
    } finally {
      tail.stop();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// 現行 Claude Code は --session-id で渡した uuid と、 実際に書く transcript JSONL の
// ファイル名 uuid が一致しないことがある。 その場合 computed pin (`<uuid>.jsonl`) は
// 永遠に現れないが、 SessionStart hook が報告する実 transcript_path を権威ソースに実
// ファイルを束縛する。 mtime 推測には一切降りないので、 同 dir に「より新しい別セッション
// の decoy」 があっても掴まない (= crosstalk が構造的に起きない)。
test("startTranscriptTail: pin ファイル名不一致でも hook の transcript_path で実ファイルを束縛し decoy を掴まない", async () => {
  const dir = mkdtempSync(join(tmpdir(), "lictor-authority-"));
  try {
    const sessionId = "lictor-authority-session";

    // より新しい mtime の decoy = 別セッションの jsonl。 mtime discover なら誤掴みする。
    const decoyUuid = "99999999-9999-4999-8999-999999999999";
    const decoyPath = join(dir, `${decoyUuid}.jsonl`);
    writeFileSync(decoyPath, '{"type":"assistant","message":{"content":[{"type":"text","text":"decoy"}]}}\n');
    const future = Date.now() / 1000 + 600;
    utimesSync(decoyPath, future, future);

    // Lictor が --session-id で渡した uuid。 claude はこの名前の jsonl を書かない。
    const pinnedUuid = "55555555-5555-4555-8555-555555555555";
    const pinnedPath = join(dir, `${pinnedUuid}.jsonl`); // ← 一生作られない
    // claude が実際に書く transcript (別 uuid、 decoy より古い mtime)。
    const realUuid = "66666666-6666-4666-8666-666666666666";
    const realPath = join(dir, `${realUuid}.jsonl`);
    writeFileSync(realPath, '{"type":"assistant","message":{"content":[{"type":"text","text":"real"}]}}\n');

    // SessionStart hook は実 transcript_path (= realPath) を報告する。
    const statePath = claudeTranscriptStatePath(dir, sessionId);
    writeFileSync(statePath, realPath);
    const provider = { ...PROVIDERS.claude, transcriptDir: () => dir };

    const tail = startTranscriptTail({
      cwd: dir,
      sessionId,
      concordiaBaseUrl: "http://127.0.0.1:1", // 到達不能 → postFrame は黙って drop
      provider,
      pinnedTranscriptPath: pinnedPath,
      lictorTranscriptStatePath: statePath,
    });
    try {
      await sleep(900);
      assert.equal(tail.getTranscriptPath(), realPath, "hook 報告の実ファイルを tail");
      assert.equal(tail.getSessionUuid(), realUuid, "session uuid は実ファイルの uuid を返す");
      assert.equal(existsSync(`${realPath}.lictor-claim`), true, "実ファイルを claim");
      assert.equal(existsSync(`${pinnedPath}.lictor-claim`), false, "存在しない computed pin は claim しない");
      assert.equal(existsSync(`${decoyPath}.lictor-claim`), false, "より新しい decoy は最後まで掴まない (mtime 推測しない)");
    } finally {
      tail.stop();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// hook 未発火 (state ファイル未作成) の起動直後は、 computed pin (一意 uuid) で橋渡しして
// 中継を即始める。 より新しい decoy があっても掴まない (crosstalk 防護を維持)。
test("startTranscriptTail: hook 未発火でも computed pin で橋渡しし decoy を掴まない", async () => {
  const dir = mkdtempSync(join(tmpdir(), "lictor-bridge-"));
  try {
    const decoyPath = join(dir, "77777777-7777-4777-8777-777777777777.jsonl");
    writeFileSync(decoyPath, '{"type":"assistant","message":{"content":[{"type":"text","text":"decoy"}]}}\n');
    const future = Date.now() / 1000 + 600;
    utimesSync(decoyPath, future, future); // decoy を mtime 最新にする

    const ownUuid = "88888888-8888-4888-8888-888888888888";
    const pinnedPath = join(dir, `${ownUuid}.jsonl`);
    writeFileSync(pinnedPath, '{"type":"assistant","message":{"content":[{"type":"text","text":"mine"}]}}\n');
    const provider = { ...PROVIDERS.claude, transcriptDir: () => dir };

    // lictorTranscriptStatePath は渡すが state ファイルは未作成 (hook 未発火相当)。
    const statePath = claudeTranscriptStatePath(dir, "lictor-bridge-session");
    const tail = startTranscriptTail({
      cwd: dir,
      sessionId: "lictor-bridge-session",
      concordiaBaseUrl: "http://127.0.0.1:1",
      provider,
      pinnedTranscriptPath: pinnedPath,
      lictorTranscriptStatePath: statePath,
    });
    try {
      await sleep(700);
      assert.equal(tail.getTranscriptPath(), pinnedPath, "hook 未発火でも computed pin を tail");
      assert.equal(existsSync(`${decoyPath}.lictor-claim`), false, "より新しい decoy は掴まない");
    } finally {
      tail.stop();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// pin 撤去後の本番フロー: wrap.ts は `--session-id` を渡さず pinnedTranscriptPath も指定
// しない。 claude が session_id を自前採番し、 SessionStart hook がその実 transcript_path を
// 報告する。 transcript-tail は hook 権威が設定済なら、 hook 報告までは mtime 推測に降りず
// 待ち (= より新しい別セッションの decoy を掴まない)、 報告後に実ファイルを束縛する。
test("startTranscriptTail: pin 無し + hook 権威で、 hook 未発火中は mtime に降りず、 報告後に実ファイルを束縛する", async () => {
  const dir = mkdtempSync(join(tmpdir(), "lictor-nopin-"));
  try {
    const sessionId = "lictor-nopin-session";
    const statePath = claudeTranscriptStatePath(dir, sessionId);
    const provider = { ...PROVIDERS.claude, transcriptDir: () => dir };

    // より新しい mtime の decoy = 別セッションの jsonl。 mtime discover なら誤掴みする。
    const decoyPath = join(dir, "aaaa1111-1111-4111-8111-111111111111.jsonl");
    writeFileSync(decoyPath, '{"type":"assistant","message":{"content":[{"type":"text","text":"decoy"}]}}\n');
    const future = Date.now() / 1000 + 600;
    utimesSync(decoyPath, future, future);

    // claude が自前採番した実 transcript (hook がまだ報告していない、 decoy より古い mtime)。
    const realUuid = "bbbb2222-2222-4222-8222-222222222222";
    const realPath = join(dir, `${realUuid}.jsonl`);
    writeFileSync(realPath, '{"type":"assistant","message":{"content":[{"type":"text","text":"real"}]}}\n');

    // pin 無し (pinnedTranscriptPath 未指定)、 hook 権威のみ。
    const tail = startTranscriptTail({
      cwd: dir,
      sessionId,
      concordiaBaseUrl: "http://127.0.0.1:1", // 到達不能 → postFrame / postDiagnostic は drop
      provider,
      lictorTranscriptStatePath: statePath,
    });
    try {
      // hook 未発火 (state ファイル未作成) → mtime に降りず何も掴まない (decoy も real も)。
      await sleep(700);
      assert.equal(tail.getTranscriptPath(), null, "hook 未発火中は mtime 推測せず待つ");
      assert.equal(existsSync(`${decoyPath}.lictor-claim`), false, "より新しい decoy を mtime で掴まない");
      assert.equal(existsSync(`${realPath}.lictor-claim`), false, "hook 未報告の実ファイルもまだ掴まない");

      // hook が実 transcript_path を報告 → 実ファイルを束縛。
      writeFileSync(statePath, realPath);
      await sleep(700);
      assert.equal(tail.getTranscriptPath(), realPath, "hook 報告後は実ファイルを tail");
      assert.equal(tail.getSessionUuid(), realUuid, "session uuid は実ファイルの uuid を返す");
      assert.equal(existsSync(`${realPath}.lictor-claim`), true, "実ファイルを claim");
      assert.equal(existsSync(`${decoyPath}.lictor-claim`), false, "decoy は最後まで掴まない");
    } finally {
      tail.stop();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// hook 権威ありのとき、 stall 復帰 / 手動 repin は mtime 推測に降りず権威 transcript_path
// だけを真とする。 共有 projects/<cwd> に「より新しい別セッションの生 JSONL (decoy)」 が
// あっても絶対に掴まない (= Concordia 再起動連打で全セッション同時 stall したとき、 newest
// unclaimed を奪い合って他セッションの transcript を自分の session_id で中継してしまう
// crosstalk を構造的に排除する。 本番実害 2026-06-30 の再発経路)。 forceRediscover は
// throttle/grace を無視して即実行するので、 mtime 経路に降りていれば decoy を掴むはず。
test("startTranscriptTail: hook 権威ありなら forceRediscover は mtime 最新 decoy を掴まず権威に留まる (crosstalk 防止)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "lictor-authority-recover-"));
  try {
    const sessionId = "lictor-authority-recover-session";
    const statePath = claudeTranscriptStatePath(dir, sessionId);
    const provider = { ...PROVIDERS.claude, transcriptDir: () => dir };

    const realUuid = "dddd1111-1111-4111-8111-111111111111";
    const realPath = join(dir, `${realUuid}.jsonl`);
    writeFileSync(realPath, '{"type":"assistant","message":{"content":[{"type":"text","text":"real"}]}}\n');
    writeFileSync(statePath, realPath); // hook 権威 = realPath

    const tail = startTranscriptTail({
      cwd: dir,
      sessionId,
      concordiaBaseUrl: "http://127.0.0.1:1", // 到達不能 → postFrame は drop
      provider,
      pinnedTranscriptPath: realPath,
      lictorTranscriptStatePath: statePath,
    });
    try {
      await sleep(700);
      assert.equal(tail.getTranscriptPath(), realPath, "起動時は権威 realPath を tail");

      // 別セッションの「より新しい」 生 JSONL。 mtime recovery なら誤掴みする decoy。
      const decoyPath = join(dir, "dddd9999-9999-4999-8999-999999999999.jsonl");
      writeFileSync(decoyPath, '{"type":"assistant","message":{"content":[{"type":"text","text":"decoy"}]}}\n');
      const future = Date.now() / 1000 + 600;
      utimesSync(decoyPath, future, future);

      const r = tail.forceRediscover();
      assert.notEqual(r.path, decoyPath, "decoy へは re-pin しない");
      assert.equal(tail.getTranscriptPath(), realPath, "権威パスに留まる");
      assert.equal(existsSync(`${decoyPath}.lictor-claim`), false, "より新しい decoy は掴まない (mtime 推測しない)");
      assert.equal(existsSync(`${realPath}.lictor-claim`), true, "権威パスの claim は維持");
    } finally {
      tail.stop();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// hook 権威ありの stall 復帰は、 権威 transcript_path が現束縛と異なる実在パスを指したとき
// (= 束縛が死んだ後に hook が別の実ファイルを報告) はそこへ re-pin する。 ただし対象は常に
// 権威パスであって、 mtime 最新の decoy ではない。
test("startTranscriptTail: hook 権威ありで forceRediscover は権威が指す実ファイルへ re-pin する (decoy ではなく)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "lictor-authority-repin-"));
  try {
    const sessionId = "lictor-authority-repin-session";
    const statePath = claudeTranscriptStatePath(dir, sessionId);
    const provider = { ...PROVIDERS.claude, transcriptDir: () => dir };

    const realUuid = "eeee1111-1111-4111-8111-111111111111";
    const realPath = join(dir, `${realUuid}.jsonl`);
    writeFileSync(realPath, '{"type":"assistant","message":{"content":[{"type":"text","text":"real"}]}}\n');
    writeFileSync(statePath, realPath);

    const tail = startTranscriptTail({
      cwd: dir,
      sessionId,
      concordiaBaseUrl: "http://127.0.0.1:1",
      provider,
      pinnedTranscriptPath: realPath,
      lictorTranscriptStatePath: statePath,
    });
    try {
      await sleep(700);
      assert.equal(tail.getTranscriptPath(), realPath, "起動時は realPath を tail");

      // decoy: mtime 最新の別セッション JSONL (権威ではない)。
      const decoyPath = join(dir, "eeee9999-9999-4999-8999-999999999999.jsonl");
      writeFileSync(decoyPath, '{"type":"assistant","message":{"content":[{"type":"text","text":"decoy"}]}}\n');
      const future = Date.now() / 1000 + 600;
      utimesSync(decoyPath, future, future);

      // hook が新しい実ファイル real2 を報告 (decoy より古い mtime)。 権威の乗り換え先。
      const real2Uuid = "eeee2222-2222-4222-8222-222222222222";
      const real2Path = join(dir, `${real2Uuid}.jsonl`);
      writeFileSync(real2Path, '{"type":"assistant","message":{"content":[{"type":"text","text":"real2"}]}}\n');
      writeFileSync(statePath, real2Path);

      // maybeRebind が先に乗り換えても良いが、 いずれにせよ着地は権威 real2 で decoy ではない。
      const r = tail.forceRediscover();
      assert.equal(tail.getTranscriptPath(), real2Path, "権威が指す real2 へ束縛 (decoy ではない)");
      assert.notEqual(r.path, decoyPath);
      assert.equal(existsSync(`${decoyPath}.lictor-claim`), false, "より新しい decoy は掴まない");
    } finally {
      tail.stop();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ─── onPickerQuestionRegistered: AskUserQuestion 登録後のコールバック ─────────
// transcript-tail が AskUserQuestion tool_use を検出して Concordia に POST し、
// question_id が返ったとき onPickerQuestionRegistered が呼ばれることを確認する。
// wrap.ts はこの id を pickerQuestionIds に追加し onAnswerQuestion の三分岐で使う。
test("startTranscriptTail: AskUserQuestion 検出後に onPickerQuestionRegistered(qid) を呼ぶ", async () => {
  // mock Concordia: POST pending-question → { question_id: 99 }
  const server = createServer((req, res) => {
    if (req.method === "POST" && req.url?.includes("pending-question")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ question_id: 99 }));
    } else {
      res.writeHead(204);
      res.end();
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as { port: number };
  const concordiaBaseUrl = `http://127.0.0.1:${port}`;

  const dir = mkdtempSync(join(tmpdir(), "lictor-picker-"));
  const pickerQids: number[] = [];
  try {
    const ownUuid = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
    const pinnedPath = join(dir, `${ownUuid}.jsonl`);
    const provider = { ...PROVIDERS.claude, transcriptDir: () => dir };

    const tail = startTranscriptTail({
      cwd: dir,
      sessionId: "lictor-picker-session",
      concordiaBaseUrl,
      provider,
      pinnedTranscriptPath: pinnedPath,
      onPickerQuestionRegistered: (qid) => pickerQids.push(qid),
    });
    try {
      // AskUserQuestion tool_use を含む JSONL を書き込む。
      const line = JSON.stringify({
        type: "assistant",
        message: {
          content: [
            {
              type: "tool_use",
              id: "toolu_picker01",
              name: "AskUserQuestion",
              input: {
                questions: [{ question: "続けますか?", options: [{ label: "はい" }, { label: "いいえ" }] }],
              },
            },
          ],
        },
      });
      writeFileSync(pinnedPath, line + "\n", "utf8");

      // poll が検出 → HTTP POST → .then → callback まで待つ。
      await sleep(1200);
      assert.deepEqual(pickerQids, [99], "AskUserQuestion 登録後に question_id=99 で呼ばれる");
    } finally {
      tail.stop();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

// ─── decideCodexInitialBind: codex 初回束縛の決定 (session_id 施錠) ───────────
//
// 束縛キーは session_meta.session_id ただ一つ。 ちょうど 1 件のときだけ束縛し、
// 2 件以上 (同 cwd 並走) は誤掴みを避けて掴まない (鉄のルール: 曖昧なら束縛しない)。

test("decideCodexInitialBind: 候補ゼロは wait", () => {
  assert.deepEqual(decideCodexInitialBind([]), { action: "wait" });
});

test("decideCodexInitialBind: session_id が読めない候補だけなら wait (施錠キー無し)", () => {
  assert.deepEqual(
    decideCodexInitialBind([{ path: "/a", sessionId: null }, { path: "/b", sessionId: "" }]),
    { action: "wait" },
  );
});

test("decideCodexInitialBind: session_id 付きがちょうど 1 件なら bind してその id を施錠", () => {
  assert.deepEqual(
    decideCodexInitialBind([{ path: "/a", sessionId: "S1" }, { path: "/b", sessionId: null }]),
    { action: "bind", path: "/a", sessionId: "S1" },
  );
});

test("decideCodexInitialBind: session_id 付きが 2 件以上なら ambiguous (掴まない)", () => {
  assert.deepEqual(
    decideCodexInitialBind([{ path: "/a", sessionId: "S1" }, { path: "/b", sessionId: "S2" }]),
    { action: "ambiguous", paths: ["/a", "/b"] },
  );
});

test("decideCodexInitialBind: session_id 付きが 2 件以上でも mtime が一意に最新なら bind", () => {
  assert.deepEqual(
    decideCodexInitialBind([
      { path: "/a", sessionId: "S1", mtimeMs: 100 },
      { path: "/b", sessionId: "S2", mtimeMs: 200 },
    ]),
    { action: "bind", path: "/b", sessionId: "S2" },
  );
});

test("decideCodexInitialBind: mtime が同点なら ambiguous のまま", () => {
  assert.deepEqual(
    decideCodexInitialBind([
      { path: "/a", sessionId: "S1", mtimeMs: 100 },
      { path: "/b", sessionId: "S2", mtimeMs: 100 },
    ]),
    { action: "ambiguous", paths: ["/a", "/b"] },
  );
});

test("decideCodexInitialBind: 一部候補だけ mtime 不明なら ambiguous のまま", () => {
  assert.deepEqual(
    decideCodexInitialBind([
      { path: "/a", sessionId: "S1", mtimeMs: 100 },
      { path: "/b", sessionId: "S2" },
    ]),
    { action: "ambiguous", paths: ["/a", "/b"] },
  );
});

// ─── codex session_id 施錠 (startTranscriptTail 統合) ───────────────────────

/** codex rollout の session_meta 先頭行 + 任意本文を書いた JSONL を作る。 */
function writeCodexRollout(dir: string, name: string, sessionId: string, cwd: string, body: unknown[] = []): string {
  const p = join(dir, name);
  const meta = {
    type: "session_meta",
    payload: { session_id: sessionId, cwd, timestamp: new Date().toISOString() },
  };
  writeFileSync(p, [meta, ...body].map((o) => JSON.stringify(o)).join("\n") + "\n");
  return p;
}

function writeCodexRolloutWithPayload(
  dir: string,
  name: string,
  payload: Record<string, unknown>,
  body: unknown[] = [],
): string {
  const p = join(dir, name);
  const meta = {
    type: "session_meta",
    payload: { ...payload, timestamp: new Date().toISOString() },
  };
  writeFileSync(p, [meta, ...body].map((o) => JSON.stringify(o)).join("\n") + "\n");
  return p;
}

// 初回に session_meta.session_id を読んで施錠し、 以後その id の rollout だけを tail する。
// 施錠後は「より新しい別 session_id の decoy」 を forceRediscover でも掴まない (crosstalk 排除)。
test("startTranscriptTail(codex): session_id を施錠し、別 session_id の新しい decoy を掴まない", async () => {
  const dir = mkdtempSync(join(tmpdir(), "lictor-codex-lock-"));
  try {
    const provider = { ...PROVIDERS.codex, transcriptDir: () => dir };
    const tail = startTranscriptTail({
      cwd: dir,
      sessionId: "lictor-codex-session",
      concordiaBaseUrl: "http://127.0.0.1:1", // 到達不能 → postFrame は drop
      provider,
    });
    try {
      // まだ rollout 無し → 何も掴まない。
      await sleep(300);
      assert.equal(tail.getTranscriptPath(), null, "rollout 未生成の間は束縛しない");

      // 自分の rollout (S1) が現れる → ちょうど 1 件なので S1 を施錠して束縛。
      const rollout = writeCodexRollout(dir, "rollout-2026-07-06-S1.jsonl", "S1", dir, [
        { type: "event_msg", payload: { type: "agent_message", message: "hi from S1" } },
      ]);
      await sleep(700);
      assert.equal(tail.getTranscriptPath(), rollout, "S1 rollout を tail する");
      assert.equal(tail.getSessionUuid(), "S1", "施錠した session_id を返す");
      assert.equal(existsSync(`${rollout}.lictor-claim`), true, "S1 rollout を claim する");

      // 別セッション (S2) の rollout を「より新しい mtime」 で置く = crosstalk の元。
      const decoy = writeCodexRollout(dir, "rollout-2026-07-06-S2.jsonl", "S2", dir, [
        { type: "event_msg", payload: { type: "agent_message", message: "OTHER session" } },
      ]);
      const future = Date.now() / 1000 + 600;
      utimesSync(decoy, future, future);

      // 手動 repin をかけても施錠 (S1) は動かない。 別 session_id の decoy は絶対に掴まない。
      const r = tail.forceRediscover();
      assert.equal(r.path, rollout, "施錠したままなので S1 に留まる (S2 へ乗り換えない)");
      assert.equal(tail.getTranscriptPath(), rollout, "以後も S1 を tail");
      assert.equal(existsSync(`${decoy}.lictor-claim`), false, "別 session_id の decoy は最後まで掴まない");
    } finally {
      tail.stop();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// 同 cwd で複数候補がある場合でも、spawn 直後の Codex は mtime 最新を自分の rollout として選べる。
test("startTranscriptTail(codex): 同 cwd に 2 rollout が同時存在すると mtime 最新を束縛する", async () => {
  const dir = mkdtempSync(join(tmpdir(), "lictor-codex-amb-"));
  try {
    const provider = { ...PROVIDERS.codex, transcriptDir: () => dir };
    const tail = startTranscriptTail({
      cwd: dir,
      sessionId: "lictor-codex-amb",
      concordiaBaseUrl: "http://127.0.0.1:1",
      provider,
    });
    try {
      const r1 = writeCodexRollout(dir, "rollout-2026-07-06-A.jsonl", "SA", dir);
      const r2 = writeCodexRollout(dir, "rollout-2026-07-06-B.jsonl", "SB", dir);
      const now = Date.now() / 1000;
      utimesSync(r1, now, now);
      utimesSync(r2, now + 2, now + 2);
      await sleep(700);
      assert.equal(tail.getTranscriptPath(), r2, "mtime 最新の B を tail する");
      assert.equal(tail.getSessionUuid(), "SB", "B の session_id を施錠する");
      assert.equal(existsSync(`${r1}.lictor-claim`), false, "A は掴まない");
      assert.equal(existsSync(`${r2}.lictor-claim`), true, "B を claim する");
    } finally {
      tail.stop();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("startTranscriptTail(codex): session_meta id が無くても rollout filename UUID で束縛する", async () => {
  const dir = mkdtempSync(join(tmpdir(), "lictor-codex-fileid-"));
  try {
    const provider = { ...PROVIDERS.codex, transcriptDir: () => dir };
    const tail = startTranscriptTail({
      cwd: dir,
      sessionId: "lictor-codex-fileid",
      concordiaBaseUrl: "http://127.0.0.1:1",
      provider,
    });
    try {
      const uuid = "019f412f-77ff-7523-b837-97a60c2f52b9";
      const rollout = writeCodexRolloutWithPayload(
        dir,
        `rollout-2026-07-09T00-00-00-${uuid}.jsonl`,
        { cwd: dir, originator: "codex_cli_rs", source: "cli" },
        [{ type: "event_msg", payload: { type: "agent_message", message: "fallback ok" } }],
      );
      await sleep(700);
      assert.equal(tail.getTranscriptPath(), rollout, "filename UUID fallback で rollout を tail する");
      assert.equal(tail.getSessionUuid(), uuid, "filename UUID を session UUID として返す");
      const recent = tail.readRecent(5);
      assert.equal(recent.available, true);
      assert.equal(recent.path, rollout);
      assert.equal(recent.returned > 0, true, "transcript tail が 0 件にならない");
    } finally {
      tail.stop();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// maybeRebind の existsSync ガード: hook が報告したパスがまだ実在しない間は、 現束縛を
// 維持して中継を止めない (phantom/生成前パスへ rebind して stall する本番バグの修正)。
test("startTranscriptTail: hook 報告パスが未実在の間は rebind せず旧 JSONL の tail を継続する", async () => {
  const dir = mkdtempSync(join(tmpdir(), "lictor-defer-"));
  try {
    const sessionId = "lictor-defer-session";
    const statePath = claudeTranscriptStatePath(dir, sessionId);
    const provider = { ...PROVIDERS.claude, transcriptDir: () => dir };
    const uuidA = "55555555-5555-4555-8555-555555555555";
    const pathA = join(dir, `${uuidA}.jsonl`);
    const pathGhost = join(dir, "99999999-9999-4999-8999-999999999999.jsonl"); // 作らない

    writeFileSync(statePath, pathA);
    const tail = startTranscriptTail({
      cwd: dir,
      sessionId,
      concordiaBaseUrl: "http://127.0.0.1:1",
      provider,
      pinnedTranscriptPath: pathA,
      lictorTranscriptStatePath: statePath,
    });
    try {
      writeFileSync(pathA, '{"type":"assistant","message":{"content":[{"type":"text","text":"A"}]}}\n');
      await sleep(700);
      assert.equal(tail.getTranscriptPath(), pathA, "起動時は A を tail");

      // hook が未実在パス (ghost) を報告 → 旧実装は jsonlPath=null で停止していた。
      writeFileSync(statePath, pathGhost);
      await sleep(700);
      assert.equal(tail.getTranscriptPath(), pathA, "未実在パス報告中は A の tail を維持 (停止しない)");
    } finally {
      tail.stop();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// forceRediscover (手動 /v1/repin): pin のみ (hook 権威なし claude) では mtime 推測を
// 一切しない。 pin で確定した束縛先に留まり、 「より新しい別 JSONL (decoy)」 が現れても
// 掴まない (鉄のルール: session_id / 権威 pin 以外を推測束縛しない = crosstalk 排除)。
// hook 権威ありの /clear 追従は maybeRebind / recoverByAuthority が担う (別テスト)。
test("startTranscriptTail: pin のみの forceRediscover は mtime 最新 decoy を掴まず pin に留まる", async () => {
  const dir = mkdtempSync(join(tmpdir(), "lictor-repin-"));
  try {
    const sessionId = "lictor-repin-session";
    const provider = { ...PROVIDERS.claude, transcriptDir: () => dir };
    const uuidA = "66666666-6666-4666-8666-666666666666";
    const pathA = join(dir, `${uuidA}.jsonl`);
    writeFileSync(pathA, '{"type":"assistant","message":{"content":[{"type":"text","text":"A"}]}}\n');

    // pin = A を束縛させる。
    const tail = startTranscriptTail({
      cwd: dir,
      sessionId,
      concordiaBaseUrl: "http://127.0.0.1:1",
      provider,
      pinnedTranscriptPath: pathA,
    });
    try {
      await sleep(700);
      assert.equal(tail.getTranscriptPath(), pathA, "起動時は A を tail");

      // decoy: 別セッションの JSONL を「より新しい mtime」 で置く。 旧 mtime 復帰なら掴んだ。
      const uuidB = "77777777-7777-4777-8777-777777777777";
      const pathB = join(dir, `${uuidB}.jsonl`);
      writeFileSync(pathB, '{"type":"assistant","message":{"content":[{"type":"text","text":"B"}]}}\n');
      const future = Date.now() / 1000 + 600;
      utimesSync(pathB, future, future);

      const r = tail.forceRediscover();
      assert.equal(r.path, pathA, "pin (A) に留まる (mtime 最新 B へ乗り換えない)");
      assert.equal(tail.getTranscriptPath(), pathA, "以後も A を tail");
      assert.equal(existsSync(`${pathB}.lictor-claim`), false, "より新しい decoy B は掴まない");
    } finally {
      tail.stop();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── ローカルLLM/Ollama 汎用化 (usesFilenameSessionLock) ─────────────────────────

test("makeLocalLlmProvider: ローカルLLM共通フィールドを埋める", () => {
  const p = makeLocalLlmProvider({
    name: "test-llm",
    binary: "test-runner",
    binaryEnvVar: "TEST_RUNNER_BIN",
    spawnArgs: ["run"],
    displayName: "Test LLM",
    sessionsDir: () => "/tmp/test-llm/sessions",
  });
  assert.equal(p.name, "test-llm");
  assert.equal(p.binary, "test-runner");
  assert.equal(p.binaryEnvVar, "TEST_RUNNER_BIN");
  assert.deepEqual(p.spawnArgs, ["run"]);
  assert.equal(p.skillStrategy, "none");
  assert.equal(p.supportsSkills, false);
  assert.equal(p.concordiaProvider, "local-llm");
  assert.equal(p.supportsSessionPin, false);
  assert.equal(p.usesFilenameSessionLock, true, "filename 施錠を有効化する");
  assert.equal(p.transcriptDir(""), "/tmp/test-llm/sessions");
});

test("gemma4-12 (Famulus): usesFilenameSessionLock 済で ~/.famulus/sessions を tail する", () => {
  const p = PROVIDERS["gemma4-12"];
  assert.equal(p.usesFilenameSessionLock, true);
  assert.equal(p.supportsSessionPin, false);
  assert.equal(p.concordiaProvider, "local-llm");
  assert.equal(p.binaryEnvVar, "LICTOR_FAMULUS_BIN");
  assert.ok(p.transcriptDir("").endsWith(join(".famulus", "sessions")));
});

// 中核: 同一 sessions dir に別セッションの JSONL が「より新しい mtime」 で並んでいても、
// 自分の session id を施錠キーにして自分の 1 ファイルだけを exact bind する (mtime 推測ゼロ)。
// これが「他のローカルLLM/Ollama系」 でも crosstalk しない汎用化の本体。
test("startTranscriptTail(local-llm): 自 session id のファイルだけを exact bind し新しい decoy を掴まない", async () => {
  const dir = mkdtempSync(join(tmpdir(), "lictor-localllm-"));
  try {
    const provider = { ...PROVIDERS["gemma4-12"], transcriptDir: () => dir };

    // 自分の session id = そのままファイル名 stem (Famulus 規約)。
    const ownId = "11111111-1111-4111-8111-111111111111";
    const ownPath = join(dir, `${ownId}.jsonl`);
    // 別セッションの famulus ログ。 より新しい mtime を持たせて「mtime 推測なら誤掴み」 を誘う。
    const otherId = "99999999-9999-4999-8999-999999999999";
    const otherPath = join(dir, `${otherId}.jsonl`);
    writeFileSync(otherPath, '{"ts":1,"role":"assistant","content":"other session"}\n');
    const future = Date.now() / 1000 + 600;
    utimesSync(otherPath, future, future);

    const tail = startTranscriptTail({
      cwd: dir,
      sessionId: ownId,
      concordiaBaseUrl: "http://127.0.0.1:1", // 到達不能 → postFrame は drop
      provider,
    });
    try {
      // 自分のファイルはまだ無い → 施錠キー一致 0 件。 fail-loud せず静かに待ち、 decoy も掴まない。
      await sleep(700);
      assert.equal(tail.getTranscriptPath(), null, "自ファイル未生成の間は何も掴まない");
      assert.equal(existsSync(`${otherPath}.lictor-claim`), false, "より新しい別セッションを掴まない");

      // 自分の famulus ログが現れた → これだけを exact bind する。
      writeFileSync(ownPath, '{"ts":2,"role":"assistant","content":"mine"}\n');
      await sleep(700);
      assert.equal(tail.getTranscriptPath(), ownPath, "自 session id のファイルを exact bind");
      assert.equal(existsSync(`${ownPath}.lictor-claim`), true, "自ファイルを claim する");
      assert.equal(existsSync(`${otherPath}.lictor-claim`), false, "decoy は最後まで掴まない");
      assert.equal(tail.getSessionUuid(), ownId, "session uuid は自 id を返す");
    } finally {
      tail.stop();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// session id から UUID が抽出できない provider 設定でも事前施錠せず従来動作に落ちる
// (安全フォールバック)。 唯一の候補を初回束縛する。
test("startTranscriptTail(local-llm): session id が非UUIDなら事前施錠せず初回束縛にフォールバック", async () => {
  const dir = mkdtempSync(join(tmpdir(), "lictor-localllm-fb-"));
  try {
    const provider = { ...PROVIDERS["gemma4-12"], transcriptDir: () => dir };
    // 末尾 UUID を持つ実ファイル (famulus は UUID を名前に使う)。
    const fileId = "22222222-2222-4222-8222-222222222222";
    const filePath = join(dir, `${fileId}.jsonl`);
    writeFileSync(filePath, '{"ts":1,"role":"assistant","content":"hi"}\n');

    const tail = startTranscriptTail({
      cwd: dir,
      sessionId: "plain-non-uuid-session", // extractUuid → null → 事前施錠しない
      concordiaBaseUrl: "http://127.0.0.1:1",
      provider,
    });
    try {
      await sleep(700);
      assert.equal(tail.getTranscriptPath(), filePath, "唯一候補を初回束縛 (フォールバック)");
    } finally {
      tail.stop();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
