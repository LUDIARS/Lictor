import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import * as pty from "node-pty";
import { buildAnswerSequence, sanitizeKeySeq, startSidecar, type SidecarContext, type TitleState } from "./sidecar.js";
import { gatherBaseMeta, type Meta } from "./meta.js";
import { resetTitle } from "./osc.js";
import { ConcordiaClient, loadConcordiaConfig, type LivenessHandle } from "./concordia.js";
import { gatherRepoStat } from "./stat.js";
import { renderSkillMd, SkillInjector } from "./skill-injector.js";
import { findRepoMemories, memoryDirForCwd, renderMemoryDigest, repoLeafFromCwd } from "./memory-loader.js";
import {
  applyTitleWithMarks,
  isNotifyStale,
  newNotifyState,
  reactToEvent,
} from "./event-reactor.js";
import { refreshConflictState } from "./conflict-watcher.js";
import { refreshPendingTasksSkill } from "./pending-tasks.js";
import { newTaskState, relayTask, seedTaskProtocolSkill } from "./task-relay.js";
import { writeSessionStateSkill } from "./session-state-skill.js";
import {
  SESSION_END_SKILL_BODY,
  SESSION_END_SKILL_DESCRIPTION,
  SESSION_END_SKILL_NAME,
} from "./session-end-skill.js";
import { type ProviderConfig, PROVIDERS } from "./provider.js";
import { startTranscriptTail, type TranscriptTailHandle } from "./transcript-tail.js";
import { PendingQuestionGate } from "./pending-question-gate.js";
import {
  createDelegationInjector,
  delegationInjectDelayMs,
  loadDelegationPrompt,
  type DelegationInjector,
} from "./delegation-inject.js";
import {
  activeReposPath,
  pickActiveRepo,
  readActiveRepos,
  resolveActiveReposDir,
} from "./active-repos.js";
import {
  ASK_MARKER_SKILL_BODY,
  ASK_MARKER_SKILL_DESCRIPTION,
  ASK_MARKER_SKILL_NAME,
  writeAskMarkerPrompt,
} from "./ask-marker.js";
import { postResolveQuestion } from "./ask-question-relay.js";

const STAT_INTERVAL_MS = 10 * 60 * 1000;
const POLL_INTERVAL_MS = 60 * 1000;

/**
 * ユーザ自身が「既存 session を開く / 再開する」 flag を渡しているか。
 * これらが在るときは Lictor が `--session-id` を固定すると意図 (resume 等) と
 * 衝突するため、 session-id 固定束縛を見送って従来の mtime discover に委譲する。
 */
function hasSessionSelectingArg(args: readonly string[]): boolean {
  return args.some(
    (a) =>
      a === "--session-id" ||
      a === "--resume" ||
      a === "-r" ||
      a === "--continue" ||
      a === "-c" ||
      a === "--from-pr",
  );
}

