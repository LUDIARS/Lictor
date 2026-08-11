import { test } from "node:test";
import assert from "node:assert/strict";
import { bypassesMarkerHold, classifyInject } from "../src/inject-origin.js";

test("classifyInject: discord / slack sources carrying a user id are human", () => {
  assert.equal(classifyInject("discord:123456789:987:555"), "human");
  assert.equal(classifyInject("slack:U0123"), "human");
});

test("classifyInject: 'progress' sources are automatic", () => {
  for (const source of [
    "auto:goal-and-go",
    "auto:inquiry",
    "taskflow:run_1:decompose",
    "revisor",
    "delegation:run_1:question",
    "initial-work",
  ]) {
    assert.equal(classifyInject(source), "automatic", source);
  }
});

test("classifyInject: the session-end instruction is lifecycle, not progress", () => {
  // 人が /end-session を叩いた結果。 保留すると /session-end を走らせないまま死ぬ。
  assert.equal(classifyInject("auto:session-end"), "lifecycle");
});

test("classifyInject: an unknown or missing source falls back to automatic", () => {
  // 出どころ不明を人間扱いすると、質問を素通りさせてしまう。安全側は「自動」。
  assert.equal(classifyInject(null), "automatic");
  assert.equal(classifyInject(undefined), "automatic");
  assert.equal(classifyInject(""), "automatic");
  assert.equal(classifyInject("discord:"), "automatic"); // user id 欠落
  assert.equal(classifyInject("discordish:1"), "automatic");
});

test("bypassesMarkerHold: only automatic injects wait for the answer", () => {
  assert.equal(bypassesMarkerHold("discord:1:2:3"), true);
  assert.equal(bypassesMarkerHold("auto:session-end"), true);
  assert.equal(bypassesMarkerHold("auto:goal-and-go"), false);
  assert.equal(bypassesMarkerHold(null), false);
});
