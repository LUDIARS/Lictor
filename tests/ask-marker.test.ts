import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ASK_MARKER_CLAUDE_SYSTEM_PROMPT,
  ASK_MARKER_COMMON,
  ASK_MARKER_SKILL_BODY,
  detectAskMarker,
  parseAskMarkerText,
  writeAskMarkerPrompt,
} from "../src/ask-marker.js";

test("parseAskMarkerText: 正常な ```ask ブロックを構造化", () => {
  const text = [
    "選んでください:",
    "```ask",
    '{"question":"進めますか?","multiSelect":false,"options":[{"label":"はい","description":"進める"},{"label":"いいえ"}]}',
    "```",
  ].join("\n");
  const m = parseAskMarkerText(text);
  assert.ok(m);
  assert.equal(m.question, "進めますか?");
  assert.equal(m.multiSelect, false);
  assert.deepEqual(m.options, [{ label: "はい", description: "進める" }, { label: "いいえ" }]);
});

test("parseAskMarkerText: multiSelect=true を拾う", () => {
  const text = '```ask\n{"question":"どれ?","multiSelect":true,"options":["A","B","C"]}\n```';
  const m = parseAskMarkerText(text);
  assert.ok(m);
  assert.equal(m.multiSelect, true);
  assert.deepEqual(m.options, [{ label: "A" }, { label: "B" }, { label: "C" }]);
});

test("parseAskMarkerText: ブロック無しは null", () => {
  assert.equal(parseAskMarkerText("ただのテキスト"), null);
  assert.equal(parseAskMarkerText("```json\n{}\n```"), null);
});

test("parseAskMarkerText: 不正 JSON / 空 question / option ゼロ は null", () => {
  assert.equal(parseAskMarkerText("```ask\nnot json\n```"), null);
  assert.equal(parseAskMarkerText('```ask\n{"question":"","options":[{"label":"A"}]}\n```'), null);
  assert.equal(parseAskMarkerText('```ask\n{"question":"Q","options":[]}\n```'), null);
});

test("parseAskMarkerText: Windows パスの未エスケープ \\ を救済", () => {
  // モデルが手書きで `E:\Document\Ars` のようにバックスラッシュを 1 個で書くと
  // 厳格 JSON では不正エスケープ。寛容パースで質問カードに変換できること。
  const text = '```ask\n{"question":"E:\\Document\\Ars を削除しますか?","options":[{"label":"はい"},{"label":"いいえ"}]}\n```';
  const m = parseAskMarkerText(text);
  assert.ok(m, "Windows パス入りでも null にならない");
  assert.equal(m.question, "E:\\Document\\Ars を削除しますか?");
  assert.equal(m.options.length, 2);
});

test("parseAskMarkerText: 末尾カンマを救済", () => {
  const text = '```ask\n{"question":"どれ?","options":[{"label":"A"},{"label":"B"},]}\n```';
  const m = parseAskMarkerText(text);
  assert.ok(m);
  assert.deepEqual(m.options, [{ label: "A" }, { label: "B" }]);
});

test("parseAskMarkerText: 全角クォート区切りを救済", () => {
  const text = "```ask\n{“question”:“進める?”,“options”:[{“label”:“はい”}]}\n```";
  const m = parseAskMarkerText(text);
  assert.ok(m);
  assert.equal(m.question, "進める?");
  assert.deepEqual(m.options, [{ label: "はい" }]);
});

test("parseAskMarkerText: 文字列値に ``` が入っても切れない", () => {
  // 旧実装は非貪欲 regex が値中の ``` で切れて壊れていた。
  const text = '```ask\n{"question":"```json ブロックを消す?","options":[{"label":"消す"},{"label":"残す"}]}\n```';
  const m = parseAskMarkerText(text);
  assert.ok(m);
  assert.equal(m.question, "```json ブロックを消す?");
  assert.equal(m.options.length, 2);
});

test("parseAskMarkerText: 文字列値内の生改行を救済", () => {
  const text = '```ask\n{"question":"複数行\nの確認","options":[{"label":"OK"}]}\n```';
  const m = parseAskMarkerText(text);
  assert.ok(m);
  assert.equal(m.question, "複数行\nの確認");
});