export async function runWrapped(args: string[], provider: ProviderConfig = PROVIDERS.claude): Promise<void> {
  const meta = gatherBaseMeta();
  meta.provider = provider.name;

  // Concordia registration — best-effort. A failure here downgrades to v0.0
  // behavior (no persona, no auto-stat, no liveness) but does NOT block the
  // wrapped session from starting.
  const concordia = await tryRegisterConcordia(meta, provider);

  if (concordia) {
    meta.session_id = concordia.id;
    meta.persona = concordia.persona;
    meta.role_label = concordia.roleLabel;
  }

  const titleState: TitleState = { manualOverride: null };

  // Skill injection — pre-spawn writes go to <root>/.claude/skills/, and we
  // pass <root> to claude via --add-dir so it's scanned at boot. Mid-session
  // overwrites of existing SKILL.md files reload live via claude's watcher.
  // Skill injection: layout/scope depends on provider.skillStrategy.
  //   - claude-add-dir: session-scoped dir, passed via --add-dir
  //   - codex-user-agents: ~/.agents/skills/lictor-<sessionId>-<name>/, no spawn arg
  //   - none: no injector
  const sessionIdForSkills = (concordia?.id ?? `lictor-${randomUUID()}`).replace(/[^a-zA-Z0-9-]/g, "-");
  const injector = provider.supportsSkills
    ? new SkillInjector(sessionIdForSkills, provider.skillStrategy)
    : null;
  if (injector) {
    seedSkills(injector, meta);
    seedTaskProtocolSkill(injector);
  }

  // ptyWriter is wired into ctx so sidecar endpoints (e.g. /v1/rename) can
  // inject keystrokes into claude's TUI input stream. Assigned after the pty
  // is spawned below.
  const ctx: SidecarContext = {
    meta,
    titleState,
    concordia: concordia?.client ?? null,
    sessionId: concordia?.id ?? null,
    roleLabel: meta.role_label,
    injector,
    ptyWriter: null,
    notifyState: newNotifyState(),
    conflictState: { count: 0, titleMark: null },
    taskState: newTaskState(),
    pendingPermissions: new Map(),
    activeRepoState: { lastActive: null, lastList: [] },
    getClaudeSessionId: null,
    getTranscript: null,
    forceExit: null,
  };

  const sidecar = await startSidecar(ctx);

  // Publish our sidecar port to Concordia so per-session HTTP proxies
  // (filesystem RPC, permission checks, etc.) can reach this Lictor. The
  // initial register fired BEFORE startSidecar (we needed the persona for
  // skill seeding), so the port wasn't known then. Best-effort — failure
  // only breaks the proxy features, not the wrapped claude.
  if (concordia) {
    concordia.client
      .patchSession(concordia.id, { metadata: { lictor_port: sidecar.port } })
      .catch((err) => {
        process.stderr.write(
          `lictor: failed to publish lictor_port to Concordia (${(err as Error).message})\n`,
        );
      });
  }

  // 自分の Discord channel ID 群を取得して保持する (spec/discord-lictor-relay.md)。
  // channel 作成は Concordia 側で session.started event 経由の非同期なので、
  // session_channel_id が埋まるまで数回リトライする。best-effort — 失敗しても
  // chat relay は Concordia 側の従来 routing に degrade する。
  if (concordia) {
    void pollDiscordChannels(ctx, concordia.client, concordia.id);
  }

  // Initial auto title (composed with conflict/notify marks once they exist).
  applyAutoTitle(ctx, gatherRepoStat(meta.cwd));

  // Holds ordinary pty injects while an AskUserQuestion picker is open, so a
  // stray Discord message / `/enter` / Codex submit-fallback can't commit the
  // picker's default option before the user actually answers. Opened/closed by
  // transcript-tail (question tool_use → tool_result); answers bypass it via
  // onAnswerQuestion. See pending-question-gate.ts.
  const pendingQuestionGate = new PendingQuestionGate(
    (text) => {
      if (ctx.ptyWriter) provider.submitInject(ctx.ptyWriter, text);
    },
    (msg) => process.stderr.write(`lictor: ${msg}\n`),
  );

  // ask マーカー由来の pending-question id を覚えておく。これらは picker ではなく
  // テキスト出力なので、回答は「キー注入」ではなく「テキスト注入」で返す
  // (単一/複数/自由文を全部テキスト返信に一本化)。組み込み AskUserQuestion 由来の
  // 質問 (= ここに無い id) は従来どおりキー注入の fallback に回す。
  const markerQuestionIds = new Set<number>();
  // まだローカル/リモートで解決していない marker 質問。ユーザが端末で返信したら
  // (transcript に user メッセージが出たら) resolve 通知して Discord ボタンを失効させる。
  const openMarkerQids = new Set<number>();

  // WS reactor — attach AFTER ctx so the dispatcher can read live state.
  if (concordia) {
    concordia.liveness.close(); // close the pre-ctx liveness opened by tryRegisterConcordia
    concordia.liveness = concordia.client.openLiveness(concordia.id, (msg) =>
      reactToEvent(msg, {
        meta: ctx.meta,
        titleState: ctx.titleState,
        notifyState: ctx.notifyState,
        conflictMark: () => ctx.conflictState.titleMark,
        refreshAutoTitle: () => applyAutoTitle(ctx, gatherRepoStat(ctx.meta.cwd)),
        ownSessionId: ctx.sessionId,
        onPendingTaskHint: () => {
          if (ctx.concordia && ctx.sessionId && ctx.injector) {
            void refreshPendingTasksSkill(ctx.concordia, ctx.sessionId, ctx.injector);
          }
        },
        onInject: (text, source) => {
          if (!ctx.ptyWriter) return;
          // Reuse the same sanitizer as /v1/keys — TUI-safe controls only.
          // 「テキスト本文 + submit キー」 の組み立て方は provider に委譲する.
          //   claude / gemini : text + \r を 1 chunk write (現行動作)
          //   codex           : text → 30ms 遅延 → \r の 2 段書き. crossterm
          //                     event loop が 「入力」 と 「Enter キーイベント」
          //                     を別個と認識するよう間を空ける.
          const safe = sanitizeKeySeq(text);
          if (!safe) return;
          // While an AskUserQuestion picker is open, hold this inject instead
          // of letting "text + Enter" commit the picker's default option. It is
          // flushed once the picker resolves (transcript-tail observes the
          // tool_result). Answers arrive via onAnswerQuestion, which bypasses
          // the gate, so the picker can still be answered remotely.
          if (pendingQuestionGate.shouldDefer(safe)) {
            process.stderr.write(
              `lictor: held inject from Concordia while question pending (source=${source ?? "?"})\n`,
            );
            return;
          }
          const writer = ctx.ptyWriter;
          provider.submitInject(writer, safe);
          // Telemetry breadcrumb — surface that the inject landed so the
          // user can see who pushed what without trawling Concordia logs.
          process.stderr.write(
            `lictor: injected ${safe.length} bytes from Concordia (source=${source ?? "?"}, provider=${provider.name})\n`,
          );
        },
        onAnswerQuestion: ({ questionId, index, text }) => {
          if (!ctx.ptyWriter) return;
          // ask マーカー由来の質問は picker ではなくテキスト出力なので、回答は
          // 「テキスト + Enter」 を通常の inject 経路で返す (キー注入しない)。
          // answer_text は単一=ラベル / 複数=カンマ結合ラベル / Other=自由文。
          if (markerQuestionIds.has(questionId)) {
            markerQuestionIds.delete(questionId);
            openMarkerQids.delete(questionId);
            const safe = sanitizeKeySeq(text);
            if (!safe) return;
            provider.submitInject(ctx.ptyWriter, safe);
            process.stderr.write(
              `lictor: answered ask-marker question via text (qid=${questionId}, provider=${provider.name})\n`,
            );
            return;
          }
          // fallback: 組み込み AskUserQuestion picker。Concordia carries 0-based
          // answer_index; buildAnswerSequence is 1-based ([1, 50]). Clamp the
          // upper bound so a malformed event can't push the picker past option 50.
          const choice = index + 1;
          if (choice < 1 || choice > 50) return;
          let seq: string;
          try {
            seq = buildAnswerSequence(choice);
          } catch {
            return;
          }
          ctx.ptyWriter(seq);
          process.stderr.write(
            `lictor: confirmed AskUserQuestion picker via Concordia (answer_index=${index}, provider=${provider.name})\n`,
          );
        },
      }),
    );
  }

  // Periodic stat polling — only when Concordia is reachable.
  const statTimer = concordia
    ? setInterval(() => pushStat(ctx).catch(() => {}), STAT_INTERVAL_MS)
    : null;
  statTimer?.unref?.();
  // Send first stat immediately so dashboards aren't blank for 10 minutes.
  if (concordia) pushStat(ctx).catch(() => {});

  // v0.4 — 60s cron for branch relay + pending-tasks + conflict watch.
  const pollTimer = concordia
    ? setInterval(() => pollLiveState(ctx).catch(() => {}), POLL_INTERVAL_MS)
    : null;
  pollTimer?.unref?.();
  if (concordia) pollLiveState(ctx).catch(() => {});

  process.stderr.write(
    `lictor: wrapping ${provider.displayName} (${provider.binary})${
      concordia ? `, Concordia session ${concordia.id}` : ""
    }\n`,
  );

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    LICTOR_PORT: String(sidecar.port),
    LICTOR_PID: String(process.pid),
    LICTOR_SESSION_START: meta.start_iso,
    LICTOR_PROVIDER: provider.name,
  };
  if (concordia) {
    env.LICTOR_SESSION_ID = concordia.id;
    env.CONCORDIA_SESSION_ID = concordia.id;
    if (meta.persona?.name) env.LICTOR_PERSONA_NAME = String(meta.persona.name);
    if (meta.role_label) env.LICTOR_ROLE_LABEL = meta.role_label;
  }

  // Spawn-arg injection. Two pieces compose here:
  //   1. --add-dir <sessionDir> for the claude-add-dir strategy (Codex
  //      auto-walks ~/.agents/skills/ so the flag is omitted there).
  //   2. --settings <path> wiring claude's PreToolUse to our permission-hook
  //      bridge. Only applies when Concordia is up AND we have an injector
  //      (i.e. a real session dir to write the settings file into). For
  //      Codex we skip — claude's --settings flag is not portable.
  // provider.spawnArgs は user args の前に必ず差す (local: ["cli","local-agent"] で
  // lictor 自身を REPL として再起動)。claude/codex/gemini は spawnArgs 無し。
  const baseArgs = provider.spawnArgs ? [...provider.spawnArgs, ...args] : [...args];
  const providerArgs =
    provider.skillStrategy === "claude-add-dir" && injector
      ? ["--add-dir", injector.sessionDir, ...baseArgs]
      : baseArgs;

  let extraSettingsPath: string | null = null;
  if (concordia && injector && provider.name === "claude") {
    try {
      extraSettingsPath = writePermissionHookSettings(injector.sessionDir);
    } catch (err) {
      process.stderr.write(
        `lictor: permission-hook settings write failed: ${(err as Error).message}\n`,
      );
    }
  }
  if (extraSettingsPath) providerArgs.push("--settings", extraSettingsPath);

  // セッション ID 固定束縛 (Discord セッション ↔ jsonl ↔ channel の取り違え防止)。
  //
  // wrapped CLI が session-id 固定に対応する (claude) なら、 ここで uuid を発番
  // して `--session-id <uuid>` を spawn 引数に足し、 transcript-tail には
  // 「その uuid の jsonl だけを claim せよ」 と固定 path を渡す。 これで
  // transcript-tail の mtime 推測 discover を完全に廃し、
  //   - 先に非 Lictor の claude を起動していた
  //   - 同 cwd で別 wrapper が並走している
  //   - context 要約で session が新 jsonl にローテートした
  // のいずれでも、 自分以外の transcript を誤って掴む (= 投稿が 1 つズレて
  // 別チャンネルに出る) crosstalk が構造的に起きなくなる。
  //
  // concordia 連携時 (= リモート中継対象) のほか、 LICTOR_PIN_TRANSCRIPT=1 が
  // 明示指定されたときも固定する。 後者は Concordia を無効化して起動する常駐ワーカー
  // (Discutere worker-pool 等) が transcript path を知りたいケース向け。 固定した
  // path は LICTOR_TRANSCRIPT_FILE として wrapped CLI の env に公開し、 ワーカーが
  // セッションの usage / token を transcript から回収できるようにする (Discutere #135)。
  // ユーザが自分で --session-id / --resume / --continue / --from-pr を渡している場合は、
  // 既存 session を開く意図なので固定せず従来 discover に委譲する。
  const pinRequested = process.env.LICTOR_PIN_TRANSCRIPT === "1";
  let pinnedTranscriptPath: string | null = null;
  if (
    (concordia || pinRequested) &&
    provider.supportsSessionPin &&
    provider.sessionPinArgs &&
    provider.pinnedTranscriptFile &&
    !hasSessionSelectingArg(args)
  ) {
    const pinnedUuid = randomUUID();
    providerArgs.push(...provider.sessionPinArgs(pinnedUuid));
    pinnedTranscriptPath = provider.pinnedTranscriptFile(meta.cwd, pinnedUuid);
    if (pinnedTranscriptPath) env.LICTOR_TRANSCRIPT_FILE = pinnedTranscriptPath;
    process.stderr.write(
      `lictor: pinned ${provider.displayName} session-id ${pinnedUuid} (transcript claim 固定)\n`,
    );
  }

  // ask マーカー ステアリング注入 (concordia 連携時のみ = リモート回答対象)。
  //   - claude: 共通マーカールール + 組み込み AskUserQuestion 禁止 を常時
  //     --append-system-prompt-file で注入 (ファイル経由で Windows の cmd.exe
  //     クォート問題を回避)。
  //   - codex : 共通マーカールールを skill 注入 (Codex は ~/.agents/skills を自動探索)。
  // gemini は注入機構が無いので skip。検出側 (transcript-tail) は askMarkerActive と連動。
  let askMarkerActive = false;
  if (concordia && injector) {
    if (provider.name === "claude") {
      try {
        const promptPath = writeAskMarkerPrompt(injector.sessionDir);
        providerArgs.push("--append-system-prompt-file", promptPath);
        askMarkerActive = true;
      } catch (err) {
        process.stderr.write(
          `lictor: ask-marker system-prompt write failed: ${(err as Error).message}\n`,
        );
      }
    } else if (provider.name === "codex") {
      try {
        injector.writeSkill(
          ASK_MARKER_SKILL_NAME,
          renderSkillMd({
            name: ASK_MARKER_SKILL_NAME,
            description: ASK_MARKER_SKILL_DESCRIPTION,
            body: ASK_MARKER_SKILL_BODY,
          }),
        );
        askMarkerActive = true;
      } catch (err) {
        process.stderr.write(
          `lictor: ask-marker skill seed failed: ${(err as Error).message}\n`,
        );
      }
    }
  }

  // node-pty on Windows uses CreateProcessW which does not auto-resolve .cmd
  // extensions. CLI bins ship as `<name>.cmd` in npm global bin, so wrap via
  // cmd.exe; on POSIX, spawn the binary directly.
  const isWindows = process.platform === "win32";
  const ptyFile = isWindows ? process.env.ComSpec ?? "cmd.exe" : provider.binary;
  const ptyArgs = isWindows ? ["/d", "/s", "/c", provider.binary, ...providerArgs] : providerArgs;

  const { cols, rows } = currentSize();
  const child = pty.spawn(ptyFile, ptyArgs, {
    name: process.env.TERM ?? "xterm-256color",
    cols,
    rows,
    cwd: process.cwd(),
    env: env as { [key: string]: string },
    // useConpty is on by default on Windows 10 1809+; node-pty falls back to
    // winpty otherwise. We do not override.
  });

  ctx.ptyWriter = (data: string) => child.write(data);
  ctx.forceExit = () => { child.kill("SIGTERM"); };

  // Delegation prompt auto-inject — when Concordia spawned us via
  // /v1/delegation/invoke, env CONCORDIA_DELEGATION_PROMPT_FILE points at the
  // rendered prompt. We paste+submit it once, after the TUI has had time to
  // draw (armed on first pty output). Best-effort; no env → no-op.
  let delegationInjector: DelegationInjector | null = null;
  const delegationPrompt = loadDelegationPrompt(env);
  if (delegationPrompt) {
    delegationInjector = createDelegationInjector({
      prompt: delegationPrompt,
      submit: (text) => provider.submitInject((d) => child.write(d), text),
      delayMs: delegationInjectDelayMs(env),
    });
  }

  // Transcript tail — start watching ~/.claude/projects/<cwdKey>/ for the
  // new .jsonl claude will create, then relay each parsed line to
  // Concordia as a transcript-frame. Best-effort; failures don't affect
  // the wrapped session at all. Only meaningful when concordia is up.
  let transcriptTail: TranscriptTailHandle | null = null;
  if (concordia) {
    const concordiaBaseUrl = `http://${process.env.CONCORDIA_HOST ?? "127.0.0.1"}:${process.env.CONCORDIA_PORT ?? "17330"}`;
    transcriptTail = startTranscriptTail({
      cwd: meta.cwd,
      sessionId: concordia.id,
      concordiaBaseUrl,
      provider,
      onQuestionOpen: (qid) => pendingQuestionGate.openQuestion(qid),
      onQuestionResolved: (qid) => pendingQuestionGate.resolveQuestion(qid),
      askMarkerEnabled: askMarkerActive,
      pinnedTranscriptPath,
      onAskMarkerPosted: (qid) => {
        // この id の回答は picker キー注入ではなくテキスト注入で返す。
        markerQuestionIds.add(qid);
        openMarkerQids.add(qid);
      },
      onUserReply: () => {
        // 端末でローカル返信された → 開いている marker 質問を解決し Discord ボタンを失効。
        for (const qid of openMarkerQids) {
          void postResolveQuestion(concordiaBaseUrl, concordia.id, qid);
        }
        openMarkerQids.clear();
      },
    });
    // active-repos watcher が transcript-tail 経由で session UUID を引けるよう
    // ctx に getter を差す. transcript-tail が JSONL を発見するまで null を返す.
    // claude / codex 両 provider の filename 規約は provider.extractSessionId
    // が抽象化する.
    const tail = transcriptTail;
    ctx.getClaudeSessionId = () => tail.getSessionUuid();
    // `GET /v1/transcript` の読み出し口. transcript-tail handle に委譲.
    ctx.getTranscript = (limit, raw) => tail.readRecent(limit, { raw });
  }

  // pty → real terminal stdout.
  const onData = (data: string) => {
    // First output from the wrapped CLI means its TUI is alive; arm the
    // one-shot delegation inject (fires after delayMs). Harmless when null.
    delegationInjector?.notifyData();
    try {
      process.stdout.write(data);
    } catch {
      // stdout may be torn down during shutdown; ignore.
    }
  };
  child.onData(onData);

  // real terminal stdin → pty. In raw mode the kernel delivers Ctrl-C as a
  // byte (0x03) which we forward verbatim — the pty's line discipline (or
  // claude's own TUI) interprets it. We do NOT install a SIGINT handler in
  // raw mode because the kernel won't generate one.
  const stdin = process.stdin;
  const stdinWasRaw = stdin.isTTY ? stdin.isRaw : false;
  if (stdin.isTTY) {
    try {
      stdin.setRawMode(true);
    } catch {
      // some shells (e.g. piped stdin) don't support raw mode; ignore.
    }
  }
  const onStdin = (chunk: Buffer) => {
    try {
      child.write(chunk.toString("utf8"));
    } catch {
      // child may have exited; ignore.
    }
  };
  stdin.on("data", onStdin);
  stdin.resume();

  // Forward terminal resize events to the pty so claude's TUI relayouts.
  const onResize = () => {
    const { cols: c, rows: r } = currentSize();
    try {
      child.resize(c, r);
    } catch {
      // pty may have exited; ignore.
    }
  };
  process.stdout.on("resize", onResize);

  let childExited = false;
  const cleanup = async () => {
    if (statTimer) clearInterval(statTimer);
    if (pollTimer) clearInterval(pollTimer);
    transcriptTail?.stop();
    // Drop any held injects rather than flushing them into a dying pty.
    pendingQuestionGate.forceClear();
    concordia?.liveness.close();
    sidecar.close();
    resetTitle();
    injector?.cleanup();
    stdin.off("data", onStdin);
    process.stdout.off("resize", onResize);
    if (stdin.isTTY) {
      try {
        stdin.setRawMode(stdinWasRaw);
      } catch {
        // ignore
      }
    }
    stdin.pause();
    if (concordia) {
      try {
        const reply = await concordia.client.unregister(concordia.id);
        if (reply && reply.report) {
          // Print Concordia's session-end report so the user sees a summary
          // of what their session did. JSON if structured, otherwise raw.
          const text =
            typeof reply.report === "string"
              ? reply.report
              : JSON.stringify(reply.report, null, 2);
          process.stderr.write(`\nlictor: Concordia session report —\n${text}\n`);
        }
      } catch {
        // best-effort
      }
    }
  };

  child.onExit(({ exitCode, signal }) => {
    childExited = true;
    void cleanup().finally(() => {
      if (signal && process.platform !== "win32") {
        // POSIX: re-raise so wait status mirrors the child's.
        process.kill(process.pid, signalNumberToName(signal));
        return;
      }
      process.exit(exitCode ?? 0);
    });
  });

  // OS-level signals to lictor itself (e.g. external kill). Forward to pty,
  // then let onExit drive cleanup.
  const forward = (sig: NodeJS.Signals) => () => {
    if (childExited) return;
    try {
      child.kill(sig);
    } catch {
      // node-pty on Windows ignores signal name; falls back to terminate.
    }
  };
  process.on("SIGINT", forward("SIGINT"));
  process.on("SIGTERM", forward("SIGTERM"));
  if (process.platform !== "win32") {
    process.on("SIGHUP", forward("SIGHUP"));
  }
}

