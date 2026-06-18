# Lictor (Li)

Per-session sidecar that wraps **agent TUI CLIs** (Claude Code or OpenAI Codex)
so hooks running inside the session can drive the host terminal — primarily
the **window/tab title** — inject keystrokes into the wrapped TUI (`/rename`
to set the session name visible on claude.ai/code, generalized `/slash` /
`/keys` / `/answer` for any TUI), query session meta, and talk to
[Concordia](https://github.com/LUDIARS/Concordia) (the LUDIARS multi-agent
session coordinator).

LUDIARS short code: **Li**. Default loopback port: ephemeral (registered in
`LICTOR_PORT` env var that `lictor <provider> ...` injects into the child).

## Providers

| Provider              | Command               | Skill injection | Slash/keys/answer | Concordia |
|----------------------|-----------------------|-----------------|--------------------|-----------|
| Claude Code          | `lictor claude [args]`| ✅ (`--add-dir`) | ✅                  | ✅         |
| OpenAI Codex CLI     | `lictor codex [args]` | ❌ (no SKILL.md disco) | ✅                  | ✅         |
| Local LLM (Ollama)   | `lictor gemma4-12`    | ❌ (built-in agent)   | ✅                  | ✅         |

Claude/Codex/Gemini share the title/Concordia/session-meta/pty surface; only the
skill-injection paths differ. Codex's own `--add-dir` widens the writable
sandbox but doesn't trigger skill scanning, so `/v1/skill` returns 503 for
Codex sessions.

`lictor gemma4-12` (旧名 `lictor local` も alias で可) is different: it does
**not** wrap an external CLI. It spawns
Lictor itself (`lictor cli local-agent`) as a built-in lightweight chat agent
that talks to a local OpenAI-compatible endpoint (Ollama, default
`http://127.0.0.1:11434/v1`, model `gemma4:12b`). It is a light stand-in for
the codex shell when you just want a **context-keeping local LLM session** (no
tool-use / file-editing). Features: conversation-log persistence (resumable
JSONL), context-size **compaction** (summarize-and-fold past the threshold,
done by the local LLM itself — zero cloud), and lifecycle **hooks**
(SessionStart / UserPromptSubmit / Stop). Config via `LICTOR_LOCAL_*` env.
Design: `spec/local-llm-agent.md`.

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

Since v0.3 lictor spawns claude inside a pty it controls (via `node-pty`),
which lets the sidecar inject keystrokes into claude's TUI input — used
today by `POST /v1/rename` to type `/rename <text>\r` on the user's behalf
so the session name visible on claude.ai/code can be set from a hook or CLI
without the user touching the keyboard.

## Quick start

