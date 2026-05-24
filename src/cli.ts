import { runWrapped } from "./wrap.js";
import { runClient } from "./client.js";

const HELP = `lictor — per-session sidecar for Claude Code (LUDIARS / Li)

Usage:
  lictor claude [args...]              Wrap \`claude\` so hooks inside can drive
                                       the host terminal and talk to Concordia.

  lictor cli title <text>              Set the host terminal title (manual override).
  lictor cli title-auto                Drop the manual override; resume auto title.
  lictor cli meta                      Print this session's meta as JSON.
  lictor cli health                    Ping the sidecar.
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

  lictor --help                        Show this help.

Notes:
  - \`lictor claude ...\` exports LICTOR_PORT, LICTOR_PID, LICTOR_SESSION_ID,
    LICTOR_PERSONA_NAME, LICTOR_ROLE_LABEL into the spawned Claude Code
    process, so any subprocess (Bash tool, hooks, MCP) can reach the sidecar
    at http://127.0.0.1:\$LICTOR_PORT.
  - The sidecar's stdout IS the terminal, so OSC escapes injected by lictor
    reach the terminal — bypassing Claude Code's subprocess stdout capture.
  - Concordia integration is best-effort: failures degrade to v0.0 behavior
    (no persona, no auto-stat, no liveness). Set LICTOR_DISABLE_CONCORDIA=1
    to skip Concordia entirely. Default endpoint: 127.0.0.1:17330, override
    with CONCORDIA_HOST / CONCORDIA_PORT.
`;

async function main() {
  const argv = process.argv.slice(2);
  if (argv.length === 0 || argv[0] === "--help" || argv[0] === "-h") {
    process.stdout.write(HELP);
    process.exit(0);
  }

  const [cmd, ...rest] = argv;

  if (cmd === "claude") {
    await runWrapped(rest);
    return;
  }

  if (cmd === "cli") {
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
