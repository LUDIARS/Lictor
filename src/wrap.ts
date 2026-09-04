import { randomUUID } from "node:crypto";
import { writeFileSync, statSync } from "node:fs";
import * as pty from "node-pty";
import { buildAnswerSequence, sanitizeKeySeq, startSidecar, type SidecarContext, type TitleState } from "./sidecar.js";
import { gatherBaseMeta, type Meta } from "./meta.js";
import { resetTitle } from "./osc.js";
import { createUserActivitySignal } from "./user-activity.js";
import { seedWorkspaceTrust, shouldSeedWorkspaceTrust } from "./workspace-trust-seed.js";
import { concordiaSpawnSessionMetadata } from "./spawn-context.js";
import { ConcordiaClient, loadConcordiaConfig, type LivenessHandle } from "./concordia.js";
import { gatherRepoStat } from "./stat.js";
import { withRepoOrigin } from "./repo-origin.js";
import { renderSkillMd, SkillInjector } from "./skill-injector.js";
import { findRepoMemories, memoryDirForCwd, renderMemoryDigest, repoLeafFromCwd } from "./memory-loader.js";
import { buildLictorHookSettings, resolveHarnessGuard } from "./harness-hook.js";
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
import { type ProviderConfig, PROVIDERS, resolveBinary } from "./provider.js";
import { startTranscriptTail, type TranscriptTailHandle } from "./transcript-tail.js";
import { scheduleGracefulExit, type GracefulExitHandle } from "./graceful-exit.js";
import { exitAfterCleanup } from "./exit-deadline.js";
import { archiveSessionLog } from "./session-archive.js";
import { SessionShutdown } from "./session-shutdown.js";
import { terminateProcessTree } from "./process-tree.js";
import { reportTaskInquiry } from "./task-inquiry.js";
import { PendingQuestionGate, markerGateId } from "./pending-question-gate.js";
import { bypassesMarkerHold } from "./inject-origin.js";
import {
  createDelegationInjector,
  delegationInjectDelayMs,
  delegationInjectMaxAttempts,
  delegationInjectVerifyMs,
  delegationSessionMetadata,
  loadDelegationPrompt,
  type DelegationInjector,
} from "./delegation-inject.js";
import {
  activeReposPath,
  claudeTranscriptStatePath,
  pickActiveRepo,
  readActiveRepos,
  resolveActiveRepoRoots,
  resolveActiveReposDir,
} from "./active-repos.js";
import { createSubmitWatchdog } from "./submit-watchdog.js";
import { writeAskMarkerPrompt, type AskMarker } from "./ask-marker.js";
import { planAskMarkerActivation } from "./ask-marker-activation.js";
import { postAnswerQuestion, postResolveQuestion } from "./ask-question-relay.js";
import { buildTextAnswerBody } from "./answer-code.js";
import {
  closeCodexAppServerSession,
  runCodexDelegationTurn,
  startCodexAppServerSession,
  type CodexAppServerSession,
} from "./codex-app-server-session.js";
import type { TranscriptFrameSink } from "./transcript-sink.js";
import { LICTOR_VERSION } from "./version.js";
import {
  providerRuntimeMetadata,
  type ProviderRuntimeMetadata,
} from "./provider-runtime-metadata.js";

const STAT_INTERVAL_MS = 10 * 60 * 1000;
const POLL_INTERVAL_MS = 60 * 1000;

export type CodexTransport = "app-server" | "legacy";

export function codexTransport(env: NodeJS.ProcessEnv = process.env): CodexTransport {
  const raw = env.LICTOR_CODEX_TRANSPORT?.trim() || "app-server";
  if (raw === "app-server" || raw === "legacy") return raw;
  throw new Error(`invalid LICTOR_CODEX_TRANSPORT=${raw}; expected app-server or legacy`);
}

/**
 * 実効 codex transport を決める。
 *
 * codex 0.144.x はターン 0 のスレッドの rollout を一切書かない (app-server 存命中
 * でも書かれないことを 2026-07-13 に実測)。 そのため対話セッションの
 * 「thread/start で bind → close → `codex resume <threadId>`」 は resume が
 * "No saved session found" で即死し、 spawn された Codex セッションが数十秒で
 * 全滅する。 App Server bind が機能するのは実ターンを回す headless delegation
 * のみなので、 対話 (delegation prompt なし) は legacy (rollout tail 採択) に
 * 落とす。 env LICTOR_CODEX_TRANSPORT の明示指定は常に尊重する。
 */
export function resolveCodexTransport(
  env: NodeJS.ProcessEnv,
  hasDelegationPrompt: boolean,
): CodexTransport {
  const configured = codexTransport(env);
  if (configured !== "app-server") return configured;
  if (env.LICTOR_CODEX_TRANSPORT?.trim()) return configured;
  return hasDelegationPrompt ? "app-server" : "legacy";
}

/**
 * codex rollout の session_meta.originator に焼く Lictor マーカー
 * (CODEX_INTERNAL_ORIGINATOR_OVERRIDE の値)。 セッション毎に一意にし、
 * transcript-tail の originator 施錠 (完全一致束縛) のキーにする。
 */
export function codexOriginatorMarker(sessionId: string | null): string {
  return sessionId ? `lictor:${sessionId}` : "lictor";
}

/** Headless supervisors often export TERM=dumb even though Lictor owns a PTY. */
export function normalizePtyTerm(raw: string | undefined): string {
  const value = raw?.trim();
  if (!value || value.toLowerCase() === "dumb" || value.toLowerCase() === "unknown") {
    return "xterm-256color";
  }
  return value;
}

/**
 * Cc が project cwd を明示して起動した detached session だけ、provider の初回
 * workspace trust picker を承認する。通常の端末起動では人間の確認を残す。
 *
 * boolean でなく「Yes を選ぶために送るキー列」を返す。新しい Claude の picker は
 * 既定カーソルが「❯ No, exit」に変わっており、 Enter だけ送ると **No を選んで
 * Claude が即終了**する。カーソル位置 (❯) と選択肢の表示順を読み、必要な方向へ
 * 移動してから Enter を送る。
 */
