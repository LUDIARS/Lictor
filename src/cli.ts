import { runWrapped } from "./wrap.js";
import { runClient } from "./client.js";

const HELP = `lictor — per-session sidecar for Claude Code (LUDIARS / Li)

Usage:
  lictor claude [args...]        Wrap \`claude\` so hooks inside can drive the host terminal.
  lictor cli title <text>        Set the host terminal title (requires LICTOR_PORT in env).
  lictor cli meta                Print this session's meta as JSON.
  lictor cli health              Ping the sidecar.
  lictor --help                  Show this help.

Notes:
  - \`lictor claude ...\` exports LICTOR_PORT and LICTOR_PID into the spawned
    Claude Code process, so any subprocess (Bash tool, hooks, MCP) can reach the
    sidecar at http://127.0.0.1:\$LICTOR_PORT.
  - The sidecar's stdout IS the terminal, so OSC escapes injected by lictor
    reach the terminal — bypassing Claude Code's subprocess stdout capture.
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