/**
 * Write a per-session settings.json that maps PreToolUse to our
 * permission-hook bridge. Passed to claude via `--settings <path>` so it
 * stacks on top of user/project settings rather than replacing them. The
 * file lives in the same sessionDir as the injected skills, so cleanup
 * (injector.cleanup() removing sessionDir) takes care of it on exit.
 *
 * The command points at the `lictor` binary on PATH plus our cli
 * subcommand. Matcher is a regex covering the tools we care to gate
 * (Bash/Edit/Write — write paths) plus MCP tools whose name starts with
 * `mcp__`. Read-only tools (Read/Glob/Grep) are intentionally NOT gated
 * — they would explode the modal count and add no value.
 */
function writePermissionHookSettings(sessionDir: string): string {
  const path = `${sessionDir}/lictor-hook-settings.json`;
  const content = JSON.stringify({
    hooks: {
      PreToolUse: [
        {
          matcher: "Bash|Edit|Write|MultiEdit|NotebookEdit|mcp__.*",
          hooks: [
            {
              type: "command",
              command: "lictor cli permission-hook",
              timeout: 65,
            },
          ],
        },
        {
          // AskUserQuestion を picker-open 時に検知して Concordia へ早期投稿する
          // (回答前に Discord へ出すため)。 これは権限ゲートではなく、 decision を
          // 返さず picker をそのまま開かせる。 src/ask-question-hook.ts 参照。
          matcher: "AskUserQuestion",
          hooks: [
            {
              type: "command",
              command: "lictor cli ask-question-hook",
              timeout: 10,
            },
          ],
        },
      ],
    },
  }, null, 2);
  writeFileSync(path, content, "utf8");
  return path;
}

