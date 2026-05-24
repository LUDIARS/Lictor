# Lictor — Design Notes

## Problem statement

Claude Code's TUI captures subprocess stdout. Any OSC escape sequence emitted
by a hook, the Bash tool, or an MCP server is absorbed by Claude Code's
renderer and never reaches the host terminal. The same is true of Win32
`SetConsoleTitle` calls from a child process: on Windows, Claude Code
allocates a private pty per Bash invocation, so `SetConsoleTitleW` writes
into that detached pty.

Concrete consequence: multiple concurrent Claude Code sessions in Windows
Terminal tabs are indistinguishable in the taskbar / Alt-Tab. Operators
mis-edit `main` in the wrong repo because the tab title is just "✻ Claude
Code" everywhere.

Anthropic tracks this as a feature request (#15802, #18326, #20441,
#25789, #14343 ...). No native solution shipped as of 2026-05.

A secondary problem (v0.1): every Claude session needs to register with
Concordia and run periodic /stat polling. Doing this via per-session
PostToolUse / Stop hooks is fragile — the registration races the Bash
tool's first command, and the polling is just a glorified setInterval the
hook can't actually run between Claude turns.

## Architecture (v0.3)

```
┌────────────────────┐
│  Windows Terminal  │
│   (pty endpoint)   │
└──────────┬─────────┘
           │ pty (real stdin/stdout/stderr)
           ▼
┌──────────────────────────────────────────────────────────┐
│  lictor wrapper (Node 22+, this repo)                    │
│  ├─ process.stdout → the real pty                        │
│  ├─ child = pty.spawn('claude', { node-pty })            │
│  ├─ stdin (raw) → pty.write   /   pty.onData → stdout    │
│  ├─ ctx.ptyWriter → /v1/rename keystroke injection       │
│  ├─ HTTP sidecar on 127.0.0.1:<ephemeral>                │
│  ├─ Concordia session registered + WS liveness           │
│  ├─ 10-min stat cron → POST /v1/stat/<id>                │
│  └─ auto-title cycle (persona + repo + branch + marks)   │
└──────────┬───────────────────────────────────────────────┘
           │ node-pty ConPTY/forkpty + env injection                 ┌──────────────────────────────────┐
           ▼                                                          │ Concordia (127.0.0.1:17330)      │
┌─────────────────────────────────────────┐                          │ ┌──────────────────────────────┐ │
│  claude (Claude Code TUI)               │                          │ │ /v1/sessions  (register)     │ │
│   $LICTOR_PORT, $LICTOR_SESSION_ID,     │                          │ │ /ws?session=  (liveness)     │ │
│   $LICTOR_PERSONA_NAME, etc. in env     │                          │ │ /v1/stat/:id   (10-min cron) │ │
└──────────┬──────────────────────────────┘                          │ │ /v1/chat       (proxied)     │ │
           │ Bash tool / hook / MCP spawns                            │ │ /v1/sessions/:id/event       │ │
           ▼                                                          │ │ /v1/monitor/conflicts        │ │
┌─────────────────────────────────────────┐                          │ └──────────────────────────────┘ │
│  hook subprocess                        │                          └────────────▲─────────────────────┘
│  curl http://127.0.0.1:$LICTOR_PORT/    │                                       │
│       v1/title  -d ...                  │                                       │
│       v1/chat   -d ...                  │ ─── proxied by lictor sidecar ────────┘
│       v1/event  -d ...                  │
│  GET  /v1/conflicts                     │
└─────────────────────────────────────────┘
                │
                ▼  (HTTP loopback, NOT through claude's stdout)
        lictor sidecar handles:
          /v1/title         → process.stdout.write(OSC) → real pty → terminal
          /v1/chat,/event,
          /v1/conflicts     → forwarded to Concordia, response relayed back
```

Key invariant: `lictor`'s own `process.stdout` is connected to the real
terminal pty. That is the **only** thing in the diagram with that property.
Hooks reach it out-of-band over loopback, not through claude.

## Why HTTP loopback (not named pipes, not signals, not stdin injection)

- **Portability** — HTTP-over-TCP loopback works identically on
  Windows / macOS / Linux without platform-specific socket paths.
- **Symmetry with Concordia** — Concordia is already HTTP, so the proxy
  path is trivial (`fetch` in, `fetch` out).
- **Hook ergonomics** — `curl` is everywhere; named pipes need different
  tools per OS.
- **Cost** — single Node `http.createServer`, no native dep.

Sidecar binds `127.0.0.1:0` (ephemeral). Concurrent lictor instances in
sibling Windows Terminal tabs never collide; each session gets its own port
and exports it as `$LICTOR_PORT`.

Loopback hardening: per-handler check rejects any request whose
`remoteAddress` isn't `127.0.0.1` / `::1` / `::ffff:127.0.0.1`. Belt-and-
braces alongside the explicit `listen(0, '127.0.0.1', ...)` bind.

## Why pty.spawn (revised in v0.3)

v0.0–v0.2 used `child_process.spawn('claude', { stdio: 'inherit' })` and
explicitly avoided `node-pty`: claude's stdin/stdout were the real terminal
pty fds, lictor's job was just emitting OSC sequences alongside, and a
native dep would have hurt the "drop-in wrapper" property.

v0.3 changes the trade. The sidecar now needs to inject keystrokes into
claude's TUI input — `/v1/rename` types `/rename <text>\r` on the user's
behalf so the session name on claude.ai/code can be set without the user
touching the keyboard. With `stdio: 'inherit'`, lictor has no handle to
write to claude's stdin (the fd is owned by the kernel/terminal). The
only way to push bytes in is to be the pty master.

So v0.3:
- `pty.spawn('claude', ...)` via `node-pty@^1.1` (prebuilds for
  Win/macOS/Linux ship in the npm tarball — no `node-gyp` build step).
- `pty.onData(data => process.stdout.write(data))` — claude output to real
  terminal.
- `process.stdin` set to raw mode, `data` events forwarded to `pty.write`.
  In raw mode the kernel does not synthesize SIGINT from Ctrl-C; the byte
  is forwarded verbatim and claude's TUI (or its inner line discipline)
  interprets it.
- `process.stdout.on('resize')` → `pty.resize(cols, rows)` so the TUI
  relayouts when the terminal is resized.
- On Windows, the executable is `cmd.exe /d /s /c claude ...` because
  ConPTY's CreateProcessW doesn't auto-resolve `.cmd` extensions and
  `claude` ships as `claude.cmd` in npm global bin.

The cost we accepted: one prebuilt native dep (`node-pty`), a small chance
of ConPTY edge cases on older Windows, and slightly more complex shutdown
(restoring stdin raw-mode in cleanup). The benefit: any sidecar endpoint
can now drive claude's TUI as if the user typed it.

## Concordia integration details

### Registration

`POST /v1/sessions` with a Lictor-generated `lictor-<uuid>` id. Payload
captures repo_path / branch / host / pid / wt_session. Response includes
`persona` (assigned by Concordia) and `session.metadata.role_label`.

### Liveness via WebSocket

Concordia's `/ws?session=<id>` increments `ws_clients` on connect; a
session with an active WS is exempt from the lost-detection scan. Lictor
holds the WS open for the lifetime of the wrapped claude, reconnecting
with exponential backoff (1s → 30s cap) if the connection drops.

Lictor does **not** post explicit heartbeats — the WS already serves that
role. This halves the chatter compared with the old hook-based heartbeat.

### Stat polling (10 minutes)

`gatherRepoStat(cwd)` runs:
- `git rev-parse --abbrev-ref HEAD` → branch
- `git rev-parse --abbrev-ref @{u}` → upstream (if any)
- `git status --porcelain=v1` → staged / unstaged / untracked counts
- `git rev-list --count <upstream>..HEAD` → unpushed
- `git log -1 --format=%H%x09%cI%x09%s` → last commit metadata

Wrapped in `try`/`catch` and a 5s timeout each — if the repo isn't a git
repo, all fields default to null/0/false.

First stat fires immediately on registration so dashboards aren't blank
for 10 minutes. Subsequent stats every 10 min (timer is `unref`'d so it
doesn't keep the process alive past claude's exit).

### Auto title

`buildAutoTitle({ persona, roleLabel, stat, cwd })` produces:

```
[<role>] <repo-leaf> · <branch> ●↑N
```

Pieces are omitted when missing. `roleLabel` is clipped at 24 chars
(prevents a chatty persona name from blowing the title). Manual overrides
via `POST /v1/title` win until cleared with `POST /v1/title/auto`.

### Default `author_label` for chat proxy

Follows the LUDIARS convention of `<role> / <name>` (e.g.
`深掘り型 / 淵渡 一`). Falls back to role-only / name-only / `lictor`
when half the data is missing — never refuses the call purely for label
reasons.

## Trust boundary

There are two functions that hand user-supplied text to the host terminal
/ wrapped TUI; both must sanitize first.

`sanitizeTitle` (src/osc.ts) gates `process.stdout.write` for OSC payloads.
It strips all C0 controls (`\x00-\x1f`) and DEL (`\x7f`) so a malformed
payload can't:
- terminate the OSC string early and inject a new escape,
- send a different OSC,
- inject a BEL outside the sequence.

Also caps length at 200 characters.

`sanitizeRenameArg` (src/sidecar.ts) gates `ctx.ptyWriter` for `/v1/rename`.
It strips C0/DEL (same reasons — could inject other key events), strips a
leading `/` (prevents the caller from sneaking another slash command in
front), trims whitespace, and caps at 200 chars. New endpoints that write
to the pty must use the same pattern; never call `ctx.ptyWriter(rawInput)`.

## Non-goals

- Not a process supervisor: lictor exits with claude, doesn't restart it.
- Not a logger: claude's output passes through unchanged.
- Not a full hook framework (yet): v0.1 proxies a fixed surface; users
  can't register dynamic handlers. v0.4 may add that.

## Skill injection (v0.2)

Lictor is the parent of claude — therefore it can write files into
locations claude scans at startup. We use that to inject **session-scoped**
skills without polluting the user's global `~/.claude/skills/`.

### Layout

```
~/.claude/lictor/sessions/<id>/
  .claude/
    skills/
      lictor-persona/SKILL.md          (from Concordia persona.skill_template)
      lictor-session-context/SKILL.md  (memory digest for cwd's repo)
      <user-injected via POST>/SKILL.md
```

Lictor passes `--add-dir <sessionDir>` to `claude`, so claude scans
`<sessionDir>/.claude/skills/` alongside its usual locations. On exit
Lictor removes the whole `<sessionDir>` — no manual cleanup, no leftover
skill clutter.

### Why `--add-dir` and not `~/.claude/skills/<id>/`

- `~/.claude/skills/` is shared across all sessions globally. A session-
  specific skill there leaks into every other concurrent Claude Code
  invocation until cleaned up. `--add-dir` scopes the skill to this one
  session.
- Cleanup is atomic — `rmSync` of one dir vs. cherry-picking from a
  shared dir.
- Crash safety — orphaned `<id>` dirs are obvious garbage; a leaked
  skill in `~/.claude/skills/` is invisible noise.

### What gets seeded at startup

1. **`lictor-persona`** — body is `persona.skill_template` straight from
   the Concordia register response. The template already includes the
   "this is just a personality color, never override user requests"
   guardrails Concordia writes for every persona.
2. **`lictor-session-context`** — built by scanning
   `~/.claude/projects/<cwd-encoded>/memory/*.md`. Scoring:
   - +3 if the cwd repo-leaf appears in the filename (e.g.
     `feedback_ks_release_build_required.md` matches when cwd is
     `KuzuSurvivors`)
   - +1 per body occurrence, capped at 3
   Top 3 are pasted, total capped at 8 KiB. `MEMORY.md` (the index) is
   skipped — claude loads it on its own.

### Mid-session updates and the watcher gotcha

Claude Code watches `~/.claude/skills/**/SKILL.md` (and `--add-dir`
equivalents) for file changes. Edits to an *existing* SKILL.md reload
live in subsequent turns. But a **brand-new directory** is only
discovered at scan time (session start).

Lictor's `POST /v1/skill {name, content}` creates the directory if
needed and writes the SKILL.md, so:
- Overwriting `lictor-persona` or `lictor-session-context` → reflected
  in the next turn.
- Creating a never-before-seen `my-new-skill` name → file is written,
  but claude won't notice until restart. The 200 response is honest
  about the write; runtime visibility is a separate question.

We could trigger a fake hot-reload by also `touch`-ing a known existing
SKILL.md after a new dir is created, but that's a hack we don't enable
by default.

### Trust boundary

- Skill name: regex-validated to kebab-case (`^[a-z][a-z0-9-]{0,63}$`),
  so a hook can't traverse out via `../etc/passwd` or write to a
  hostile path.
- Content: 32 KiB cap per skill so a runaway hook can't flood the
  context window.
- The skill dir is under `~/.claude/lictor/sessions/<sessionId>/` —
  always inside the user's own home, never world-writable.

## Roadmap

| Version | Adds |
|---------|------|
| v0.0    | Title set/reset, meta GET, health |
| v0.1    | Concordia integration: register / WS / persona / 10-min stat / chat-event-conflicts proxies / auto title |
| v0.2    | Skill injection: per-session `--add-dir`, persona + memory seeds, mid-session POST /v1/skill |
| **v0.3**| **pty wrapper (node-pty) + `/v1/rename` keystroke injection + `lictor cli rename` + `tests/local-server.mjs` dev harness** |
| v0.4    | Windows Terminal pane discovery via `WT_SESSION` + `wt.exe focus-tab`; cross-tab "focus this session" command |
| v0.5    | Generic hook host — users register handler scripts under `~/.claude/lictor/hooks/`, lictor dispatches based on Claude Code hook events relayed by the wrapped claude |
| v0.6    | Pre-spawn `.mcp.json` injection for session-scoped MCP servers |
