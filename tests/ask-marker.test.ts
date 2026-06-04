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
