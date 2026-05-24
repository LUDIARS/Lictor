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
Code" everywhere. (LUDIARS memory: [[feedback_concurrent_session_branch]],
[[feedback_window_title_work_ja]].)

Anthropic tracks this as a feature request (#15802, #18326, #20441,
#25789, #14343 ...). No native solution shipped as of 2026-05.

## Architecture

```
┌────────────────────┐
│  Windows Terminal  │
│   (pty endpoint)   │
└──────────┬─────────┘
           │ pty (real stdin/stdout/stderr)
           ▼
┌────────────────────────────────────────────┐
│  lictor wrapper (Node process, this repo)  │
│  ├─ process.stdout → the real pty          │
│  ├─ child = spawn('claude', { inherit })   │
│  └─ HTTP sidecar on 127.0.0.1:<ephemeral>  │
└──────────┬─────────────────────────────────┘
           │ stdio: inherit + env injection
           ▼
┌─────────────────────────────────────────┐
│  claude (Claude Code TUI)               │
│   $LICTOR_PORT, $LICTOR_PID in env      │
└──────────┬──────────────────────────────┘
           │ Bash tool / hook / MCP spawns
           ▼
┌─────────────────────────────────────────┐
│  hook subprocess                        │
│   curl http://127.0.0.1:$LICTOR_PORT/   │
│        v1/title  -d '{"text":"..."}'    │
└─────────────────────────────────────────┘
                │
                ▼  (HTTP loopback, NOT through claude's stdout)
        lictor receives POST → process.stdout.write(OSC) →
        real pty → Windows Terminal → title changes.
```

Key invariant: `lictor`'s own `process.stdout` is connected to the real
terminal pty. That is the **only** thing in the diagram with that property.
Hooks reach it out-of-band over loopback, not through claude.

## Why HTTP loopback (not named pipes, not signals, not stdin injection)

- **Named pipes / Unix sockets**: portable HTTP-over-TCP loopback works
  identically on Windows / macOS / Linux without platform-specific socket
  paths. Cost is minimal (single Node `http.createServer`).
- **Signals**: too coarse — can't carry the new title text.
- **Writing to claude's stdin**: would inject characters into Claude's TUI
  input, not a sidecar protocol.

The sidecar binds `127.0.0.1:0` (ephemeral) so concurrent lictor instances
in sibling Windows Terminal tabs never collide. Each session gets its own
port and exports it as `$LICTOR_PORT`.

Loopback hardening: an in-handler check rejects any request whose
`remoteAddress` isn't `127.0.0.1` / `::1` / `::ffff:127.0.0.1`. With the
explicit `listen(0, '127.0.0.1', ...)` bind this is belt-and-braces, but it
matters if the bind ever changes.

## Why stdio: inherit (not node-pty)

`stdio: 'inherit'` makes claude's stdin/stdout/stderr the same file
descriptors as lictor's, which are the same as Windows Terminal's pty. No
native dependency on `node-pty`, no ConPTY juggling, no buffering layer.

The cost: lictor cannot intercept or transform claude's output stream. We
don't need to — we only need to inject our own OSC writes alongside, and
OSC sequences are out-of-band as far as the terminal renderer is concerned
(they don't display as visible text and don't disrupt cursor position).

If a future feature needs to intercept output (e.g. detect when claude
prints a `/clear` or session-end marker), we can revisit and either layer
a pty over stdin/stdout (still without node-pty, via `tty.ReadStream`) or
add `node-pty` then.

## Title sanitization

`sanitizeTitle` strips all C0 controls (`\x00-\x1f`) and DEL (`\x7f`) so a
malicious or malformed payload can't:
- terminate the OSC string early and inject a new escape,
- send a different OSC,
- inject a BEL outside the sequence.

It also caps length at 200 characters. Window managers truncate titles
visually anyway, and a huge title is more likely to be a bug than a feature.

## Non-goals (v0)

- Not a process supervisor: lictor exits with claude, doesn't restart it.
- Not a logger: claude's output passes through unchanged.
- Not a hook framework: v0 has one POST endpoint. The skeleton supports
  adding more, but v0 ships only title + meta + health.
- Not multi-session: one lictor wraps one claude. Sibling lictor instances
  are independent.

## Roadmap

| Version | Adds |
|---------|------|
| v0.0    | Title set/reset, meta GET, health, loopback hardening, tests for sanitizer |
| v0.1    | Title history under `~/.claude/lictor/sessions/<pid>.jsonl`; `lictor cli title --auto` driven by hook events |
| v0.2    | `POST /v1/event` for Concordia integration — lictor forwards relevant events (cwd switch, prolonged silence) up to a coordinator; `POST /v1/clear-title` |
| v0.3    | Windows Terminal pane discovery via `WT_SESSION` + `wt.exe focus-tab`; cross-tab "focus this session" command |
| v0.4    | Generic hook host: lictor sidecar runs lightweight PostToolUse / Stop hooks centrally so Memoria / Concordia / etc. can register handlers instead of each shipping their own settings.json hook entry |

## Cross-cutting LUDIARS notes

- Port registry: register in `infra/PORT-MAP.md` as "Lictor (per-session,
  ephemeral)". No fixed port — discovery is via `$LICTOR_PORT`.
- Memory: this design supersedes [[feedback_window_title_work_ja]] for
  in-session title changes; that memory should be updated to point at
  Lictor.
- Skill: `window-title-ja` should be updated to use `lictor cli title ...`
  when lictor is detected, falling back to "manual rename" when not.
