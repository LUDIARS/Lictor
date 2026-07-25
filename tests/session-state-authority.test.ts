import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  decodeSessionStateDirArgument,
  encodeSessionStateDirArgument,
} from "../src/session-state-authority.js";
import {
  recordSessionIdHookPayload,
  resolveSessionIdHookStateDir,
} from "../src/session-id-hook.js";
import {
  claudeSessionStatePath,
  claudeTranscriptStatePath,
  resolveActiveReposDir,
} from "../src/active-repos.js";

test("session state authority: Windows path を shell-safe な一語で往復する", () => {
  const stateDir = "E:\\Document\\Ars With Spaces\\repo & tools\\.claude\\state";
  const argument = encodeSessionStateDirArgument(stateDir);
  assert.match(argument, /^--state-dir-b64 [A-Za-z0-9_-]+$/);
  assert.equal(decodeSessionStateDirArgument(argument.split(" ")), stateDir);
});

test("session state authority: 明示引数が無い・壊れている場合は authority とみなさない", () => {
  assert.equal(decodeSessionStateDirArgument([]), null);
  assert.equal(decodeSessionStateDirArgument(["--state-dir-b64", "not+base64"]), null);
});

test("session state authority: hook runtime の CLAUDE_PROJECT_DIR が異なっても wrap の正本を維持する", () => {
  const wrapEnv = { LUDIARS_ROOT: "E:\\Document\\Ars" } as NodeJS.ProcessEnv;
  const hookEnv = {
    ...wrapEnv,
    CLAUDE_PROJECT_DIR: "E:\\Document\\Ars\\Lictor",
  } as NodeJS.ProcessEnv;
  const wrapperStateDir = resolveActiveReposDir(wrapEnv);
  const hookDefaultStateDir = resolveActiveReposDir(hookEnv);
  assert.notEqual(hookDefaultStateDir, wrapperStateDir, "回帰条件: env 再解決なら正本が分岐する");

  const args = encodeSessionStateDirArgument(wrapperStateDir).split(" ");
  assert.equal(resolveSessionIdHookStateDir(args, hookEnv), wrapperStateDir);
});

test("SessionStart hook: runtime env と異なる明示 authority へ session/transcript を書く", () => {
  const root = mkdtempSync(join(tmpdir(), "lictor authority with spaces-"));
  try {
    const wrapperStateDir = join(root, "workspace & root", ".claude", "state");
    const runtimeProjectDir = join(root, "different hook project");
    const lictorId = "lictor-authority-test";
    const hookEnv = {
      LUDIARS_ROOT: join(root, "workspace & root"),
      CLAUDE_PROJECT_DIR: runtimeProjectDir,
      LICTOR_SESSION_ID: lictorId,
    } as NodeJS.ProcessEnv;
    const args = encodeSessionStateDirArgument(wrapperStateDir).split(" ");
    const transcriptPath = join(root, "Claude Sessions", "session.jsonl");

    recordSessionIdHookPayload(
      JSON.stringify({
        session_id: "claude-session-id",
        transcript_path: transcriptPath,
      }),
      args,
      hookEnv,
    );

    assert.equal(
      readFileSync(claudeSessionStatePath(wrapperStateDir, lictorId), "utf8"),
      "claude-session-id",
    );
    assert.equal(
      readFileSync(claudeTranscriptStatePath(wrapperStateDir, lictorId), "utf8"),
      transcriptPath,
    );
    const divergentStateDir = resolveActiveReposDir(hookEnv);
    assert.equal(
      existsSync(claudeSessionStatePath(divergentStateDir, lictorId)),
      false,
      "hook runtime の CLAUDE_PROJECT_DIR 側には誤書き込みしない",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
