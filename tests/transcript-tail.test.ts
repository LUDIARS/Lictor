import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { lineToFrame, tryClaimJsonl, refreshClaim, readRecentFromFile, startTranscriptTail } from "../src/transcript-tail.js";
import { PROVIDERS } from "../src/provider.js";
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