test("detectAskMarker: Claude assistant 行から抽出", () => {
  const line = JSON.stringify({
    type: "assistant",
    message: {
      content: [
        { type: "text", text: '前置き\n```ask\n{"question":"Q","options":[{"label":"A"},{"label":"B"}]}\n```' },
      ],
    },
  });
  const m = detectAskMarker(line);
  assert.ok(m);
  assert.equal(m.question, "Q");
  assert.deepEqual(m.options, [{ label: "A" }, { label: "B" }]);
});

test("detectAskMarker: user 行 / 非 assistant は null", () => {
  const userLine = JSON.stringify({
    type: "user",
    message: { content: [{ type: "text", text: "```ask\n{\"question\":\"Q\",\"options\":[{\"label\":\"A\"}]}\n```" }] },
  });
  assert.equal(detectAskMarker(userLine), null);
  assert.equal(detectAskMarker("not-json"), null);
});

test("writeAskMarkerPrompt: ファイルに Claude system-prompt を書き出す", () => {
  const dir = mkdtempSync(join(tmpdir(), "lictor-askmarker-"));
  try {
    const p = writeAskMarkerPrompt(dir);
    const body = readFileSync(p, "utf8");
    assert.equal(body, ASK_MARKER_CLAUDE_SYSTEM_PROMPT);
    // 共通ルールと Claude 固有 addendum を両方含む。
    assert.ok(body.includes("```ask"));
    assert.ok(body.includes("AskUserQuestion"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("共通本文は AskUserQuestion 禁止を含まない (Claude addendum 専用)", () => {
  // 共通 (Codex にも配る) 本文は AskUserQuestion に触れない。
  assert.ok(!ASK_MARKER_COMMON.includes("AskUserQuestion"));
  assert.equal(ASK_MARKER_SKILL_BODY, ASK_MARKER_COMMON);
  // Claude 用は禁止文言を含む。
  assert.ok(ASK_MARKER_CLAUDE_SYSTEM_PROMPT.includes("AskUserQuestion"));
});

// ─── stripAskBlock: 説明テキストと raw JSON の分割 ──────────────────────────
import { stripAskBlock } from "../src/ask-json.js";

test("stripAskBlock: ask ブロックを除去して説明だけ残す", () => {
  const text = [
    "選んでください:",
    "```ask",
    '{"question":"進めますか?","multiSelect":false,"options":[{"label":"はい"},{"label":"いいえ"}]}',
    "```",
  ].join("\n");
  assert.equal(stripAskBlock(text), "選んでください:");
});

test("stripAskBlock: ブロック後の後書きを保持する", () => {
  const text = ["前置き", "```ask", '{"question":"q","options":["A"]}', "```", "あとがき"].join("\n");
  assert.equal(stripAskBlock(text), "前置き\n\nあとがき");
});

test("stripAskBlock: ブロックのみなら空文字を返す", () => {
  const text = '```ask\n{"question":"q","options":["A","B"]}\n```';
  assert.equal(stripAskBlock(text), "");
});

test("stripAskBlock: フェンスが無ければ原文のまま", () => {
  const text = "ただの説明テキスト。質問カードは無い。";
  assert.equal(stripAskBlock(text), text);
});

test("stripAskBlock: JSON 文字列値に ``` が入っても途中で切れない", () => {
  const text = [
    "説明",
    "```ask",
    '{"question":"```code``` を含む?","options":["はい","いいえ"]}',
    "```",
    "末尾",
  ].join("\n");
  assert.equal(stripAskBlock(text), "説明\n\n末尾");
});

test("stripAskBlock: Windows パスの未エスケープ \ を含む JSON でも除去できる", () => {
  const text = [
    "説明文",
    "```ask",
    '{"question":"E:\Document\Ars で良い?","options":[{"label":"はい"}]}',
    "```",
  ].join("\n");
  // brace 走査は文字列状態を見るので未エスケープ \ でも JSON 末尾を見つけられる
  assert.equal(stripAskBlock(text), "説明文");
});