function currentSize(): { cols: number; rows: number } {
  const cols = process.stdout.columns ?? 80;
  const rows = process.stdout.rows ?? 24;
  return { cols, rows };
}

function signalNumberToName(signal: number): NodeJS.Signals {
  // node-pty reports signal as a number on POSIX. Map the common ones; fall
  // back to SIGTERM which is universally accepted by process.kill.
  switch (signal) {
    case 1:
      return "SIGHUP";
    case 2:
      return "SIGINT";
    case 9:
      return "SIGKILL";
    case 15:
      return "SIGTERM";
    default:
      return "SIGTERM";
  }
}

interface ConcordiaSlot {
  client: ConcordiaClient;
  id: string;
  persona: Meta["persona"];
  roleLabel: string | null;
  /** Mutable — wrap.ts swaps this out after ctx is built to attach the reactor. */
  liveness: LivenessHandle;
}

async function tryRegisterConcordia(meta: Meta, provider: ProviderConfig): Promise<ConcordiaSlot | null> {
  const cfg = loadConcordiaConfig();
  if (!cfg.enabled) return null;
  const client = new ConcordiaClient(cfg);
  const id = `lictor-${randomUUID()}`;
  try {
    const stat0 = gatherRepoStat(meta.cwd);
    const registered = await client.register({
      id,
      provider: provider.concordiaProvider,
      repo_path: meta.cwd,
      host: meta.hostname,
      branch: stat0.branch ?? undefined,
      metadata: {
        lictor_pid: meta.lictor_pid,
        parent_pid: meta.parent_pid,
        wt_session: meta.wt_session,
        start_iso: meta.start_iso,
        platform: meta.platform,
        wrapped_by: "lictor",
      },
    });
    const liveness = client.openLiveness(id);
    return {
      client,
      id: registered.id,
      persona: registered.persona,
      roleLabel: registered.roleLabel,
      liveness,
    };
  } catch (err) {
    process.stderr.write(
      `lictor: Concordia registration failed (${(err as Error).message}); ` +
        `continuing without coordinator integration.\n`,
    );
    return null;
  }
}

