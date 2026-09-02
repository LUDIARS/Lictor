import { test } from "node:test";
import assert from "node:assert/strict";
import {
  CHILD_SESSION_ENV_KEYS,
  detachedWorkspaceTrustPrompt,
  normalizePtyTerm,
  stripChildSessionEnv,
} from "../src/wrap.js";
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

test("normalizePtyTerm: detached supervisor の dumb/空 TERM を PTY 向けに正規化", () => {
  assert.equal(normalizePtyTerm(undefined), "xterm-256color");
  assert.equal(normalizePtyTerm("dumb"), "xterm-256color");
  assert.equal(normalizePtyTerm(" unknown "), "xterm-256color");
  assert.equal(normalizePtyTerm("screen-256color"), "screen-256color");
});

test("detachedWorkspaceTrustPrompt: Codex/Claude の限定した trust picker だけを検出", () => {
  // codex: カーソルが見えない番号選択式 UI → Enter のみ (既定 Yes)。
  assert.deepEqual(
    detachedWorkspaceTrustPrompt(
      "codex",
      "\u001b[3;3HDo\u001b[3;6Hyou\u001b[3;10Htrust\u001b[3;16Hthe\u001b[3;20Hcontents\u001b[3;29Hof\u001b[3;32Hthis\u001b[3;37Hdirectory? \u001b[7;1H1. Yes, continue \u001b[8;3H2. No, quit",
    ),
    ["\r"],
  );
  assert.equal(detachedWorkspaceTrustPrompt("codex", "Ask Codex to do anything"), null);
  assert.equal(detachedWorkspaceTrustPrompt("gemini", "Yes, continue No, quit"), null);
});

test("detachedWorkspaceTrustPrompt: Claude のカーソル位置と表示順から Yes を選ぶ", () => {
  // 新しいレイアウトでは「❯ No, exit」が先頭既定。Enter だけでは No を選ぶため、
  // 下段の Yes へ移動する。
  assert.deepEqual(
    detachedWorkspaceTrustPrompt(
      "claude",
      "Quick safety check: Is this a project you created or one you trust? "
      + "\u001b[15;2H❯\u001b[1CNo,\u001b[1Cexit \u001b[16;4HYes,\u001b[1CI\u001b[1Ctrust\u001b[1Cthis\u001b[1Cfolder",
    ),
    ["\u001b[B", "\r"],
  );
  // カーソルが Yes にあるレイアウトなら Enter だけ。
  assert.deepEqual(
    detachedWorkspaceTrustPrompt(
      "claude",
      "Quick safety check: ❯ Yes, I trust this folder No, exit",
    ),
    ["\r"],
  );
  // カーソルがない旧番号 UI は先頭の Yes が既定なので Enter だけ。
  assert.deepEqual(
    detachedWorkspaceTrustPrompt(
      "claude",
      "Quick safety check: Is this a project? 1. Yes, I trust this folder 2. No, exit",
    ),
    ["\r"],
  );
  // カーソルがなくても No が先頭なら下段の Yes へ移動する。
  assert.deepEqual(
    detachedWorkspaceTrustPrompt(
      "claude",
      "Quick safety check: 1. No, exit 2. Yes, I trust this folder",
    ),
    ["\u001b[B", "\r"],
  );
});

test("detachedWorkspaceTrustPrompt: No が Yes より後なら上方向へ移動する", () => {
  assert.deepEqual(
    detachedWorkspaceTrustPrompt(
      "codex",
      "Do you trust the contents of this directory? "
      + "Yes, continue ❯ No, quit",
    ),
    ["\u001b[A", "\r"],
  );
});

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
