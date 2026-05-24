# Lictor (Li)

Per-session sidecar that wraps `claude` so hooks running inside a Claude Code
session can drive the host terminal — primarily the **window/tab title** — and
query session meta.

LUDIARS short code: **Li**. Default loopback port: ephemeral (registered in
`LICTOR_PORT` env var that `lictor claude ...` injects into the child).

## Why

Claude Code captures the stdout of its own subprocesses (Bash tool, hooks,
MCP). Any OSC escape sequence (`\e]0;TITLE\a`) printed by a subprocess is
absorbed by Claude Code's renderer and never reaches the terminal. Likewise
Win32 `SetConsoleTitle` from a subprocess writes into the private pty Claude
allocates for that command. The well-known consequence (anthropics/claude-code
#15802, #18326, #20441) is that you cannot change the terminal title from
inside a running Claude Code session.

`lictor` works around this by being the **parent** of `claude`: its own
`process.stdout` is the real terminal pty, so OSC sequences emitted from
`lictor` reach Windows Terminal / iTerm2 / Alacritty / etc. directly.
Subprocesses inside Claude Code talk to `lictor` over a loopback HTTP sidecar,
and `lictor` does the actual escape-sequence write.

## Quick start

```sh
# Wrap claude. Everything else (TTY, args, exit code, signals) is passed through.
lictor claude

# From inside the resulting Claude Code session, in a Bash tool / hook:
curl -s -X POST -H 'content-type: application/json' \
  -d '{"text":"[Ar] 作業中"}' \
  "http://127.0.0.1:${LICTOR_PORT}/v1/title"

# Or via the bundled CLI shortcut (also reads LICTOR_PORT):
lictor cli title "[Ar] 作業中"

# Read session meta (cwd, start time, parent PID, WT_SESSION, ...):
lictor cli meta
```

## Sidecar API (loopback only)

| Method | Path           | Body / params           | Effect |
|--------|----------------|-------------------------|--------|
| GET    | `/v1/health`   | —                       | `{"ok":true}` |
| GET    | `/v1/meta`     | —                       | Session meta JSON |
| POST   | `/v1/title`    | `{"text":"<title>"}`    | Emit OSC 0 with sanitized title |

All requests must originate from `127.0.0.1` / `::1`. The port is bound on
`127.0.0.1:0` (ephemeral) and exported as `$LICTOR_PORT` to the wrapped
`claude` process.

## Env vars injected into the child

| Var | Description |
|-----|-------------|
| `LICTOR_PORT` | Loopback port of this session's sidecar |
| `LICTOR_PID`  | PID of the lictor wrapper |
| `LICTOR_SESSION_START` | ISO timestamp when the wrapper started |

## Roadmap

- v0.0 (this scaffold) — title set/reset, meta GET, health
- v0.1 — `/v1/title` history + per-session state file under `~/.claude/lictor/`
- v0.2 — hook helpers (PostToolUse / Stop) that other LUDIARS services can
  subscribe to; integrate with Concordia stat polling
- v0.3 — Windows Terminal window/pane discovery (WT_SESSION → wt.exe focus)
- Later — common hook host for Memoria / Concordia / etc.

## Status

v0.0 scaffold. Not yet published to npm; install from source.

```sh
git clone https://github.com/LUDIARS/Lictor.git
cd Lictor
npm install
npm run build
# then either npm link, or invoke ./bin/lictor.mjs directly.
```

## License

MIT
