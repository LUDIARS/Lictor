# Lictor — CLAUDE notes

LUDIARS short code: **Li**. See `README.md` for usage, `DESIGN.md` for
architecture.

## When working on this repo

- Stack: Node ≥ 22 (we use the global `WebSocket`), TypeScript (strict),
  prebuilt-only native deps. `node-pty@^1.1` is the one current native
  dep — it ships ConPTY/macOS/Linux prebuilds in the tarball so `npm
  install` works without a compiler. If you add another native dep, it
  must ship prebuilds (gyp-from-source is banned — that's the original
  "drop-in wrapper" invariant).
- Test runner: built-in `node:test` via `tsx`. No vitest / jest.
- All HTTP endpoints must keep the `127.0.0.1` guard. This is a security
  invariant, not a code style preference.
- Title sanitization (`src/osc.ts`) is the trust boundary. New writers
  must funnel through `setTitle` / `writeOsc`, never `process.stdout.write`
  directly with raw payloads.
- Keystroke injection (`ctx.ptyWriter`) is the OTHER trust boundary. Any
  endpoint that writes to the pty MUST sanitize first (`sanitizeRenameArg`
  is the pattern: strip C0/DEL, strip leading `/` to prevent slash-command
  chaining, cap length, trim). Never call `ctx.ptyWriter(rawUserInput)`.
- Concordia integration is best-effort. Anything that calls Concordia
  must catch and degrade — Lictor users should never see a stack trace
  from a coordinator outage.

## When adding a sidecar endpoint

1. Document in `README.md` table.
2. Add to `DESIGN.md` if it changes the protocol surface (new verb / new
   Concordia call).
3. Loopback guard runs first in every handler (already true: all routes
   funnel through `handle` in `sidecar.ts`).
4. Body cap stays at 64 KiB unless there's a real reason to raise it.
5. If the endpoint proxies to Concordia, return 503 (not 500) when
   `ctx.concordia` is null. Tests must cover the null path — see
   `tests/smoke-sidecar.mjs`.

## Running smoke / round-trip checks

```sh
npm test                                  # unit tests (sanitizer + rename + auto-title + ...), no network
npx tsx tests/smoke-sidecar.mjs           # in-process sidecar, no Concordia
npx tsx tests/smoke-roundtrip.mjs         # registers a real Concordia session
npx tsx tests/local-server.mjs            # long-running sidecar w/ ptyWriter→stdout logger
```

`smoke-roundtrip.mjs` requires Concordia on `127.0.0.1:17330` and will
create + delete a real `lictor-smoke-<uuid>` session. It's a tracked file
but not part of `npm test`.

`local-server.mjs` stays running so you can curl the sidecar from another
terminal — useful for HTTP-layer iteration on `/v1/rename` without
spawning a real claude.

## Skill injection module (v0.2)

- `src/skill-injector.ts` owns the per-session dir lifecycle. Always go
  through `writeSkill` / `deleteSkill` — they enforce the name regex and
  the 32 KiB body cap. Never `writeFileSync` directly into `skillsDir`.
- `src/memory-loader.ts` is pure: given `(memoryDir, repoLeaf)` it
  returns matched files with scores. If you change the scoring, update
  `tests/memory-loader.test.ts` — the "scores by filename + body" case
  pins the current behavior.
- The `cwdToProjectKey` encoding mirrors how Claude Code names
  `~/.claude/projects/<key>/`. If Anthropic ever changes that encoding,
  patch only the one function.

## Cross-repo touchpoints

- `LUDIARS/LUDIARS` (`PROJECT-CODES.md`) — Li registered (PR #21 merged).
- `LUDIARS/Concordia` — Lictor depends on `/v1/sessions`, `/v1/stat/:id`,
  `/v1/chat`, `/v1/sessions/:id/event`, `/v1/sessions/:id/discord-channels`,
  `/v1/reports/:id/append`, `/v1/monitor/conflicts`, and `/ws?session=`.
  Breaking changes there should bump Lictor's compat surface.
- Discord relay is Lictor-mediated (anti-crosstalk): Lictor holds its
  session/meta Discord channel ids (fetched via `discord-channels`) and
  stamps `session_id` + `discord_channel_id` on every chat relay so the AI
  never names a session. See `Concordia/spec/discord-lictor-relay.md`.
- Skill `window-title-ja` — should be updated to call `lictor cli title`
  when `$LICTOR_PORT` is set, falling back to "manual rename" when not.
  v0.3 onward, the skill should also call `lictor cli rename "<text>"`
  to keep the claude.ai/code session name in sync with the OSC title.

## デプロイの注意 (dist 実行)

- `bin/lictor.mjs` は **`dist/cli.js` (コンパイル済み) を実行する**。 src を直しても
  `npm run build` するまで新規セッションに反映されない (2026-07-02 の crosstalk 再発は
  「#72/#73 をマージしたが dist が古いまま」 が原因だった)。
- **main へマージしたら必ず `npm run build` を実行する** (E:/Document/Ars/Lictor)。
- 既に起動中の wrapper はコードをメモリに載せているため、 修正反映には該当セッションの
  Lictor 再起動 (/co-relictor or 再 spawn) が必要。
