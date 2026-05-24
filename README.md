# Lictor (Li)

Per-session sidecar that wraps `claude` so hooks running inside a Claude Code
session can drive the host terminal — primarily the **window/tab title** —
query session meta, and talk to [Concordia](https://github.com/LUDIARS/Concordia)
(the LUDIARS multi-agent session coordinator).

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

On top of that, v0.1 also registers the wrapped session with Concordia,
gets back a persona, drives an auto-generated title from the persona +
repo + branch + dirty/unpushed marks, runs the 10-minute /stat polling
that used to live in per-session hooks, and proxies chat/event/conflicts
calls so hooks don't have to know the Concordia URL.

## Quick start

```sh
# Wrap claude. Everything else (TTY, args, exit code, signals) is passed through.
lictor claude

# From inside the resulting Claude Code session, in a Bash tool / hook:
curl -s -X POST -H 'content-type: application/json' \
  -d '{"text":"[Cr] 認証 502 デバッグ"}' \
  "http://127.0.0.1:${LICTOR_PORT}/v1/title"

# Or via the bundled CLI shortcut (also reads LICTOR_PORT):
lictor cli title "[Cr] 認証 502 デバッグ"
lictor cli title-auto                 # drop manual override, resume auto title
lictor cli meta                       # PID / cwd / WT_SESSION / persona
lictor cli session                    # Concordia session id + persona JSON
lictor cli chat team "デプロイ前確認" # author_label auto-filled from persona
lictor cli event branch.created '{"branch":"feat/x"}'
lictor cli conflicts                  # other sessions on the same repo
```

## Sidecar API (loopback only)

| Method | Path                       | Body / params                          | Effect |
|--------|----------------------------|----------------------------------------|--------|
| GET    | `/v1/health`               | —                                      | `{"ok":true}` |
| GET    | `/v1/meta`                 | —                                      | Session meta + persona JSON |
| GET    | `/v1/concordia/session`    | —                                      | `{session_id, persona, role_label, concordia_enabled}` |
| POST   | `/v1/title`                | `{"text":"<title>"}`                   | Emit OSC 0 + set manual override |
| POST   | `/v1/title/auto`           | —                                      | Drop manual override + reset title (auto resumes next stat cycle) |
| POST   | `/v1/chat`                 | `{channel, text, author_label?, scope?}` | Proxy to Concordia /v1/chat; auto-fills `author_label` |
| POST   | `/v1/event`                | `{kind, payload?, ts?}`                | Proxy to Concordia /v1/sessions/:id/event |
| GET    | `/v1/conflicts`            | `?repo=<path>&branch=<name>`           | Proxy to Concordia /v1/monitor/conflicts (excludes self) |

All requests must originate from `127.0.0.1` / `::1`. The port is bound on
`127.0.0.1:0` (ephemeral) and exported as `$LICTOR_PORT` to the wrapped
`claude` process. Body cap: 64 KiB. Title length cap: 200 chars (C0 / DEL
stripped first).

## Env vars injected into the child

| Var | Description |
|-----|-------------|
| `LICTOR_PORT`           | Loopback port of this session's sidecar |
| `LICTOR_PID`            | PID of the lictor wrapper |
| `LICTOR_SESSION_START`  | ISO timestamp when the wrapper started |
| `LICTOR_SESSION_ID`     | Concordia session id (when registration succeeded) |
| `LICTOR_PERSONA_NAME`   | Persona `name` (role kind, e.g. `深掘り型`) |
| `LICTOR_ROLE_LABEL`     | Convenience: server-supplied `role_label` |
| `CONCORDIA_SESSION_ID`  | Same as `LICTOR_SESSION_ID`; kept for compatibility with existing Concordia hooks |

## Env vars Lictor reads

| Var | Default | Effect |
|-----|---------|--------|
| `CONCORDIA_HOST`             | `127.0.0.1` | Where Concordia listens |
| `CONCORDIA_PORT`             | `17330`     | — |
| `LICTOR_DISABLE_CONCORDIA`   | (unset)     | Set to `1` to skip Concordia registration entirely (v0.0 behavior) |

## Concordia integration

When `lictor claude ...` starts, it:

1. Registers a new Concordia session (`POST /v1/sessions` with a generated
   `lictor-<uuid>` id), capturing `repo_path = cwd`, current git `branch`,
   `host`, and metadata (wt_session, pid, ...).
2. Opens a WebSocket to `ws://<concordia>/ws?session=<id>` for liveness —
   Concordia treats an active WS as the heartbeat substitute, so Lictor
   doesn't have to POST heartbeats.
3. Computes an **auto title** from `(persona, repo leaf, branch, dirty,
   unpushed)` and emits it as the initial OSC. Auto title refreshes every
   stat cycle. A `POST /v1/title` from a hook sets a manual override that
   suppresses auto until `POST /v1/title/auto` clears it.
4. Every 10 minutes, gathers a `RepoStat` (branch, dirty counts, unpushed
   commits, last commit subject) and `POST /v1/stat/<id>` to Concordia.
   This replaces the per-session `/stat` polling that previously lived in
   user-managed hooks.
5. On exit, closes the WS, calls `DELETE /v1/sessions/<id>` for a clean
   shutdown, and resets the terminal title.

If Concordia is unreachable at startup, Lictor logs a one-line warning and
degrades to v0.0 behavior (title set/get/meta still work; chat/event/
conflicts return 503).

## Migration from raw Concordia hooks

Existing hooks that call Concordia directly (`curl http://127.0.0.1:17330/...`)
keep working in lictor-wrapped sessions, but they're now redundant:

| Old hook                          | New hook                                    |
|----------------------------------|---------------------------------------------|
| Session register                 | (handled by lictor at wrapper start)        |
| Heartbeat / stat polling cron    | (handled by lictor's 10-min cron)           |
| Chat curl with manual author_label | `lictor cli chat <channel> <text>`        |
| Conflicts check before `git checkout -b` | `lictor cli conflicts`              |

For sessions NOT launched via `lictor claude` (e.g. raw `claude` invocations),
the old hooks remain the only path. We recommend switching launchers (shell
alias, Windows Terminal profile command) to `lictor claude` and removing the
old hook entries after one stable week.

## Status

- v0.1 — Concordia integration + auto title + stat cron + chat/event/conflicts proxies.
- v0.0 — title set/reset, meta GET, health.

Not yet published to npm; install from source.

```sh
git clone https://github.com/LUDIARS/Lictor.git
cd Lictor
npm install
npm run build
npm link   # exposes `lictor` on PATH
```

## License

MIT