export function detachedWorkspaceTrustPrompt(
  providerName: string,
  output: string,
): string[] | null {
  // CSI/OSC 等の描画命令を除いてから、provider 固有の十分に限定した文言を照合する。
  // eslint-disable-next-line no-control-regex -- terminal escape sequence を意図的に対象にする
  const plain = output
    .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/gu, "")
    // cursor positioning is also the only separator between many TUI words.
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/gu, " ")
    // eslint-disable-next-line no-control-regex -- 残った C0 制御文字を空白へ畳む
    .replace(/[\x00-\x1f\x7f]+/gu, " ")
    .replace(/\s+/gu, " ");

  // カーソルが No 側なら、選択肢の表示順に応じた方向へ移動する。カーソルが
  // 描画されない旧 UI では先頭選択肢が既定だったため、同じ表示順から判断する。
  const keysFor = (yesLabel: string, noLabel: string): string[] => {
    const yesIndex = plain.indexOf(yesLabel);
    const noIndex = plain.indexOf(noLabel);
    if (plain.includes(`❯ ${yesLabel}`)) return ["\r"];
    const noIsSelected = plain.includes(`❯ ${noLabel}`) || noIndex < yesIndex;
    if (!noIsSelected) return ["\r"];
    return [noIndex < yesIndex ? "\x1b[B" : "\x1b[A", "\r"];
  };

  if (providerName === "codex") {
    const matched = plain.includes("Do you trust the contents of this directory?")
      && plain.includes("Yes, continue")
      && plain.includes("No, quit");
    return matched ? keysFor("Yes, continue", "No, quit") : null;
  }
  if (providerName === "claude") {
    const matched = plain.includes("Quick safety check:")
      && plain.includes("Yes, I trust this folder")
      && plain.includes("No, exit");
    return matched ? keysFor("Yes, I trust this folder", "No, exit") : null;
  }
  return null;
}

/** Parse a positive-int env var, falling back to `fallback` when unset/invalid. */
function envInt(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim() === "") return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/**
 * claude-desktop 由来の「子セッション」 マーカー env キー。
 *
 * Lictor が claude-desktop 経由のコンテキストから起動されると、 env に
 * `CLAUDE_CODE_CHILD_SESSION=1` / `CLAUDE_CODE_ENTRYPOINT=claude-desktop` /
 * `CLAUDE_CODE_SESSION_ID=<uuid>` が紛れ込み、 これらをそのまま wrapped claude へ
 * 渡すと claude は **child / desktop-managed セッション** として起動し、 session
 * transcript JSONL を `~/.claude/projects/<key>/` に **一切永続化しない** (desktop が
 * 自前管理する前提のため)。 すると transcript-tail が tail する対象が生まれず、 地の文の
 * 中継が完全に止まる (hook の transcript_path は報告されるが実体ゼロの phantom)。
 */
export const CHILD_SESSION_ENV_KEYS = [
  "CLAUDE_CODE_CHILD_SESSION",
  "CLAUDE_CODE_ENTRYPOINT",
  "CLAUDE_CODE_SESSION_ID",
] as const;

/**
 * wrapped 子プロセスへ渡す env から {@link CHILD_SESSION_ENV_KEYS} を除去する。
 *
 * strip するのは **claude provider のときだけ**。 この症状 (transcript 未永続化) は
 * claude 固有で、 codex / gemini はこれらの env を読まないため残しても無害だが、
 * 実証済みの provider にだけ手を入れる (コメントと実コードの整合を取り、 将来 provider
 * 追加時の予期せぬ干渉を避ける)。 OAuth/exec 系 env は認証に必要なので strip しない。
 *
 * 入力 env は変更せず、 常に新しいオブジェクトを返す純関数 (回帰テスト可能)。
 *
 * 実測 (隔離 cwd・confound-free): これらを env から strip すると claude は top-level
 * セッションとして起動し `<key>/<uuid>.jsonl` を通常通り生成する。 残すと jsonl が一切
 * 生成されない。 SessionStart hook の transcript_path 権威 (Option B) はこの実ファイルが
 * 在って初めて機能するため、 この strip が中継成立の前提になる。
 */
export function stripChildSessionEnv(
  env: NodeJS.ProcessEnv,
  provider: ProviderConfig,
): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = { ...env };
  if (provider.name !== "claude") return out;
  for (const key of CHILD_SESSION_ENV_KEYS) delete out[key];
  return out;
}