/**
 * 自分の Discord channel ID 群を Concordia から取得して ctx.meta.discord に
 * 保持する (spec/discord-lictor-relay.md §3)。session channel の作成は
 * session.started event 経由で非同期なので、session_channel_id が埋まるまで
 * 指数バックオフでリトライする (上限 ~30s)。meta channel ID だけ先に取れた
 * 場合もその時点で保持し、chitchat/consultation 等の relay は即 deterministic
 * になる。best-effort — 失敗は無視 (Concordia 側の従来 routing に degrade)。
 */
async function pollDiscordChannels(
  ctx: SidecarContext,
  client: ConcordiaClient,
  sessionId: string,
): Promise<void> {
  let delay = 500;
  for (let attempt = 0; attempt < 8; attempt++) {
    try {
      const channels = await client.discordChannels(sessionId);
      ctx.meta.discord = channels;
      if (channels.session_channel_id) return; // 揃ったら終了
    } catch {
      // Concordia 無効 / endpoint 未対応 (古い Concordia) — degrade して打ち切る
      return;
    }
    await new Promise((r) => setTimeout(r, delay));
    delay = Math.min(delay * 2, 5000);
  }
}

export function applyAutoTitle(ctx: SidecarContext, stat: ReturnType<typeof gatherRepoStat>): void {
  // 状態由来のタイトル更新は完全に best-effort。 ここで throw すると status loop
  // だけでなく sidecar の refreshAutoTitle 等 非 status 呼び出し元にも波及するため、
  // never-throw を保証する (タイトルが古くなる < 主処理を止めない)。
  try {
    // Drop stale notify marks before composing so old "[!]" doesn't linger
    // past its TTL across stat refreshes.
    if (isNotifyStale(ctx.notifyState)) {
      ctx.notifyState.mark = null;
      ctx.notifyState.expiresAt = null;
    }
    applyTitleWithMarks(
      ctx.titleState,
      {
        persona: ctx.meta.persona,
        roleLabel: ctx.roleLabel,
        stat,
        cwd: ctx.meta.cwd,
      },
      {
        conflict: ctx.conflictState.titleMark,
        notify: ctx.notifyState.mark,
      },
    );
  } catch (err) {
    process.stderr.write(`lictor: applyAutoTitle best-effort failed: ${(err as Error).message}\n`);
  }
}