```sh
# Wrap claude. Everything else (TTY, args, exit code, signals) is passed through.
lictor claude

# Print the lictor version (works from any context, no wrapped session needed).
lictor --version
lictor -v

# From inside the resulting Claude Code session, in a Bash tool / hook:
curl -s -X POST -H 'content-type: application/json' \
  -d '{"text":"[Cr] 認証 502 デバッグ"}' \
  "http://127.0.0.1:${LICTOR_PORT}/v1/title"

# Or via the bundled CLI shortcut (also reads LICTOR_PORT):
lictor cli title "[Cr] 認証 502 デバッグ"
lictor cli title-auto                 # drop manual override, resume auto title
lictor cli rename "[Cr] 認証 502 デバッグ"  # types /rename ... into claude
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
| GET    | `/v1/version`              | —                                      | `{"name":"lictor","version":"<semver>"}` — version of the lictor binary running this sidecar (which can differ from a globally-installed `lictor` if you `npm link` from a checkout) |
| GET    | `/v1/meta`                 | —                                      | Session meta + persona JSON |
| GET    | `/v1/concordia/session`    | —                                      | `{session_id, persona, role_label, concordia_enabled, discord}` — `discord` = held Discord channel ids (session + meta) |
| POST   | `/v1/title`                | `{"text":"<title>"}`                   | Emit OSC 0 + set manual override |
| POST   | `/v1/title/auto`           | —                                      | Drop manual override + reset title (auto resumes next stat cycle) |
| POST   | `/v1/rename`               | `{"text":"<title>"}`                   | Inject `/rename <text>\r` into claude's TUI stdin (503 if not wrapping a real session) |
| POST   | `/v1/slash`                | `{cmd, args?}`                         | Generalized slash injection — sends `/<cmd> <args>\r`. `cmd` regex: `^[a-z][a-z0-9-]{0,40}$`. |
| POST   | `/v1/keys`                 | `{data}`                               | Raw keystroke injection (C0 controls stripped except `\t \n \r \b ESC`; Ctrl-C dropped to prevent accidental session kill) |
| POST   | `/v1/answer`               | `{choice, escape_first?}`              | Send `(choice-1)` Down-Arrow + Enter to answer an `AskUserQuestion` picker. `choice` 1-based, 1–50. |
| POST   | `/v1/chat`                 | `{channel, text, author_label?, in_reply_to?, scope?}` | Proxy to Concordia /v1/chat; stamps authoritative `session_id` + resolves held `discord_channel_id`; auto-fills `author_label` (anti-crosstalk — see `Concordia/spec/discord-lictor-relay.md`) |
| POST   | `/v1/report`               | `{monologue, role?}`                   | Append daily-report monologue to Concordia /v1/reports/:id/append; stamps authoritative `session_id` |
| POST   | `/v1/event`                | `{kind, payload?, ts?}`                | Proxy to Concordia /v1/sessions/:id/event |
| GET    | `/v1/conflicts`            | `?repo=<path>&branch=<name>`           | Proxy to Concordia /v1/monitor/conflicts (excludes self) |
| GET    | `/v1/skill`                | —                                      | List injected skill names + the dir claude scans |
| POST   | `/v1/skill`                | `{name, content}`                      | Write/overwrite a SKILL.md (live-reloaded by claude) |
| DELETE | `/v1/skill/<name>`         | —                                      | Remove an injected skill |
| GET    | `/v1/lictor/task`          | —                                      | Current task state `{branch, desc, updatedAt}` |
| POST   | `/v1/lictor/task`          | `{branch?, desc?}`                     | PATCH Concordia session + emit event + refresh `lictor-current-task` skill |
| GET    | `/v1/lictor/state`         | —                                      | `{notify, conflict, task}` snapshot for dashboards |
| GET    | `/v1/transcript`           | `?limit=N&raw=0\|1`                     | Read the wrapped agent's recent transcript (Claude / Codex JSONL). `limit` 1–500 (default 50). `raw=1` returns parsed JSONL objects, else slim `lineToFrame` frames. Returns `{path, available, total_lines, returned, frames\|lines}`. 503 when transcript-tail is inactive (no Concordia / no pty). |
| POST   | `/v1/internal/force-exit`  | —                                      | Kill the wrapped AI process (SIGTERM). Called by Concordia after session DELETE. 503 if sidecar is not wrapping a pty (e.g. smoke harness). |

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
| `LICTOR_TRANSCRIPT_FILE` | Absolute path of the pinned transcript JSONL — set only when the session-id was pinned (Concordia on, or `LICTOR_PIN_TRANSCRIPT=1`). Lets the wrapped CLI read its own session usage/tokens (e.g. Discutere worker-pool cost回収) |

## Env vars Lictor reads

| Var | Default | Effect |
|-----|---------|--------|
| `CONCORDIA_HOST`             | `127.0.0.1` | Where Concordia listens |
| `CONCORDIA_PORT`             | `17330`     | — |
| `LICTOR_DISABLE_CONCORDIA`   | (unset)     | Set to `1` to skip Concordia registration entirely (v0.0 behavior) |
| `LICTOR_PIN_TRANSCRIPT`      | (unset)     | Set to `1` to pin the session-id (`--session-id`) and export `LICTOR_TRANSCRIPT_FILE` to the child even when Concordia is disabled. For headless workers that need to read their own transcript |
| `CONCORDIA_DELEGATION_PROMPT_FILE` | (unset) | Set by Concordia `/v1/delegation/invoke` to a rendered prompt file. Lictor reads it and pastes+submits it into the wrapped CLI once the TUI is up (delegation auto-inject) |
| `LICTOR_DELEGATION_INJECT_DELAY_MS` | `2500` | Delay after first pty output before the delegation prompt is injected (lets the TUI finish drawing) |

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

## Skill injection (v0.2)

On startup Lictor creates a per-session directory
`~/.claude/lictor/sessions/<id>/.claude/skills/`, seeds it with the skills
listed below, and prepends `--add-dir <sessionDir>` to the spawned
`claude` so the directory is scanned at boot.

| Skill name                | Source                                                    |
|--------------------------|-----------------------------------------------------------|
| `lictor-persona`         | Concordia's `persona.skill_template` for the assigned role |
| `lictor-session-context` | Top 3 memory files under `~/.claude/projects/<cwd>/memory/` whose filename or body mentions the cwd's repo leaf |

On exit the whole session dir is removed — no clutter in `~/.claude/skills/`.

### Mid-session updates

`POST /v1/skill { name, content }` overwrites an existing SKILL.md, which
claude's file watcher reloads live. Adding a **brand-new** skill name
mid-session writes the file but claude needs a restart to discover it;
the v0.2 docs note this. CLI shortcut:

```sh
lictor cli skill list
lictor cli skill set my-skill ./my-skill.md
lictor cli skill delete my-skill
```

### Constraints

- Skill names: `^[a-z][a-z0-9-]{0,63}$` (kebab-case). Anything else 400s.
- Per-skill body cap: 32 KiB. Skills are loaded into every claude turn,
  so we don't let one balloon the context.
- Memory digest: capped at 8 KiB total, top 3 files. Index `MEMORY.md` is
  skipped (already loaded by claude on its own).

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

## Local test server

For tweaking endpoints without spinning up a real Claude Code session:

```sh
npx tsx tests/local-server.mjs
```

Brings up the sidecar with `ptyWriter` replaced by a stdout logger, so
`POST /v1/rename` prints what bytes _would have_ hit claude's TUI. Useful
for HTTP-layer iteration and curl-driven smoke checks.

## v0.4 — bidirectional Concordia loop

v0.1 was outbound only (register / chat / stat). v0.4 closes the loop by
reacting to Concordia state and relaying changes back automatically:

- **WS event reactor** — incoming WS broadcasts drive short-lived title
  marks (`[!]` for chat from another session) and force-refresh the
  title on `conflict_detected`.
- **Remote inject** — Concordia `session.inject` events whose
  `target_session_id` matches this session are sanitized
  (`sanitizeKeySeq`) and written to the pty with a trailing `\r`, landing
  in the wrapped claude as user-typed input. Three drivers share the
  Concordia API: Web UI form, other Claude sessions, external scripts.
- **60s poll loop** — when Concordia is reachable:
  - `lictor-pending-tasks` skill is rewritten from `/v1/sessions/<id>/pending-tasks`
  - `lictor-conflicts` skill + title `⚠N` prefix from `/v1/monitor/conflicts`
  - branch poll detects `git checkout -b`, PATCHes Concordia + emits
    `lictor.task.changed` event + refreshes `lictor-current-task` skill
- **Live session-state skill** — every 10-min stat cycle also overwrites
  `lictor-session-state` (current branch / dirty / unpushed snapshot).
- **Task declaration** — `lictor cli task set --branch <b> --desc <text>`
  for explicit task description (auto branch detection covers the rest).
  Seeded `lictor-task-protocol` skill tells the wrapped claude to call it.
- **Session-end report** — `DELETE /v1/sessions/<id>`'s `report` field is
  now printed to stderr on exit.

## Status

- v0.7 — Provider abstraction; `lictor codex [args]` added (skill injection cleanly disabled for Codex pre-Agent-Skills; re-enabled in v0.5 cont. via `~/.agents/skills/`). Merged on top of v0.5+v0.6 main work (fs-rpc, permission-hook, transcript-tail).
- v0.6 — Tool permission proxy: PreToolUse hook bridge writes a session-scoped `--settings` file so claude defers ASK decisions to Concordia's Web UI (PR-D).
- v0.5 — `transcript-tail` relays Claude's session JSONL to Concordia (PR-C). `filesystem-rpc` adds cwd-confined read/list/grep (PR-E). `transcript-frame` ingest (PR-F).
- v0.4.2 — `lictor_port` published into Concordia session metadata after sidecar bind (PR-B).
- v0.4.1 — `session.inject` reactor handles remote instructions from Concordia (Web UI / other sessions / scripts → ptyWriter as user input).
- v0.4 — Bidirectional Concordia loop (WS reactor + 60s poll for tasks/conflicts/branch + session-state skill + end report) + generalized slash/keys/answer pty injection.
- v0.3 — pty-wrapped claude (node-pty) + `/v1/rename` keystroke injection + `lictor cli rename`.
- v0.2 — Skill injection (persona + repo-relevant memories) via `--add-dir`.
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
