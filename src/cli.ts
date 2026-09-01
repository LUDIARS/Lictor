import { runWrapped } from "./wrap.js";
import { runClient } from "./client.js";
import { getProvider } from "./provider.js";
import { runPermissionHook } from "./permission-hook.js";
import { runAskQuestionHook } from "./ask-question-hook.js";
import { runNotificationHook } from "./notification-hook.js";
import { runSendFileHook } from "./send-file-hook.js";
import { reportPermissionAudit } from "./permission-audit-report.js";
import { runSessionIdHook } from "./session-id-hook.js";
import { runLocalAgent } from "./local-agent/index.js";
import { LICTOR_NAME, LICTOR_VERSION } from "./version.js";
import { installVestigiumBestEffort } from "./vestigium.js";

const HELP = `lictor — per-session sidecar for agent TUI CLIs (LUDIARS / Li)

Usage:
  lictor claude [args...]              Wrap Claude Code. Skill injection + auto
                                       title + Concordia full integration.
  lictor codex [args...]               Wrap OpenAI Codex CLI. pty + title +
                                       Concordia + skill injection via
                                       ~/.agents/skills/ (per-session prefix).
  lictor gemini [args...]              Wrap Gemini CLI. pty + title + Concordia
                                       (no skill injection — Gemini lacks a
                                       SKILL.md discovery mechanism).
  lictor gemma4-12 [args...]           ローカル LLM (Ollama) の軽量チャット
                                       エージェント (既定モデル gemma4:12b)。会話ログ
                                       永続 + 文脈 compaction + hook。pty + title +
                                       Concordia。LICTOR_LOCAL_MODEL 等で設定可。
                                       旧名 \`lictor local\` もエイリアスで起動可。

  lictor cli title <text>              Set the host terminal title (manual override).
  lictor cli title-auto                Drop the manual override; resume auto title.
  lictor cli rename <text>             Inject \`/rename <text>\` into claude's TUI
                                       — updates the session name visible on
                                       claude.ai/code and the TUI prompt.
  lictor cli meta                      Print this session's meta as JSON.
  lictor cli health                    Ping the sidecar.
  lictor cli version                   Print the running sidecar's lictor version (falls back to the local CLI version when not wrapped).
  lictor cli session                   Print Concordia session id / persona.
  lictor cli chat <channel> <text...>  Post to Concordia chat (author_label
                                       auto-filled from persona).
  lictor cli event <kind> [json]       Post a session event to Concordia.
  lictor cli conflicts [repo] [branch] Ask Concordia which other sessions are
                                       touching the same repo/branch.
  lictor cli skill list                List currently-injected skill names.
  lictor cli skill set <name> <file>   Write/overwrite a SKILL.md from a file.
                                       Edits to existing skills hot-reload in
                                       claude; brand-new names need a restart.
  lictor cli skill delete <name>       Remove an injected skill.

  lictor cli task get                  Print this session's relayed task state.
  lictor cli task set [--branch <b>] [--desc <text>]
                                       Declare working branch/task to Concordia
                                       (PATCH session + emit event + refresh
                                       lictor-current-task skill). Branch is
                                       auto-detected if omitted.
  lictor cli implement begin [--cwd <path>] --task <text>
                                       Use the Cc implementation fast path.
                                       Repo, origin, branch, and
                                       project code are resolved automatically.
  lictor cli implement service <code> <start|stop|restart> [--note <text>]
                                       Run Excubitor control with Cc testing
                                       claim/release in one tool request.
  lictor cli implement review          Submit or retry the Revisor local PR.
  lictor cli pr submit [--repo <path>] [--branch <name>]
                                       Submit a local PR without requiring an
                                       implementation-session repository binding.
  lictor cli state                     Print live notify/conflict/task state.

  lictor cli slash <cmd> [args...]     Inject \`/<cmd> <args>CR\` into the wrapped
                                       claude's TUI stdin. cmd must match
                                       ^[a-z][a-z0-9-]{0,40}\$ (Claude Code's
                                       slash-command grammar).
  lictor cli {clear|compact|help|cost|export|init|model} [args...]
                                       Shortcuts for the above (just calls
                                       \`lictor cli slash <name> ...\`).

  lictor cli keys <data>               Inject raw keystrokes into claude's TUI
                                       stdin (C0 controls stripped except
                                       Enter, Tab, Backspace, ESC).
  lictor cli answer <N> [--escape]     Answer an AskUserQuestion picker by
                                       sending (N-1) Down-Arrow + Enter.
                                       --escape sends ESC first.
  lictor cli {enter|down|up|esc}       One-key shortcuts (Enter, Down, Up, ESC).

  lictor cli permission-audit [--date YYYY-MM-DD] [--file <path>]
                                       Summarise the permission audit trail:
                                       what ran without ever asking a human,
                                       which of it matched no settings.json
                                       rule (= allow gaps), and which commands
                                       can slip past prefix rules.

  lictor --help                        Show this help.
  lictor --version | -v                Print lictor version and exit.

Notes:
  - \`lictor claude ...\` exports LICTOR_PORT, LICTOR_PID, LICTOR_SESSION_ID,
    LICTOR_PERSONA_NAME, LICTOR_ROLE_LABEL into the spawned Claude Code
    process, so any subprocess (Bash tool, hooks, MCP) can reach the sidecar
    at http://127.0.0.1:\$LICTOR_PORT.
  - The sidecar's stdout IS the terminal, so OSC escapes injected by lictor
    reach the terminal — bypassing Claude Code's subprocess stdout capture.
  - Concordia integration is best-effort: failures degrade to v0.0 behavior
    (no persona, no auto-stat, no liveness). Set LICTOR_DISABLE_CONCORDIA=1
    to skip Concordia entirely. Default endpoint: 127.0.0.1:11111, override
    with CONCORDIA_HOST / CONCORDIA_PORT.
`;

