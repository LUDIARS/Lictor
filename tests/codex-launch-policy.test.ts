import test from "node:test";
import assert from "node:assert/strict";
import {
  codexAppServerConfigArgs,
  codexSandboxArgs,
  codexSandboxFromEnv,
  configDeclaresNodeRepl,
  nodeReplDisableArgs,
} from "../src/codex-launch-policy.js";
import { turnSandboxPolicy } from "../src/codex-app-server-session.js";

test("codexSandboxFromEnv: 未設定は null、既知の値だけ受け、不正値は止める", () => {
  assert.equal(codexSandboxFromEnv({}), null);
  assert.equal(codexSandboxFromEnv({ LICTOR_CODEX_SANDBOX: " " }), null);
  assert.equal(codexSandboxFromEnv({ LICTOR_CODEX_SANDBOX: "danger-full-access" }), "danger-full-access");
  assert.equal(codexSandboxFromEnv({ LICTOR_CODEX_SANDBOX: "read-only" }), "read-only");
  assert.throws(() => codexSandboxFromEnv({ LICTOR_CODEX_SANDBOX: "full" }), /invalid LICTOR_CODEX_SANDBOX/);
});

test("codexSandboxArgs: 枠なしは承認も求めない、未指定は何も足さない", () => {
  assert.deepEqual(codexSandboxArgs(null), []);
  assert.deepEqual(codexSandboxArgs("danger-full-access"), [
    "--sandbox", "danger-full-access", "--ask-for-approval", "never",
  ]);
  assert.deepEqual(codexSandboxArgs("read-only"), ["--sandbox", "read-only"]);
});

test("configDeclaresNodeRepl: [mcp_servers.node_repl] の表だけを見る", () => {
  assert.equal(configDeclaresNodeRepl(null), false);
  assert.equal(configDeclaresNodeRepl("[mcp_servers.node_repl]\ncommand = 'x'\n"), true);
  assert.equal(configDeclaresNodeRepl("a = 1\n  [ mcp_servers.\"node_repl\" ] # desktop\n"), true);
  // 子テーブルや別名の server は対象外。
  assert.equal(configDeclaresNodeRepl("[mcp_servers.node_repl.env]\nA = '1'\n"), false);
  assert.equal(configDeclaresNodeRepl("[mcp_servers.node_repl_x]\n"), false);
  assert.equal(configDeclaresNodeRepl("# [mcp_servers.node_repl]\n"), false);
});

test("nodeReplDisableArgs: Cc が sandbox を決め、かつ宣言があるときだけ外す", () => {
  // 未定義の server へ -c mcp_servers.node_repl.* を付けると codex が起動に失敗する。
  assert.deepEqual(nodeReplDisableArgs("danger-full-access", false), []);
  assert.deepEqual(nodeReplDisableArgs(null, true), []);
  assert.deepEqual(nodeReplDisableArgs("danger-full-access", true), ["-c", "mcp_servers.node_repl.enabled=false"]);
});

test("codexAppServerConfigArgs: model を -c に直し、TUI 専用の引数は落とす", () => {
  assert.deepEqual(
    codexAppServerConfigArgs([
      "--model", "gpt-6-astra",
      "-c", "model_reasoning_effort=\"xhigh\"",
      "--config", "a.b=1",
      "--enable", "goals",
      "--no-alt-screen",
      "prompt text",
    ]),
    [
      "-c", "model=\"gpt-6-astra\"",
      "-c", "model_reasoning_effort=\"xhigh\"",
      "-c", "a.b=1",
      "--enable", "goals",
    ],
  );
  assert.deepEqual(codexAppServerConfigArgs(["-m", "sol"]), ["-c", "model=\"sol\""]);
  assert.deepEqual(codexAppServerConfigArgs(["--model=luna"]), ["-c", "model=\"luna\""]);
  assert.deepEqual(codexAppServerConfigArgs(["--model"]), []);
});

test("turnSandboxPolicy: 未指定は従来の workspace-write、枠なしは dangerFullAccess", () => {
  assert.deepEqual(turnSandboxPolicy(null, "E:/repo"), {
    type: "workspaceWrite",
    writableRoots: ["E:/repo"],
    networkAccess: false,
  });
  assert.deepEqual(turnSandboxPolicy("danger-full-access", "E:/repo"), { type: "dangerFullAccess" });
  assert.deepEqual(turnSandboxPolicy("read-only", "E:/repo"), { type: "readOnly" });
});