export async function runWrapped(args: string[], provider: ProviderConfig = PROVIDERS.claude): Promise<void> {
  const meta = gatherBaseMeta();
  meta.provider = provider.name;
  const runtimeMetadata = providerRuntimeMetadata(provider.name, args);

  // Concordia registration — best-effort. A failure here downgrades to v0.0
  // behavior (no persona, no auto-stat, no liveness) but does NOT block the
  // wrapped session from starting.
  const concordia = await tryRegisterConcordia(meta, provider, runtimeMetadata);

  if (concordia) {
    meta.session_id = concordia.id;
    meta.persona = concordia.persona;
    meta.role_label = concordia.roleLabel;
  }

  const titleState: TitleState = { manualOverride: null };

  // Claude skill injection writes to a session-scoped directory passed via
  // --add-dir. Providers with the "none" strategy, including Codex, never
  // construct an injector.
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
    activeRepoState: { lastActive: null, lastList: [] },
    getClaudeSessionId: null,
    getTranscript: null,
    repinTranscript: null,
    forceExit: null,
    requestGracefulExit: null,
    shutdown: null,
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

  // このセッションで実際にターンが始まったか (ローカル発話の submit / リモート注入 /
  // gate flush / delegation 自動注入)。 transcript-tail の fail-loud を「アイドルで未発話
  // なだけ」 の誤検知から守るために使う。 ターン起点となる経路は全てここを true にする。
  let sawSessionTurn = false;

  // 注入テキストが TUI の bracketed-paste で submit されず入力欄に溜まる事象の保険。
  // submitInject 後に arm し、 transcript に user フレーム (= submit 成立) が
  // LICTOR_SUBMIT_WATCHDOG_MS 以内に出なければ Enter を 1 回補う。0 で無効化。
  // 発火先は ctx.ptyWriter (pty spawn 後に差さる) を実行時評価する。
  const submitWatchdog = createSubmitWatchdog({
    write: (d) => ctx.ptyWriter?.(d),
    timeoutMs: envInt(process.env.LICTOR_SUBMIT_WATCHDOG_MS, 2000),
    log: (m) => process.stderr.write(`lictor: ${m}\n`),
  });

  // Holds ordinary pty injects while an AskUserQuestion picker is open, so a
  // stray Discord message / `/enter` / Codex submit-fallback can't commit the
  // picker's default option before the user actually answers. Opened/closed by
  // transcript-tail (question tool_use → tool_result); answers bypass it via
  // onAnswerQuestion. See pending-question-gate.ts.
  const pendingQuestionGate = new PendingQuestionGate(
    (text) => {
      if (ctx.ptyWriter) {
        provider.submitInject(ctx.ptyWriter, text);
        submitWatchdog.arm();
        // 保留していた inject が flush された = ターンが始まる。 fail-loud の
        // 誤検知ガード (isSessionActive) に反映する。
        sawSessionTurn = true;
      }
    },
    (msg) => process.stderr.write(`lictor: ${msg}\n`),
  );

  // ask マーカー由来の pending-question id を覚えておく。これらは picker ではなく
  // テキスト出力なので、回答は「キー注入」ではなく「テキスト注入」で返す
  // (単一/複数/自由文を全部テキスト返信に一本化)。
  const markerQuestionIds = new Set<number>();
  // テキスト返信をこのセッション自身が Concordia へ記録した marker 質問。回答本文は
  // すでに onInject で pty に届いているため、その結果として戻る question.answered
  // を再注入しない。remote button / WebUI 起点の回答はここに入らず従来どおり注入する。
  const locallyAnsweredMarkerQuestionIds = new Set<number>();
  // まだローカル/リモートで回答されていない marker 質問 (qid → 選択肢を持つ marker)。
  // テキスト返信は文頭に選択肢コードがある場合だけ Concordia に回答として記録する。
  // それ以外の本文はモデルへ届くがカードは未回答のまま残る。
  const openMarkerQuestions = new Map<number, AskMarker>();
  // 組み込み AskUserQuestion picker が Concordia に登録された question_id。
  // transcript-tail が AskUserQuestion tool_use を検出し Concordia に POST した後に
  // 登録される。onAnswerQuestion で markerQuestionIds にも無い id が来たとき、
  // ここにあれば picker キーストローク経路、無ければ Concordia 独自起源として
  // テキスト注入経路に振る（三分岐判定）。
  const pickerQuestionIds = new Set<number>();

  // WS reactor — attach AFTER ctx so the dispatcher can read live state.
  if (concordia) {
    concordia.liveness.close(); // close the pre-ctx liveness opened by tryRegisterConcordia
    concordia.liveness = concordia.client.openLiveness(
      concordia.id,
      concordia.enrollment,
      (msg) => reactToEvent(msg, {
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
        onTaskCompletion: ({ prNumber, outcome }) => {
          const activeRepos = resolveActiveRepoRoots(
            ctx.activeRepoState.lastList.length > 0
              ? ctx.activeRepoState.lastList
              : [ctx.meta.cwd],
          );
          const stat = gatherRepoStat(ctx.activeRepoState.lastActive ?? ctx.meta.cwd);
          void reportTaskInquiry(ctx.concordia, ctx.sessionId, {
            activeRepos,
            branch: stat.branch ?? ctx.taskState.branch,
            hasUncommittedChanges: stat.dirty,
            recentPr: prNumber === null ? null : { number: prNumber, outcome },
            task: ctx.taskState.desc,
          });
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
          //
          // ask マーカーの質問が開いている間は **自動 inject だけ** を保留する
          // (goal-and-go / お伺い / taskflow / Revisor 終局通知)。 これを通すと
          // モデルが自分の質問に自分で答えて進んでしまう。 人間の発言とセッション
          // 終了指示 (auto:session-end) は会話 / 終了を止めないためそのまま通す
          // (回答自体は onAnswerQuestion 経由)。
          if (pendingQuestionGate.shouldDefer(safe, { bypassesMarkerHold: bypassesMarkerHold(source) })) {
            process.stderr.write(
              `lictor: held inject from Concordia while question pending (source=${source ?? "?"})\n`,
            );
            return;
          }
          const writer = ctx.ptyWriter;
          provider.submitInject(writer, safe);
          submitWatchdog.arm();
          sawSessionTurn = true;
          // Telemetry breadcrumb — surface that the inject landed so the
          // user can see who pushed what without trawling Concordia logs.
          process.stderr.write(
            `lictor: injected ${safe.length} bytes from Concordia (source=${source ?? "?"}, provider=${provider.name})\n`,
          );
        },
        onAnswerQuestion: ({ questionId, index, text }) => {
          if (!ctx.ptyWriter) return;
          sawSessionTurn = true;
          // `postAnswerQuestion` によるこのセッション自身の回答エコー。テキストは
          // すでに session.inject で届いているので、二重に送らない。
          if (locallyAnsweredMarkerQuestionIds.delete(questionId)) return;
          // 三分岐: ask-marker / 組み込み picker / Concordia 独自起源。
          //
          // 1. ask マーカー由来: picker ではなくテキスト出力なので「テキスト + Enter」。
          //    answer_text は単一=ラベル / 複数=カンマ結合ラベル / Other=自由文。
          if (markerQuestionIds.has(questionId)) {
            markerQuestionIds.delete(questionId);
            openMarkerQuestions.delete(questionId);
            pendingQuestionGate.resolveQuestion(markerGateId(questionId));
            const safe = sanitizeKeySeq(text);
            if (!safe) return;
            provider.submitInject(ctx.ptyWriter, safe);
            submitWatchdog.arm();
            process.stderr.write(
              `lictor: answered ask-marker question via text (qid=${questionId}, provider=${provider.name})\n`,
            );
            return;
          }
          // 2. 組み込み AskUserQuestion picker: transcript-tail が tool_use を検出し
          //    Concordia に登録した question_id。Down×N + Enter でローカル picker を確定。
          //    Concordia carries 0-based answer_index; buildAnswerSequence is 1-based ([1, 50]).
          if (pickerQuestionIds.has(questionId)) {
            pickerQuestionIds.delete(questionId);
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
            return;
          }
          // 3. Concordia 独自起源の質問 (INITIAL_WORK_QUESTION 等): Lictor は tool_use を
          //    transcript で見ていないので picker は開いていない。「テキスト + Enter」 で
          //    pty に流す。キーストローク注入は picker が無い空プロンプトに Down+Enter を
          //    打つだけで no-op になるため使わない。
          const safe = sanitizeKeySeq(text);
          if (!safe) return;
          provider.submitInject(ctx.ptyWriter, safe);
          submitWatchdog.arm();
          process.stderr.write(
            `lictor: answered Concordia-originated question via text (qid=${questionId}, provider=${provider.name})\n`,
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

  let sharedCleanupDone = false;
  const cleanupShared = async (): Promise<void> => {
    if (sharedCleanupDone) return;
    sharedCleanupDone = true;
    if (statTimer) clearInterval(statTimer);
    if (pollTimer) clearInterval(pollTimer);
    submitWatchdog.stop();
    pendingQuestionGate.forceClear();
    concordia?.liveness.close();
    sidecar.close();
    resetTitle();
    injector?.cleanup();
  };

  // spawn する実バイナリ。 binaryEnvVar (例: gemma4-12 の LICTOR_FAMULUS_BIN) が
  // 設定されていれば PATH 既定を上書きする。 log / spawn で同じ値を使う。
  const effectiveBinary = resolveBinary(provider);

  process.stderr.write(
    `lictor: wrapping ${provider.displayName} (${effectiveBinary})${
      concordia ? `, Concordia session ${concordia.id}` : ""
    }\n`,
  );

  // claude-desktop 由来の「子セッション」 マーカー (CHILD_SESSION_ENV_KEYS) を wrapped
  // claude へ渡さない。 残すと claude が transcript JSONL を永続化せず中継が全停止する。
  // claude provider 限定で strip する (詳細は stripChildSessionEnv の docstring)。
  const env: NodeJS.ProcessEnv = stripChildSessionEnv(
    {
      ...process.env,
      LICTOR_PORT: String(sidecar.port),
      LICTOR_PID: String(process.pid),
      LICTOR_SESSION_START: meta.start_iso,
      LICTOR_PROVIDER: provider.name,
    },
    provider,
  );
  if (concordia) {
    env.LICTOR_SESSION_ID = concordia.id;
    env.CONCORDIA_SESSION_ID = concordia.id;
    if (meta.persona?.name) env.LICTOR_PERSONA_NAME = String(meta.persona.name);
    if (meta.role_label) env.LICTOR_ROLE_LABEL = meta.role_label;
  }
  // codex: rollout session_meta.originator に自分のマーカーを焼く。 transcript-tail は
  // このマーカー完全一致でのみ束縛する (originator 施錠)。 codex 0.144.1 が env を
  // 尊重することを 2026-07-13 に実測確認。 ユーザが明示設定していれば上書きしない。
  if (provider.name === "codex" && !env.CODEX_INTERNAL_ORIGINATOR_OVERRIDE) {
    env.CODEX_INTERNAL_ORIGINATOR_OVERRIDE = codexOriginatorMarker(concordia?.id ?? null);
  }
  // SessionStart hook 実行時に Claude が CLAUDE_PROJECT_DIR を追加しても正本が
  // 分岐しないよう、wrap 側で一度だけ決定して hook command と tail の両方へ渡す。
  const activeReposStateDir = resolveActiveReposDir(env);

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
  let providerArgs =
    provider.skillStrategy === "claude-add-dir" && injector
      ? ["--add-dir", injector.sessionDir, ...baseArgs]
      : baseArgs;

  let extraSettingsPath: string | null = null;
  if (concordia && injector && provider.name === "claude") {
    try {
      extraSettingsPath = writePermissionHookSettings(
        injector.sessionDir,
        meta.cwd,
        activeReposStateDir,
      );
    } catch (err) {
      process.stderr.write(
        `lictor: permission-hook settings write failed: ${(err as Error).message}\n`,
      );
    }
  }
  if (extraSettingsPath) providerArgs.push("--settings", extraSettingsPath);

  // セッション ID 固定束縛 (`--session-id <uuid>`) は撤去した。
  //
  // 旧実装は uuid を発番して `--session-id` で渡し、 transcript-tail に
  // `<uuid>.jsonl` だけを claim させて crosstalk を防いでいた。 しかし
  // claude-code 2.1.187 は渡した `--session-id` を **transcript ファイル名に
  // 反映しなくなった**: 渡した uuid を logical session_id としては採用するが、
  // transcript JSONL は自前採番の別 uuid (`<other>.jsonl`) に書き出す。 その結果、
  // 計算 pin (`<uuid>.jsonl`) も、 SessionStart hook が報告する transcript_path
  // (= 渡した `<session_id>.jsonl`) も、 実体の無い phantom を指し、 中継が一切
  // 始まらなくなった (hook payload の transcript_path が pin uuid を返すのを実測)。
  //
  // 代わりに pin を渡さない。 すると claude が session_id を自前採番し、 SessionStart
  // hook が報告する transcript_path は実ファイルを正しく指す (= transcript_path 権威が
  // 真実になる)。 crosstalk は「mtime 推測をせず hook 報告の実パスだけを掴む」 で維持する
  // (transcript-tail.discover は hook 権威が設定済なら実パス確定まで mtime に降りず待ち、
  // 猶予を過ぎても解決しなければ fail-loud で表面化する)。 ユーザが自分で --resume /
  // --continue / --from-pr / --session-id を渡している場合 (既存 session を開く意図) も
  // 同様に hook 権威へ委ねる。
  //
  // NOTE: LICTOR_PIN_TRANSCRIPT=1 ワーカー (Discutere #135) が使っていた
  // LICTOR_TRANSCRIPT_FILE は pin 撤去で起動時に先出しできなくなった。 ワーカーは
  // `<stateDir>/claude-transcript-<lictorId>.txt` (SessionStart hook が書く実パス) を
  // 読むこと。
  const pinnedTranscriptPath: string | null = null;

  // ask マーカーの検出と provider 固有のステアリング注入。
  //   - claude: 共通マーカールール + 組み込み AskUserQuestion 禁止 を常時
  //     --append-system-prompt-file で注入 (ファイル経由で Windows の cmd.exe
  //     クォート問題を回避)。
  //   - codex : グローバル skill / セッション外 steering を利用するため、session-scoped
  //     SkillInjector の有無とは独立して transcript 検出を有効にする。
  // gemini は注入機構が無いので skip。検出側 (transcript-tail) は askMarkerActive と連動。
  // @implements SPEC-ASK-MARKER-ACTIVATION
  const askMarkerPlan = planAskMarkerActivation(
    provider.name,
    concordia !== null,
    injector !== null,
  );
  let askMarkerActive = askMarkerPlan.enabled;
  let askMarkerReason: string = askMarkerPlan.reason;
  if (askMarkerPlan.injection === "claude-system-prompt") {
    try {
      if (!injector) throw new Error("activation plan requires session injector");
      const promptPath = writeAskMarkerPrompt(injector.sessionDir);
      providerArgs.push("--append-system-prompt-file", promptPath);
    } catch (err) {
      askMarkerActive = false;
      askMarkerReason = `system-prompt-write-failed:${(err as Error).message}`;
    }
  }
  process.stderr.write(
    `lictor: ask-marker provider=${provider.name} enabled=${askMarkerActive} reason=${askMarkerReason}\n`,
  );

  const delegationPrompt = loadDelegationPrompt(env);
  let codexAppServerSession: CodexAppServerSession | null = null;
  let expectedCodexThreadId: string | null = null;
  let codexTranscriptSink: TranscriptFrameSink | null = null;
  const transport = provider.name === "codex"
    ? resolveCodexTransport(env, delegationPrompt !== null)
    : "legacy";

  if (provider.name === "codex" && transport === "app-server") {
    const standaloneSink = concordia ? undefined : createVolatileTranscriptSink();
    try {
      codexAppServerSession = await startCodexAppServerSession({
        binary: effectiveBinary,
        cwd: meta.cwd,
        env,
        concordiaBaseUrl: concordia?.client.cfg.baseUrl,
        lictorSessionId: concordia?.id,
        sink: standaloneSink,
        lictorVersion: LICTOR_VERSION,
        requestTimeoutMs: envInt(env.LICTOR_CODEX_APP_SERVER_REQUEST_TIMEOUT_MS, 30_000),
        // Concordia はイベントループ停滞で 2s を超えて固まることがある (2026-07-12
        // 実測: transcript POST 応答まで数秒〜)。 短い timeout は同 seq 再送 →
        // INSERT OR IGNORE 重複を誘発するだけなので、bootstrap を殺さない余裕を持たせる。
        transcriptTimeoutMs: envInt(env.LICTOR_TRANSCRIPT_POST_TIMEOUT_MS, 10_000),
        transcriptMaxAttempts: envInt(env.LICTOR_TRANSCRIPT_MAX_ATTEMPTS, 3),
        transcriptRetryBaseMs: envInt(env.LICTOR_TRANSCRIPT_RETRY_BASE_MS, 100),
        transcriptMaxQueue: envInt(env.LICTOR_TRANSCRIPT_MAX_QUEUE, 1_000),
        onDiagnostic: (message) => process.stderr.write(`lictor: codex app-server: ${message}\n`),
      });
    } catch (error) {
      await cleanupShared();
      await unregisterConcordiaSession(concordia);
      throw error;
    }
    ctx.forceExit = () => codexAppServerSession?.client.terminate();
    ctx.requestGracefulExit = () => codexAppServerSession?.client.terminate();

    if (delegationPrompt) {
      try {
        await runCodexDelegationTurn(codexAppServerSession, {
          prompt: delegationPrompt.text,
          cwd: meta.cwd,
          turnTimeoutMs: envInt(env.LICTOR_CODEX_APP_SERVER_TURN_TIMEOUT_MS, 4 * 60 * 60 * 1_000),
        });
        await closeCodexAppServerSession(codexAppServerSession);
      } finally {
        codexAppServerSession.client.terminate();
        await cleanupShared();
        await unregisterConcordiaSession(concordia);
      }
      return;
    }

    expectedCodexThreadId = codexAppServerSession.identity.threadId;
    codexTranscriptSink = codexAppServerSession.sink;
    try {
      await codexAppServerSession.client.close();
    } catch (error) {
      codexAppServerSession.client.terminate();
      await cleanupShared();
      await unregisterConcordiaSession(concordia);
      throw error;
    }
    providerArgs = ["resume", expectedCodexThreadId, ...providerArgs];
    process.stderr.write(
      `lictor: Codex thread bound via app-server (${expectedCodexThreadId}); starting interactive resume\n`,
    );
  }

  // Detached Cc spawn (人間が picker に答えられない) は、claude の初回 picker
  // (workspace trust / MCP 確認) を起動前に ~/.claude.json へ焼いて出さなくする。
  // 画面キーの自動承認 (下の onData) は文言変更時のフォールバック。
  if (shouldSeedWorkspaceTrust({
    hasRegisteredConcordiaSession: concordia !== null,
    hasSpawnCredential: Boolean(concordia?.enrollment),
    providerName: provider.name,
  })) {
    try {
      const seeded = seedWorkspaceTrust({ cwd: process.cwd() });
      if (seeded) {
        // project path と MCP server 名はローカル構成・個人情報を含み得るためログへ出さない。
        process.stderr.write("lictor: workspace trust pre-seeded\n");
      }
    } catch {
      // fs error message はホームディレクトリ等を含み得る。詳細を端末ログへ漏らさない。
      process.stderr.write("lictor: workspace trust pre-seed failed\n");
    }
  }

  // node-pty on Windows uses CreateProcessW which does not auto-resolve .cmd
  // extensions. CLI bins ship as `<name>.cmd` in npm global bin, so wrap via
  // cmd.exe; on POSIX, spawn the binary directly.
  const isWindows = process.platform === "win32";
  const ptyFile = isWindows ? process.env.ComSpec ?? "cmd.exe" : effectiveBinary;
  const ptyArgs = isWindows ? ["/d", "/s", "/c", effectiveBinary, ...providerArgs] : providerArgs;
  const ptyTerm = normalizePtyTerm(env.TERM);
  const ptyEnv = { ...env, TERM: ptyTerm } as { [key: string]: string };

  const { cols, rows } = currentSize();
  let childExited = false;
  let shutdownRequested = false;
  let child: pty.IPty;
  try {
    child = pty.spawn(ptyFile, ptyArgs, {
      name: ptyTerm,
      cols,
      rows,
      cwd: process.cwd(),
      env: ptyEnv,
      // useConpty is on by default on Windows 10 1809+; node-pty falls back to
      // winpty otherwise. We do not override.
    });
  } catch (error) {
    await cleanupShared();
    await unregisterConcordiaSession(concordia);
    throw error;
  }

  ctx.ptyWriter = (data: string) => child.write(data);
  ctx.forceExit = () => { terminatePty(child, "SIGTERM"); };
  // session-end の session-log 保存を途中で殺さないため、force-exit は既定で
  // 「猶予付き」: transcript が一定時間無活動になってから kill する。
  let gracefulExit: GracefulExitHandle | null = null;
  ctx.requestGracefulExit = (gopts) => {
    if (gopts?.immediate) { gracefulExit?.cancel(); terminatePty(child, "SIGTERM"); return; }
    if (gracefulExit) return; // 既にスケジュール済 (idempotent)
    gracefulExit = scheduleGracefulExit({
      // transcript JSONL の mtime = 最終書き込み時刻 = 活動シグナル。
      lastActivityMs: () => {
        const p = transcriptTail?.getTranscriptPath() ?? null;
        if (!p) return null;
        try { return statSync(p).mtimeMs; } catch { return null; }
      },
      kill: () => terminatePty(child, "SIGTERM"),
      idleMs: envInt(env.LICTOR_SESSION_END_IDLE_KILL_MS, 300_000),
      maxWaitMs: envInt(env.LICTOR_SESSION_END_MAX_WAIT_MS, 1_800_000),
      checkMs: envInt(env.LICTOR_SESSION_END_CHECK_MS, 30_000),
      log: (m) => process.stderr.write(`lictor: ${m}\n`),
    });
  };

  // Delegation prompt auto-inject — when Concordia spawned us via
  // /v1/delegation/invoke, env CONCORDIA_DELEGATION_PROMPT_FILE points at the
  // rendered prompt. We paste+submit it once, after the TUI has had time to
  // draw (armed on first pty output). Best-effort; no env → no-op.
  let delegationInjector: DelegationInjector | null = null;
  if (delegationPrompt && transport === "legacy") {
    delegationInjector = createDelegationInjector({
      prompt: delegationPrompt,
      submit: (text) => {
        provider.submitInject((d) => child.write(d), text);
        // 他の submitInject 呼び出しと同様、Enter が TUI に取りこぼされた場合に
        // transcript の user フレーム観測まで再送する保険をここでも起動する
        // (#598: 委託 prompt の Enter 未送信でセッションが空プロンプトのまま止まる事象)。
        submitWatchdog.arm();
        // delegation プロンプトの自動注入 = このセッションの最初のターン。
        sawSessionTurn = true;
      },
      delayMs: delegationInjectDelayMs(env),
      // 到達確認と再送。 submit は「届いたか」 を知らないので、 transcript に user
      // フレームが出るまでを到達の証跡にする (delegation-inject.ts の説明を参照)。
      // Concordia 無しでは transcript tail 自体を起動しないため、観測不能な再送は無効化する。
      verifyMs: concordia ? delegationInjectVerifyMs(env) : 0,
      maxAttempts: delegationInjectMaxAttempts(env),
      clearInput: (data) => child.write(data),
      log: (m) => process.stderr.write(`lictor: ${m}\n`),
    });
  }

  // Transcript tail — start watching ~/.claude/projects/<cwdKey>/ for the
  // new .jsonl claude will create, then relay each parsed line to
  // Concordia as a transcript-frame. Best-effort; failures don't affect
  // the wrapped session at all. Only meaningful when concordia is up.
  let transcriptTail: TranscriptTailHandle | null = null;
  if (concordia) {
    // 接続先は ConcordiaClient の解決済み設定 (env + 既定 11111) を単一情報源にする。
    const concordiaBaseUrl = concordia.client.cfg.baseUrl;
    const lictorTranscriptStatePath =
      provider.name === "claude"
        ? claudeTranscriptStatePath(activeReposStateDir, concordia.id)
        : null;
    transcriptTail = startTranscriptTail({
      cwd: meta.cwd,
      sessionId: concordia.id,
      concordiaBaseUrl,
      provider,
      expectedCodexThreadId,
      // originator 施錠: 自分が env に焼いたマーカー (またはユーザ明示値) と
      // 完全一致する rollout だけを束縛候補にする。
      expectedCodexOriginator:
        provider.name === "codex" ? env.CODEX_INTERNAL_ORIGINATOR_OVERRIDE ?? null : null,
      transcriptSink: codexTranscriptSink,
      onRelayError: (error) => {
        process.stderr.write(`lictor: transcript relay failed: ${error.message}\n`);
        if (provider.name === "codex" && transport === "app-server") {
          terminatePty(child, "SIGTERM");
        }
      },
      onQuestionOpen: (qid) => pendingQuestionGate.openQuestion(qid),
      onQuestionResolved: (qid) => pendingQuestionGate.resolveQuestion(qid),
      askMarkerEnabled: askMarkerActive,
      pinnedTranscriptPath,
      // tail 対象を束縛する権威ソース。 SessionStart hook (lictor cli session-id-hook) が
      // claude の実 transcript_path をこのファイルへ書く。 これにより --session-id uuid と
      // 実ファイル名が不一致でも実ファイルを掴め、 /clear ローテートも追従し、 mtime 推測を
      // 排除して別セッション混入 (crosstalk) を構造的に防ぐ。state dir は wrapper が
      // 一度だけ解決し、生成した hook command にも明示して同じ正本を使わせる。
      lictorTranscriptStatePath,
      // 権威 transcript_path を Concordia の session 行へ届ける (best-effort)。
      // Concordia のコンテキスト推定が時刻マッチ推測ではなく実パスを読めるようになる。
      onAuthoritativeTranscriptPath: (path) => {
        void concordia.client
          .patchSession(concordia.id, { transcript_path: path })
          .catch(() => {
            /* best-effort — Concordia 不通で tail を止めない */
          });
      },
      onUserMessage: () => {
        submitWatchdog.noteUserMessage();
        // 委託 prompt の到達確認も同じシグナルで行う (再送を止める)。
        delegationInjector?.noteUserMessage();
      },
      onPickerQuestionRegistered: (qid) => {
        // 組み込み AskUserQuestion picker が Concordia に登録された。
        // onAnswerQuestion の三分岐判定で「picker キーストローク経路」として識別するために控える。
        pickerQuestionIds.add(qid);
      },
      onAskMarkerPosted: (qid, marker) => {
        // この id の回答は picker キー注入ではなくテキスト注入で返す。
        markerQuestionIds.add(qid);
        openMarkerQuestions.set(qid, marker);
        // 未回答の質問は blocker。 回答が来るまで自動 inject を保留する。
        pendingQuestionGate.openQuestion(markerGateId(qid), "automatic");
      },
      onUserReply: (text) => {
        // テキスト返信のうち、 **文頭に選択肢コードを明示したもの** だけを回答として
        // 記録する (`[A] これで` / `[A][C]`)。 ask リレーが壊れてカードを操作できない
        // ときの避難口。 それ以外の本文は回答にしない — 無関係な発言 1 通でカードが
        // 閉じてしまい、 後からボタン / WebUI で答えられなくなるため。
        // A reply has no question identifier. Attribute it only to the latest
        // outstanding card, rather than silently answering every open card
        // with the same text. Keep older cards available for their own reply.
        const entry = Array.from(openMarkerQuestions.entries()).at(-1);
        if (!entry || !text.trim()) return;
        const [qid, marker] = entry;
        const body = buildTextAnswerBody(qid, text, marker);
        if (!body) return; // コード無し → 質問は開いたまま (blocker)
        openMarkerQuestions.delete(qid);
        markerQuestionIds.delete(qid);
        locallyAnsweredMarkerQuestionIds.add(qid);
        pendingQuestionGate.resolveQuestion(markerGateId(qid));
        // 記録できなければ (Concordia 不通 / ボタン回答と競合して 409) 従来どおり
        // resolve だけ通知し、 古いボタンは失効させる。
        void postAnswerQuestion(concordiaBaseUrl, concordia.id, body).then((ok) => {
          if (!ok) {
            // 409 なら別経路の回答イベントを受け取る余地を残す。通信失敗の場合も
            // 抑止印を残す理由はない。
            locallyAnsweredMarkerQuestionIds.delete(qid);
            void postResolveQuestion(concordiaBaseUrl, concordia.id, qid);
          }
        });
      },
      // transcript は claude が初回ターンを受けてから書く。 無操作のアイドルセッションを
      // 「中継不能」 と誤検知しないよう、 実際にターンが始まった (submit/inject があった)
      // ときだけ stderr の fail-loud を出させる。
      isSessionActive: () => sawSessionTurn,
    });
    // active-repos watcher が transcript-tail 経由で session UUID を引けるよう
    // ctx に getter を差す. transcript-tail が JSONL を発見するまで null を返す.
    // claude / codex 両 provider の filename 規約は provider.extractSessionId
    // が抽象化する.
    const tail = transcriptTail;
    ctx.getClaudeSessionId = () => tail.getSessionUuid();
    // `GET /v1/transcript` の読み出し口. transcript-tail handle に委譲.
    ctx.getTranscript = (limit, raw) => tail.readRecent(limit, { raw });
    // `POST /v1/repin` の実体. /clear なしで relay を生 transcript へ束縛し直す.
    ctx.repinTranscript = () => tail.forceRediscover();
  }

  ctx.shutdown = new SessionShutdown({
    onStart: () => {
      shutdownRequested = true;
    },
    unregister: async () => {
      if (ctx.concordia && ctx.sessionId) await ctx.concordia.unregister(ctx.sessionId);
    },
    isCliAlive: () => !childExited,
    kill: async () => {
      gracefulExit?.cancel();
      await terminateProcessTree(child.pid, {
        terminateDirect: () => terminatePty(child, "SIGTERM"),
      });
    },
    flush: async () => {
      transcriptTail?.stop();
      if (codexTranscriptSink) await codexTranscriptSink.flush();
    },
    archive: async (reason) => archiveSessionLog({
      sessionId: ctx.sessionId ?? `lictor-${process.pid}`,
      claudeSessionId: ctx.getClaudeSessionId?.() ?? null,
      meta,
      activeRepos: resolveActiveRepoRoots(
        ctx.activeRepoState.lastList.length > 0
          ? ctx.activeRepoState.lastList
          : [meta.cwd],
      ),
      reason,
      transcriptPath: transcriptTail?.getTranscriptPath() ?? null,
      stateDir: activeReposStateDir,
    }).path,
    reportSessionEndDone: async () => {
      if (ctx.concordia && ctx.sessionId) await ctx.concordia.reportSessionEndDone(ctx.sessionId);
    },
    cleanup: cleanupSessionResources,
    scheduleExit: () => {
      setTimeout(() => process.exit(0), 50);
    },
    warn: (message) => process.stderr.write(`lictor: ${message}\n`),
  });

  // pty → real terminal stdout.
  // Cc spawn (enrollment 付き) は terminal tab で stdin が TTY でも picker に応答する
  // 人間がいないため、TTY 有無では判定しない (事前焼き込みと同じ基準)。
  const autoConfirmWorkspaceTrust = Boolean(concordia?.enrollment);
  let workspaceTrustPending = autoConfirmWorkspaceTrust;
  let workspaceTrustOutput = "";
  const onData = (data: string) => {
    // First output from the wrapped CLI means its TUI is alive; arm the
    // one-shot delegation inject (fires after delayMs). Harmless when null.
    delegationInjector?.notifyData();
    try {
      process.stdout.write(data);
    } catch {
      // stdout may be torn down during shutdown; ignore.
    }
    if (workspaceTrustPending) {
      workspaceTrustOutput = (workspaceTrustOutput + data).slice(-32_768);
      const trustKeys = detachedWorkspaceTrustPrompt(provider.name, workspaceTrustOutput);
      if (trustKeys) {
        workspaceTrustPending = false;
        workspaceTrustOutput = "";
        process.stderr.write(
          `lictor: auto-confirming ${provider.name} workspace trust for detached Concordia spawn `
          + `(keys=${trustKeys.length})\n`,
        );
        // Picker の最終描画と入力ハンドラ有効化が同じ output tick に重なるため、
        // 即時 write は Codex/Claude の双方でキーを取りこぼしうる。 ↓ → Enter の
        // 複数キーも同 tick に詰めず、 1 打鍵ずつ間隔を空けて送る。
        trustKeys.forEach((key, index) => {
          setTimeout(() => {
            try {
              child.write(key);
            } catch {
              // provider が先に終了した場合は何もしない。
            }
          }, 250 + index * 200);
        });
      }
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
  // 物理端末の生キーストローク = ユーザの入力意思。 Concordia の idle-nudge に
  // user_activity を送って待機催促タイマをキャンセルさせる。 inject
  // (submitInject/ptyWriter) は別経路なのでここには来ない。 打鍵ごとに来るため
  // debounce (既定 2s) で間引く。 best-effort — Concordia 未接続/失敗は無視。
  const signalUserActivity = concordia
    ? createUserActivitySignal({
        send: () => {
          void concordia.client
            .event(concordia.id, { kind: "user_activity" })
            .catch(() => {});
        },
      })
    : () => {};
  const onStdin = (chunk: Buffer) => {
    signalUserActivity();
    // ローカル端末で Enter (CR) を押した = ターンを submit した、 とみなす。
    if (chunk.includes(0x0d)) sawSessionTurn = true;
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

  async function cleanupSessionResources(): Promise<void> {
    transcriptTail?.stop();
    gracefulExit?.cancel();
    await cleanupShared();
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
  }

  const cleanup = async () => {
    transcriptTail?.stop();
    gracefulExit?.cancel();
    if (codexTranscriptSink) {
      try {
        await codexTranscriptSink.flush();
      } catch (error) {
        process.stderr.write(`lictor: transcript flush failed during cleanup: ${(error as Error).message}\n`);
      }
    }
    await cleanupSessionResources();
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
    // /v1/shutdown が所有する unregister → kill → flush → archive → exit の途中。
    // 通常 onExit cleanup を競合させると archive 前に process.exit し得るため任せる。
    if (shutdownRequested) return;
    // cleanup が (Concordia 詰まり等で) 解決しなくても必ず終了する。 待ち切れない
    // ときにラッパが残ると、子が死んだ後も node プロセスが OS に居座る。
    exitAfterCleanup({
      cleanup,
      warn: (message) => process.stderr.write(`lictor: ${message}\n`),
      exit: () => {
        if (signal && process.platform !== "win32") {
          // POSIX: re-raise so wait status mirrors the child's.
          process.kill(process.pid, signalNumberToName(signal));
          return;
        }
        process.exit(exitCode ?? 0);
      },
    });
  });

  // OS-level signals to lictor itself (e.g. external kill). Forward to pty,
  // then let onExit drive cleanup.
  const forward = (sig: NodeJS.Signals) => () => {
    if (childExited) return;
    try {
      terminatePty(child, sig);
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
function writePermissionHookSettings(
  sessionDir: string,
  cwd: string,
  sessionStateDir: string,
): string {
  const path = `${sessionDir}/lictor-hook-settings.json`;
  // cwd から上位を辿って .claude/hooks/harness-guard.mjs を見つけたら PreToolUse(Bash)
  // に注入する (HARNESS §4 の地雷を着手前に止める)。無ければ従来どおり 2 フックのみ。
  const settings = buildLictorHookSettings(resolveHarnessGuard(cwd), sessionStateDir);
  writeFileSync(path, JSON.stringify(settings, null, 2), "utf8");
  return path;
}

function currentSize(): { cols: number; rows: number } {
  const cols = process.stdout.columns ?? 80;
  const rows = process.stdout.rows ?? 24;
  return { cols, rows };
}

function createVolatileTranscriptSink(): TranscriptFrameSink {
  let seq = 0;
  return {
    post: async () => ({ seq: seq++, persisted: true }),
    flush: async () => undefined,
  };
}

function terminatePty(child: pty.IPty, signal: NodeJS.Signals): void {
  if (process.platform === "win32") {
    child.kill();
    return;
  }
  child.kill(signal);
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
  /** Spawn identity already registered with Concordia; never log this value. */
  enrollment: string | null;
  persona: Meta["persona"];
  roleLabel: string | null;
  /** Mutable — wrap.ts swaps this out after ctx is built to attach the reactor. */
  liveness: LivenessHandle;
}

async function unregisterConcordiaSession(concordia: ConcordiaSlot | null): Promise<void> {
  if (!concordia) return;
  try {
    const reply = await concordia.client.unregister(concordia.id);
    if (!reply?.report) return;
    const text = typeof reply.report === "string"
      ? reply.report
      : JSON.stringify(reply.report, null, 2);
    process.stderr.write(`\nlictor: Concordia session report\n${text}\n`);
  } catch {
    // Concordia cleanup is best-effort; the wrapped process is already ending.
  }
}

async function tryRegisterConcordia(
  meta: Meta,
  provider: ProviderConfig,
  runtimeMetadata: ProviderRuntimeMetadata,
): Promise<ConcordiaSlot | null> {
  const cfg = loadConcordiaConfig();
  if (!cfg.enabled) return null;
  const client = new ConcordiaClient(cfg);
  const id = `lictor-${randomUUID()}`;
  try {
    const stat0 = gatherRepoStat(meta.cwd);
    const spawnMetadata = concordiaSpawnSessionMetadata(process.env);
    const enrollment = spawnMetadata.concordia_spawn_id ?? null;
    const registered = await client.register(withRepoOrigin({
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
        ...runtimeMetadata,
        // delegation spawn 由来なら run 識別子を載せる。Concordia が run↔子セッションを
        // 決定的に紐付け (child_session_id を焼く) → inject / 外注リスト紐付けが機能する。
        ...delegationSessionMetadata(process.env),
        // Cc からの interactive spawn なら一意 id + cwd 指定有無を返す。
        // Concordia はこれを根拠に対象セッションだけへ project 特定 instruction を inject する。
        ...spawnMetadata,
      },
    }));
    const liveness = client.openLiveness(id, enrollment);
    return {
      client,
      id: registered.id,
      enrollment,
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

const SESSION_CONTEXT_SKILL_NAME = "lictor-session-context";

function syncSessionContextSkill(injector: SkillInjector, cwd: string): void {
  try {
    const memDir = memoryDirForCwd(cwd);
    const repoLeaf = repoLeafFromCwd(cwd);
    const matches = findRepoMemories(memDir, repoLeaf, 3);
    if (matches.length === 0) {
      injector.deleteSkill(SESSION_CONTEXT_SKILL_NAME);
      return;
    }
    injector.writeSkill(
      SESSION_CONTEXT_SKILL_NAME,
      renderSkillMd({
        name: SESSION_CONTEXT_SKILL_NAME,
        description: `Repo-relevant memory matches for ${repoLeaf} (lictor-scoped, this session only)`,
        body: renderMemoryDigest(matches),
      }),
    );
  } catch (err) {
    process.stderr.write(`lictor: skill seed (memory) failed: ${(err as Error).message}\n`);
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

  syncSessionContextSkill(injector, meta.cwd);

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
    ctx.meta.cwd = activeCwd;
    if (ctx.injector) syncSessionContextSkill(ctx.injector, activeCwd);
  }
  if (activeChanged || listChanged) {
    const previous = ctx.activeRepoState.lastActive;
    const canonicalRepos = resolveActiveRepoRoots(activeRepos);
    ctx.activeRepoState.lastActive = activeCwd;
    ctx.activeRepoState.lastList = activeRepos.slice();
    try {
      await ctx.concordia.patchSession(ctx.sessionId, {
        ...(activeChanged ? withRepoOrigin({ repo_path: activeCwd }) : {}),
        active_repos: canonicalRepos,
      });
      await ctx.concordia.event(ctx.sessionId, {
        kind: "lictor.active_repo.changed",
        payload: {
          active: activeCwd,
          previous,
          repos: canonicalRepos,
        },
      });
    } catch {
      // best-effort
    }
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