/**
 * Pre-spawn skill seeding. Writes:
 *   - lictor-persona   : Concordia's persona.skill_template (if assigned)
 *   - lictor-session-context : repo-relevant memories scraped from
 *                              ~/.claude/projects/<cwd-key>/memory/
 *
 * Both are best-effort — failures log to stderr but don't block startup.
 */
function seedSkills(injector: SkillInjector, meta: Meta): void {
  // Persona skill
  const persona = meta.persona as Record<string, unknown> | null;
  const skillTemplate = persona && typeof persona.skill_template === "string"
    ? persona.skill_template
    : null;
  if (skillTemplate) {
    const display = (persona?.display_name as string | undefined) ?? "";
    const role = (persona?.name as string | undefined) ?? "persona";
    const description = display
      ? `Concordia-assigned persona for this session (${role} / ${display})`
      : `Concordia-assigned persona for this session (${role})`;
    try {
      injector.writeSkill(
        "lictor-persona",
        renderSkillMd({ name: "lictor-persona", description, body: skillTemplate }),
      );
    } catch (err) {
      process.stderr.write(`lictor: skill seed (persona) failed: ${(err as Error).message}\n`);
    }
  }

  // Session-context skill from memories
  try {
    const memDir = memoryDirForCwd(meta.cwd);
    const repoLeaf = repoLeafFromCwd(meta.cwd);
    const matches = findRepoMemories(memDir, repoLeaf, 3);
    if (matches.length > 0) {
      const body = renderMemoryDigest(matches);
      injector.writeSkill(
        "lictor-session-context",
        renderSkillMd({
          name: "lictor-session-context",
          description: `Repo-relevant memory matches for ${repoLeaf} (lictor-scoped, this session only)`,
          body,
        }),
      );
    }
  } catch (err) {
    process.stderr.write(`lictor: skill seed (memory) failed: ${(err as Error).message}\n`);
  }

  // session-end skill: provider 横断で「終了処理」 フローを inject.
  // Claude には slash command (`.claude/commands/session-end.md`) があるが、
  // Codex には slash command 機構が無いため、 同等のフローを skill として配布.
  // 冒頭の ack 出力 + 独白生成を provider 不問で AI 自身に回させる.
  try {
    injector.writeSkill(
      SESSION_END_SKILL_NAME,
      renderSkillMd({
        name: SESSION_END_SKILL_NAME,
        description: SESSION_END_SKILL_DESCRIPTION,
        body: SESSION_END_SKILL_BODY,
      }),
    );
  } catch (err) {
    process.stderr.write(`lictor: skill seed (session-end) failed: ${(err as Error).message}\n`);
  }
}