/**
 * 単一 entrypoint。 短命な `lictor cli ...` (title / rename / task / hook) は観測基盤を
 * 読み込まず、 Vestigium の初期化は long-running な provider ラッパと `cli local-agent`
 * の起動境界に限定する — 観測 package の build 状態が session control を止めないため。
 *
 * @implements TASK-CLI-ENTRYPOINT-BOUNDARY (spec/feature/task-protocol.md)
 */
async function main() {
  const argv = process.argv.slice(2);
  if (argv.length === 0 || argv[0] === "--help" || argv[0] === "-h") {
    process.stdout.write(HELP);
    process.exit(0);
  }

  if (argv[0] === "--version" || argv[0] === "-v") {
    process.stdout.write(`${LICTOR_NAME} ${LICTOR_VERSION}\n`);
    process.exit(0);
  }

  const [cmd, ...rest] = argv;

  // Provider commands: `lictor claude [args]`, `lictor codex [args]`, etc.
  const provider = getProvider(cmd);
  if (provider) {
    await installVestigiumBestEffort();
    await runWrapped(rest, provider);
    return;
  }

  if (cmd === "cli") {
    // permission-hook bypasses the LICTOR_PORT requirement check in
    // runClient — it must NEVER error/exit-nonzero (claude would block
    // tool execution waiting for hook output). Internal fallback paths
    // emit no JSON on stdout and exit 0 (claude falls through to its
    // built-in permission flow).
    if (rest[0] === "permission-hook") {
      await runPermissionHook();
      return;
    }
    // ask-question-hook も同様に LICTOR_PORT チェックを迂回し、 出力 / exit code で
    // picker を絶対に止めない (内部で全エラーを飲み込み exit 0)。
    if (rest[0] === "ask-question-hook") {
      await runAskQuestionHook();
      return;
    }
    // notification-hook は Claude が入力待ちで止まったときだけ来る。 出力を持たない
    // hook なので、 失敗しても何も書かず exit 0 (セッションを更に止めない)。
    if (rest[0] === "notification-hook") {
      await runNotificationHook();
      return;
    }
    // send-file-hook は SendUserFile の PostToolUse。 ファイルは既に harness へ
    // 渡った後なので、 中継に失敗しても何も書かず exit 0 (セッションを止めない)。
    if (rest[0] === "send-file-hook") {
      await runSendFileHook();
      return;
    }
    // 監査 JSONL の集計。 sidecar 不要 (ファイルを読むだけ)。
    if (rest[0] === "permission-audit") {
      process.stdout.write(`${reportPermissionAudit(rest.slice(1))}\n`);
      return;
    }
    // session-id-hook も同様に LICTOR_PORT を要求せず、 失敗しても起動を止めない
    // (SessionStart hook)。 現 claude session_id を state ファイルに記録する。
    if (rest[0] === "session-id-hook") {
      await runSessionIdHook(rest.slice(1));
      return;
    }
    // `lictor local` provider が pty で起動する内部サブコマンド (= ローカル LLM REPL)。
    // 直接ユーザが叩くことも可。LICTOR_PORT 等は wrap が env で渡す。
    if (rest[0] === "local-agent") {
      await installVestigiumBestEffort();
      await runLocalAgent();
      return;
    }
    await runClient(rest);
    return;
  }

  process.stderr.write(`lictor: unknown command '${cmd}'\n\n` + HELP);
  process.exit(2);
}

main().catch((err) => {
  process.stderr.write(`lictor: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
