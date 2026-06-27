import { test } from "node:test";
import assert from "node:assert/strict";
import { CHILD_SESSION_ENV_KEYS, stripChildSessionEnv } from "../src/wrap.js";
import { PROVIDERS } from "../src/provider.js";

// claude-desktop 由来の子セッションマーカーが wrapped claude へ再混入しないことを
// 構造的に検知する回帰テスト。 これらが残ると claude が transcript JSONL を永続化
// しなくなり、 地の文中継が全停止する (PR #64 で修正した本症状)。

const CHILD_ENV: NodeJS.ProcessEnv = {
  CLAUDE_CODE_CHILD_SESSION: "1",
  CLAUDE_CODE_ENTRYPOINT: "claude-desktop",
  CLAUDE_CODE_SESSION_ID: "00000000-0000-0000-0000-000000000000",
  PATH: "/usr/bin",
  CLAUDE_CODE_OAUTH_TOKEN: "keep-me",
};

test("stripChildSessionEnv(claude): 子セッションマーカーを全て除去する", () => {
  const out = stripChildSessionEnv({ ...CHILD_ENV }, PROVIDERS.claude);
  for (const key of CHILD_SESSION_ENV_KEYS) {
    assert.equal(out[key], undefined, `${key} は claude では strip される`);
  }
});

test("stripChildSessionEnv(claude): 認証/一般 env は保持する", () => {
  const out = stripChildSessionEnv({ ...CHILD_ENV }, PROVIDERS.claude);
  // OAuth/exec 系は認証に必要なので残す。 一般 env も触らない。
  assert.equal(out.CLAUDE_CODE_OAUTH_TOKEN, "keep-me");
  assert.equal(out.PATH, "/usr/bin");
});

test("stripChildSessionEnv(codex): claude 以外では何も strip しない", () => {
  const out = stripChildSessionEnv({ ...CHILD_ENV }, PROVIDERS.codex);
  for (const key of CHILD_SESSION_ENV_KEYS) {
    assert.equal(out[key], CHILD_ENV[key], `${key} は codex では保持される`);
  }
});

test("stripChildSessionEnv: 入力 env を破壊しない (常に新オブジェクトを返す)", () => {
  const input: NodeJS.ProcessEnv = { ...CHILD_ENV };
  const out = stripChildSessionEnv(input, PROVIDERS.claude);
  // 入力は無傷
  assert.equal(input.CLAUDE_CODE_CHILD_SESSION, "1");
  // 返り値は別オブジェクト
  assert.notEqual(out, input);
});