async function pushStat(ctx: SidecarContext): Promise<void> {
  if (!ctx.concordia || !ctx.sessionId) return;
  // 状態更新 (stat / 状態チャンネル) は best-effort。 セッション本体 (transcript
  // relay / 質問 / 入力注入) とは独立で、 ここで何が起きても主処理に波及させない。
  // 状態とセッションは「対応させる」 必要が無いので、 全 IO を 1 つの try/catch で
  // 黙って握りつぶす (誤った状態が出るより、 主処理を止めない方を優先する)。
  try {
    // active-repo が判明していればそれを基準に stat を採取. 未判明 (Claude 未起動、
    // hook 未発火、 transcript-tail 未 discover) なら wrap-start cwd フォールバック.
    const cwd = ctx.activeRepoState.lastActive ?? ctx.meta.cwd;
    const stat = gatherRepoStat(cwd);
    applyAutoTitle(ctx, stat); // auto-refresh title each cycle in case branch changed
    // v0.4: also refresh the live-state skill so claude sees the snapshot.
    if (ctx.injector) writeSessionStateSkill(ctx.injector, stat);
    await ctx.concordia.stat(ctx.sessionId, stat);
  } catch (err) {
    process.stderr.write(`lictor: pushStat best-effort failed: ${(err as Error).message}\n`);
  }
}

