import { test } from "node:test";
import assert from "node:assert/strict";
import {
  SESSION_END_SKILL_BODY,
  SESSION_END_SKILL_DESCRIPTION,
  SESSION_END_SKILL_NAME,
} from "../src/session-end-skill.js";
import { renderSkillMd, sanitizeSkillName } from "../src/skill-injector.js";

test("session-end skill: name is valid (sanitizer accepts it)", () => {
  assert.equal(sanitizeSkillName(SESSION_END_SKILL_NAME), SESSION_END_SKILL_NAME);
});

test("session-end skill: 冒頭 ack ステップが明示されている", () => {
  // ack を出さないと wrapper が「アプリケーション無応答」 と判定される
  // — これが skill 化の主目的なので、 必ず body に残っていること.
  assert.match(SESSION_END_SKILL_BODY, /受付応答/);
  assert.match(SESSION_END_SKILL_BODY, /必須/);
});

test("session-end skill: 独白生成は provider 不問で自分が書く指示", () => {
  // 「Claude に書いてもらう」 「上位 AI に丸投げ」 を明示的に否定する文言が
  // 残っていることを check. Codex セッションでも Codex 自身が書く指針.
  assert.match(SESSION_END_SKILL_BODY, /独白/);
  assert.match(SESSION_END_SKILL_BODY, /provider が誰であっても/);
});

test("session-end skill: ログ保存先パスを明示", () => {
  // E:/Document/Ars/session-logs/YYYY-MM-DD.md という運用と一致しているか.
  assert.match(SESSION_END_SKILL_BODY, /session-logs\/YYYY-MM-DD\.md/);
});

test("session-end skill: renderSkillMd と組み合わせると有効な frontmatter md になる", () => {
  const md = renderSkillMd({
    name: SESSION_END_SKILL_NAME,
    description: SESSION_END_SKILL_DESCRIPTION,
    body: SESSION_END_SKILL_BODY,
  });
  assert.match(md, /^---\nname: session-end\ndescription: /);
  assert.match(md, /---\n\n# session-end/);
});

test("session-end skill: 32 KiB 制限に収まる", () => {
  // skill-injector の MAX_SKILL_BYTES に余裕で収まる粒度に保つ.
  const md = renderSkillMd({
    name: SESSION_END_SKILL_NAME,
    description: SESSION_END_SKILL_DESCRIPTION,
    body: SESSION_END_SKILL_BODY,
  });
  assert.ok(Buffer.byteLength(md, "utf8") < 32 * 1024);
});