/**
 * 60-second background loop: active-repo relay, branch-change relay,
 * pending-tasks refresh, conflicts probe. Each step is best-effort and
 * isolated from the others.
 */
async function pollLiveState(ctx: SidecarContext): Promise<void> {
  if (!ctx.concordia || !ctx.sessionId) return;

  // ─── active-repo relay (v0.8) ──────────────────────────────────────────
  // ホスト Claude Code の PostToolUse hook (track-active-repo.sh) が
  // `<state-dir>/active-repos-<claude-sid>.txt` に append している repo root
  // 群を読み取り、 末尾エントリ (= 直近に触れたリポ) を Concordia の
  // session.repo_path に反映する.  meta.cwd は wrap-start cwd で固定なので、
  // 親ディレクトリで wrap している多リポ運用では実際の作業箇所を反映できない.
  // この watcher で statusline と同精度に上書きする.
  const claudeSid = ctx.getClaudeSessionId?.() ?? null;
  let activeCwd = ctx.meta.cwd;
  let activeRepos: string[] = [];
  if (claudeSid) {
    const stateDir = resolveActiveReposDir();
    activeRepos = readActiveRepos(activeReposPath(stateDir, claudeSid));
    activeCwd = pickActiveRepo(activeRepos, ctx.meta.cwd);
  }
  const activeChanged = activeCwd !== ctx.activeRepoState.lastActive;
  const listChanged = !sameStringList(activeRepos, ctx.activeRepoState.lastList);
  if (activeChanged) {
    try {
      await ctx.concordia.patchSession(ctx.sessionId, { repo_path: activeCwd });
      await ctx.concordia.event(ctx.sessionId, {
        kind: "lictor.active_repo.changed",
        payload: {
          active: activeCwd,
          previous: ctx.activeRepoState.lastActive,
          repos: activeRepos,
        },
      });
    } catch {
      // best-effort
    }
  }
  if (activeChanged || listChanged) {
    ctx.activeRepoState.lastActive = activeCwd;
    ctx.activeRepoState.lastList = activeRepos.slice();
  }

  // 残り branch / conflicts / 標題は active repo を基準に計算する。
  // gatherRepoStat は内部で全 git 失敗を握りつぶす (never-throw)、 applyAutoTitle も
  // never-throw 化済。 唯一 reject し得る branch relay の await だけを try/catch で
  // 隔離し、 何が起きても以降の pending-tasks / conflicts ステップは回す
  // (= docstring 通りステップ間独立を保証)。
  const stat = gatherRepoStat(activeCwd);
  if (activeChanged) applyAutoTitle(ctx, stat);

  // Branch relay — if the working branch changed since last seen, PATCH
  // Concordia and emit an event so other sessions/dashboards stay synced.
  if (stat.branch && stat.branch !== ctx.taskState.branch) {
    try {
      const next = await relayTask({
        client: ctx.concordia,
        sessionId: ctx.sessionId,
        injector: ctx.injector,
        state: ctx.taskState,
        branch: stat.branch,
        // Don't auto-fill desc — that's the user/claude's job via lictor cli task set.
        source: "auto",
      });
      ctx.taskState = next;
      // Conflict mark may shift on branch change; refresh title.
      applyAutoTitle(ctx, stat);
    } catch (err) {
      process.stderr.write(`lictor: pollLiveState branch relay best-effort failed: ${(err as Error).message}\n`);
    }
  }

  // Pending tasks → lictor-pending-tasks skill
  if (ctx.injector) {
    try {
      await refreshPendingTasksSkill(ctx.concordia, ctx.sessionId, ctx.injector);
    } catch {
      // ignore
    }
  }

  // Conflicts → lictor-conflicts skill + title mark
  if (ctx.injector) {
    try {
      const cs = await refreshConflictState(ctx.concordia, ctx.sessionId, ctx.injector, {
        repo: activeCwd,
        branch: stat.branch,
      });
      const changed = cs.titleMark !== ctx.conflictState.titleMark;
      ctx.conflictState = cs;
      if (changed) applyAutoTitle(ctx, stat);
    } catch {
      // ignore
    }
  }
}

function sameStringList(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}
