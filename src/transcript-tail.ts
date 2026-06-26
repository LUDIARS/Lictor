/**
 * Tail the wrapped agent's session JSONL and relay each line to Concordia
 * as a `transcript-frame`. Lets a remote viewer (Concordia Web UI) see what
 * the wrapped session is doing without parsing the TUI output.
 *
 * Provider 別の discovery / parser:
 *
 *  - Claude Code: `~/.claude/projects/<cwdEncoded>/<uuid>.jsonl`
 *  - OpenAI Codex CLI: `~/.codex/sessions/<YYYY>/<MM>/<DD>/rollout-<ISO>-<uuid>.jsonl`
 *
 * Provider config が `transcriptDir` を `null` で返す場合 (e.g. Gemini) は
 * transcript-tail は no-op で起動する (frame は流れない).
 *
 * Polling vs fs.watch: Windows fs.watch fires inconsistently on append-only
 * files (sometimes only on rename / close), so we use a 500ms poll loop to
 * detect size changes. The poll is cheap because we're only stat()-ing one
 * file. Cheap enough that on cleanup we just clearInterval.
 *
 * Backpressure: POST to Concordia is fire-and-forget. If Concordia is
 * unreachable, the frame is dropped — there is no in-process queue. The
 * Web UI re-reads the JSONL via session detail GETs if it wants history.
 */

import {
  closeSync,
  existsSync,
  openSync,
  readdirSync,
  readFileSync,
  statSync,
  unlinkSync,
  utimesSync,
  writeSync,
  type Stats,
} from "node:fs";
import { join } from "node:path";
import type { ProviderConfig } from "./provider.js";
import { readClaudeSessionId } from "./active-repos.js";
import {
  detectAnsweredQuestionIds,
  detectAskUserQuestion,
  postPendingQuestion,
  postResolveQuestion,
  providerSupportsAskUserQuestion,
} from "./ask-question-relay.js";
import { parseAskMarkerText } from "./ask-marker.js";
import { stripAskBlock } from "./ask-json.js";

const POLL_INTERVAL_MS = 500;
const POST_TIMEOUT_MS = 2000;
const MAX_DISCOVERY_DEPTH = 4; // Codex の YYYY/MM/DD/ をカバーするため再帰段数を確保
const STALE_CLAIM_MS = 60 * 60 * 1000; // 1h 経った claim は wrapper クラッシュ残骸とみなす

// `--session-id <uuid>` で固定した pinned transcript が現れないまま放置しない猶予 (ms)。
//
// 現行 Claude Code は hook が報告する session_id (= Lictor が渡した --session-id) と、
// 実際に書き出す transcript JSONL のファイル名 uuid が一致しないことがある。 その場合
// pinned path (`<session-id>.jsonl`) は永遠に existsSync=false のままで、 pin 固定 discover
// だけだと「地の文がまったく中継されない」 状態に陥る (initial pin も maybeRepin も同じ
// `<sid>.jsonl` を計算するため復旧しない)。 この猶予を過ぎても pinned path が現れなければ
// 従来の mtime discover にフォールバックして中継を成立させる。 claim 機構は両経路で共通
// なので crosstalk 防護は維持される。 0 で即フォールバック。 env override 可。
const PIN_FALLBACK_GRACE_MS = ((): number => {
  const v = Number(process.env.LICTOR_PIN_FALLBACK_GRACE_MS ?? "8000");
  return Number.isFinite(v) && v >= 0 ? v : 8000;
})();

// 別セッション誤投稿 (= 2 wrapper が同じ jsonl を tail) の原因特定用ログ.
// 既定 ON。 安定確認後に撤去 PR で消す (verbose-logging-bootstrap)。CONCORDIA→Discord
// で「別 channel に混在」 が出たらこのログで「同一 path を 2 owner が claim」 を確認する。
const CLAIM_DEBUG = process.env.LICTOR_DEBUG_TRANSCRIPT !== "0";
function claimDbg(msg: string): void {
  if (!CLAIM_DEBUG) return;
  try { process.stderr.write(`[verbose-transcript] ${msg}\n`); } catch { /* best-effort */ }
}

/** claim file の mtime を now に更新し stale 化を防ぐ (active 中は剥がされない). best-effort. */
export function refreshClaim(claimPath: string): void {
  try {
    const t = Date.now() / 1000;
    utimesSync(claimPath, t, t);
  } catch { /* best-effort — 削除済等 */ }
}

export interface TranscriptTailHandle {
  stop: () => void;
  /**
   * Session JSONL を discover 済の場合に session UUID を返す.
   * provider.extractSessionId に従って filename から抽出.
   * 未発見なら null. active-repos watcher 等、 SID 単位で書き出される
   * 補助ファイルを引きたいモジュールが参照する.
   */
  getSessionUuid: () => string | null;
  /** Backward-compat alias for getSessionUuid (sidecar context が古い名前で参照する). */
  getClaudeSessionId: () => string | null;
  /** discover + claim 済の transcript JSONL の絶対パス. 未発見なら null. */
  getTranscriptPath: () => string | null;
  /**
   * 直近 `limit` 行を読み出して返す pull API (`GET /v1/transcript` の実体).
   * transcript-tail は通常 Concordia へ frame を push するだけなので、 ローカルから
   * 「今このセッションは何をしているか」 を引きたい呼び出し元 (delegation 監視等) の
   * ための読み出し口. raw=false なら lineToFrame 済の slim frame、 raw=true なら
   * パース済の生 JSONL オブジェクトを返す.
   */
  readRecent: (limit: number, opts?: { raw?: boolean }) => TranscriptReadResult;
}

/** `readRecent` / `readRecentFromFile` の戻り値. */
export interface TranscriptReadResult {
  /** 読み出した JSONL の絶対パス. transcript 未発見なら null. */
  path: string | null;
  /** transcript が discover 済で読めたか. */
  available: boolean;
  /** ファイル中の非空行の総数 (tail 前の母数). */
  total_lines: number;
  /** 実際に返した要素数 (frames or lines の length). */
  returned: number;
  /** raw=false のとき: lineToFrame 済の slim frame 配列 (古い順). */
  frames?: Frame[];
  /** raw=true のとき: パース済の生 JSONL オブジェクト配列 (古い順). */
  lines?: unknown[];
}

export interface TranscriptTailOptions {
  cwd: string;
  sessionId: string;
  concordiaBaseUrl: string;
  provider: ProviderConfig;
  /**
   * Called with the AskUserQuestion `tool_use` id when a picker is detected
   * opening in the transcript. wrap.ts wires this to {@link PendingQuestionGate}
   * so ordinary pty injects are held while the picker waits for an answer.
   * Optional — omitted by harnesses that don't gate injects.
   */
  onQuestionOpen?: (id: string) => void;
  /**
   * Called with a `tool_result.tool_use_id` when one is observed. The gate
   * resolves only ids it has open, so passing every tool_result id is safe.
   */
  onQuestionResolved?: (id: string) => void;
  /**
   * ask マーカー検出を有効にするか (= ステアリング注入済の provider セッション)。
   * 有効なら assistant テキスト中の ```ask ブロックを pending-question に流す。
   */
  askMarkerEnabled?: boolean;
  /**
   * ask マーカー由来の pending-question が Concordia に登録され question_id が
   * 返ったとき呼ぶ。wrap.ts はこの id を「テキスト回答で返す」集合に記録する。
   */
  onAskMarkerPosted?: (questionId: number) => void;
  /**
   * transcript に user メッセージ (端末でのローカル返信) が現れたとき呼ぶ。
   * 開いている ask マーカー質問をローカル解決扱いにして Discord ボタンを失効させる。
   * askMarkerEnabled のときのみ発火する (ask マーカー専用)。
   */
  onUserReply?: () => void;
  /**
   * transcript に user ロールのメッセージフレームが現れるたびに呼ぶ汎用シグナル
   * (askMarkerEnabled に依らず常時発火)。 submit-watchdog が「注入テキストが実際に
   * submit されて LLM ターンが始まったか」 を判定するのに使う。
   */
  onUserMessage?: () => void;
  /**
   * 「現在の Claude session id」 追跡ファイルの絶対パス
   * (`<stateDir>/claude-session-<lictorId>.txt`、 SessionStart hook が書く)。
   *
   * 指定があり provider が session-pin 対応のとき、 poll ごとにこのファイルを読み、
   * 記録された claude session id が現在 pin 中の JSONL と変わっていたら
   * (= `/clear` 等でローテートした) 新しい `<sid>.jsonl` へ再 pin して中継を継続する。
   * null/未指定なら再 pin しない (従来動作)。
   */
  lictorSessionStatePath?: string | null;
  /**
   * spawn 時に `--session-id <uuid>` で固定した transcript JSONL の絶対パス。
   *
   * 指定があると mtime ベースの discover を **完全にバイパス** し、 このパスが
   * 生成され次第そのファイルだけを claim/tail する。 uuid は wrapper が発番した
   * 一意値なので、 同 cwd で別 wrapper が並走していても・先に非 Lictor の同
   * provider を起動していても・context 要約で別 session に jsonl がローテート
   * しても、 自分以外の transcript を誤って掴む (= 投稿が 1 つズレて別チャンネル
   * に出る crosstalk) ことが構造的に起きない。
   *
   * null/未指定なら従来どおり mtime discover にフォールバックする
   * (session-id 固定非対応 provider、 または resume 系 flag 指定時)。
   */
  pinnedTranscriptPath?: string | null;
  /**
   * pinned transcript path が現れないまま中継が始まらないのを防ぐため、 mtime discover
   * にフォールバックするまでの猶予 (ms)。 省略時は env `LICTOR_PIN_FALLBACK_GRACE_MS`
   * (既定 8000)。 テストから即時フォールバックを検証するときは 0 を渡す。
   */
  pinFallbackGraceMs?: number;
}

export function startTranscriptTail(opts: TranscriptTailOptions): TranscriptTailHandle {
  const dir = opts.provider.transcriptDir(opts.cwd);
  let jsonlPath: string | null = null;
  // pin 中の JSONL パス. `/clear` 等で claude session がローテートしたら maybeRepin が
  // 差し替える (起動時は opts 由来の固定値、 非 pin provider では null)。
  let pinnedPath: string | null = opts.pinnedTranscriptPath ?? null;
  let claimPath: string | null = null;
  let offset = 0;
  let seq = 0;
  let pending = "";
  let stopped = false;
  // pinned path が猶予内に現れず mtime discover にフォールバックしたか。 一度立つと
  // 以降は pin 固定 discover / sid ベース再 pin を行わない (どちらも現行 Claude Code では
  // 正しいファイルに辿り着けないため)。
  let pinFellBack = false;
  // pinned path が現れないまま中継不能に陥らないための猶予 (ms)。
  const pinFallbackGraceMs = opts.pinFallbackGraceMs ?? PIN_FALLBACK_GRACE_MS;
  const startedAt = Date.now();
  // AskUserQuestion の tool_use id → Concordia の question_id。picker がローカル回答で
  // 解決した（tool_result 検知）とき、Concordia に resolve 通知して古いボタンを失効させる。
  const questionIdByToolUse = new Map<string, number>();
  // AskUserQuestion tool は Claude Code 専用. Codex / Gemini provider のときは
  // 検知を回避して JSON.parse の二度手間を避ける (= lineToFrame だけ走らせる).
  const askUserQuestionEnabled = providerSupportsAskUserQuestion(opts.provider);

  // provider.transcriptDir が null を返す provider (Gemini 等) は no-op handle.
  if (!dir) {
    return {
      stop: () => {
        stopped = true;
      },
      getSessionUuid: () => null,
      getClaudeSessionId: () => null,
      getTranscriptPath: () => null,
      readRecent: (limit, opts) => readRecentFromFile(null, limit, opts?.raw ?? false),
    };
  }

  // 同 cwd で複数 lictor wrapper が並走するとき、 mtime 最新だけで pick すると
  // 全 wrapper が同じ jsonl を読んで「他セッションの transcript を自分の session_id
  // で Concordia に送る」 race を起こす. 結果として AI 応答が別 channel に混在する.
  //
  // 各 jsonl に sidecar の `<path>.lictor-claim` を atomic create (`wx`) で配置し、
  // 取れた wrapper だけがその jsonl を tail する. 取れなかった候補は次点を試す.
  // 自分の jsonl がまだ作成されていない場合は null で抜けて、 次回 poll で再 discover.
  const discover = (): string | null => {
    // session-id 固定束縛が効いている場合は mtime 推測を一切せず、 固定 path のみ。
    // wrapper が発番した一意 uuid のファイルなので claim 競合は構造的に起きないが、
    // stale-claim 剥がし等の共通ロジックを通すため tryClaimJsonl は経由する。
    if (pinnedPath && !pinFellBack) {
      if (existsSync(pinnedPath)) {
        const cp = tryClaimJsonl(pinnedPath, STALE_CLAIM_MS, opts.sessionId);
        if (cp) {
          claimPath = cp;
          claimDbg(`pinned transcript claimed path=${pinnedPath} owner=${opts.sessionId}`);
          return pinnedPath;
        }
        return null; // 一意 uuid のため通常起き得ない; 万一 claim 済なら次 poll で再試行
      }
      // pinned path がまだ現れない。 猶予内は待つが、 猶予を超えても現れなければ
      // (session_id ≠ transcript filename の Claude Code では永遠に現れない) 従来の
      // mtime discover にフォールバックして中継不能を回避する。
      if (Date.now() - startedAt < pinFallbackGraceMs) return null;
      pinFellBack = true;
      claimDbg(
        `pinned path absent after ${pinFallbackGraceMs}ms grace; ` +
          `falling back to mtime discover (pinned=${pinnedPath})`,
      );
      // ↓ mtime discover へ流れる (return せず下へ落とす)
    }
    if (!existsSync(dir)) return null;
    type Candidate = { path: string; mtime: number };
    const candidates: Candidate[] = [];
    walkJsonl(dir, MAX_DISCOVERY_DEPTH, (p, st) => {
      const mtimeMs = st.mtimeMs;
      // Only consider files touched after lictor started (avoids resuming
      // old sessions that happen to live in the same project dir).
      //
      // 旧実装は `Date.now() - mtimeMs > 30s` で「最近 30 秒以内に touch された
      // ものに限る」 上限フィルタも持っていたが、 wrapped CLI がユーザ操作待ちで
      // 何分も idle した後に初発話するケース (claude のセッション開始直後 +
      // 数分黙考、 等) でも jsonl が生成された瞬間に拾えるよう撤廃した.
      // 下限 (startedAt - 5s) だけで「過去のセッションの jsonl を誤って継承
      // しない」 という本来の目的は満たせる。
      if (mtimeMs < startedAt - 5_000) return;
      candidates.push({ path: p, mtime: mtimeMs });
    });
    candidates.sort((a, b) => b.mtime - a.mtime);
    for (const c of candidates) {
      const cp = tryClaimJsonl(c.path, STALE_CLAIM_MS, opts.sessionId);
      if (cp) {
        claimPath = cp;
        return c.path;
      }
    }
    return null;
  };

  // `/clear` 等で claude session が別 uuid の JSONL にローテートしたら、 SessionStart
  // hook が書く state ファイルを読んで新しい pin 先へ差し替える。 これをしないと固定
  // ファイルを掴んだまま中継が止まる (session-pin provider = claude のみ意味を持つ)。
  const maybeRepin = (): void => {
    // mtime discover にフォールバック済なら sid ベースの再 pin は無効化する。
    // session_id ≠ transcript filename の環境では sid から正しいファイルを引けず、
    // 再 pin すると掴んでいる実ファイルを手放してしまうため。
    if (pinFellBack) return;
    if (!opts.lictorSessionStatePath) return;
    if (!opts.provider.supportsSessionPin || !opts.provider.pinnedTranscriptFile) return;
    const sid = readClaudeSessionId(opts.lictorSessionStatePath);
    if (!sid) return; // SessionStart hook 未発火
    const want = opts.provider.pinnedTranscriptFile(opts.cwd, sid);
    if (!want || want === pinnedPath) return; // 解決不能 or ローテートなし
    claimDbg(`re-pin: claude session rotated ${pinnedPath ?? "?"} -> ${want} (sid=${sid})`);
    // 旧 JSONL の claim を解放し (もう成長しない死ファイル)、 新ファイルを次の discover で掴む。
    if (claimPath) {
      try {
        unlinkSync(claimPath);
      } catch {
        /* best-effort */
      }
      claimPath = null;
    }
    pinnedPath = want;
    jsonlPath = null;
    offset = 0;
    pending = "";
    // seq は連続維持 (Concordia 側の frame 順序を壊さない)。
  };

  const pollOnce = async (): Promise<void> => {
    if (stopped) return;
    maybeRepin();
    if (!jsonlPath) {
      jsonlPath = discover();
      if (!jsonlPath) return;
      offset = 0;
    }
    // active 中は claim の mtime を更新し続け、 stale (1h) 判定で他 wrapper に
    // 剥がされて「同じ jsonl を 2 wrapper が tail → 別 channel 誤投稿」 になるのを防ぐ。
    if (claimPath) refreshClaim(claimPath);
    let size: number;
    try {
      size = statSync(jsonlPath).size;
    } catch {
      return; // file went away
    }
    if (size <= offset) return;
    let chunk: Buffer;
    try {
      const fd = readFileSync(jsonlPath); // small per-poll; OK in v1
      chunk = fd.subarray(offset, size) as Buffer;
    } catch {
      return;
    }
    offset = size;
    pending += chunk.toString("utf8");
    const lines = pending.split("\n");
    pending = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.trim()) continue;
      // AskUserQuestion tool_use を見つけたら、 transcript.frame の正規ルートとは別に
      // Concordia の pending-question API に直接通知する. これで Discord 側 (bot.routeEvent)
      // の question.posted listener が embed + button を session channel に出せるようになる.
      // questions[] が複数ある場合は **全部** 一気に流す (一括投稿).
      if (askUserQuestionEnabled) {
        const pqs = detectAskUserQuestion(line);
        for (const pq of pqs) {
          // question_id を控えて tool_use id と紐付ける（後で local-resolve 通知に使う）。
          void postPendingQuestion(opts.concordiaBaseUrl, opts.sessionId, pq).then((qid) => {
            if (qid != null && pq.id) questionIdByToolUse.set(pq.id, qid);
          });
          opts.onQuestionOpen?.(pq.id);
        }
        // A picker resolving (locally OR remotely) writes a tool_result whose
        // tool_use_id matches the question — that is what releases the gate.
        for (const id of detectAnsweredQuestionIds(line)) {
          opts.onQuestionResolved?.(id);
          const qid = questionIdByToolUse.get(id);
          if (qid != null) {
            questionIdByToolUse.delete(id);
            void postResolveQuestion(opts.concordiaBaseUrl, opts.sessionId, qid);
          }
        }
      }
      const frame = lineToFrame(line);
      if (!frame) continue;
      // user ロールのメッセージが出た = 端末入力 or 注入テキストが submit されて
      // LLM ターンが始まった汎用シグナル。 submit-watchdog の武装解除に使う
      // (askMarkerEnabled に依らず常時発火)。
      if (frame.kind === "text" && (frame.payload as { role?: unknown }).role === "user") {
        opts.onUserMessage?.();
      }
      // ask マーカー: assistant テキスト中の ```ask ブロックを pending-question へ。
      // provider 非依存 — lineToFrame が Claude/Codex の assistant テキストを正規化済。
      //
      // 「説明テキストを先に / 質問カード (raw JSON) を最後に分割送信」 する:
      //   1. ask ブロックを除いた説明テキストを text frame として **先に await 送信**
      //   2. そのあとで pending-question (質問カード) を送る
      // これで Discord 側の「カードが説明より先に出る」順序逆転と、説明メッセージへの
      // raw JSON 二重表示を解消する。元フレーム (raw JSON 入り) は再送しない。
      // user テキストはローカル返信とみなし、開いている marker 質問を resolve させる。
      if (opts.askMarkerEnabled && frame.kind === "text") {
        const p = frame.payload as { role?: unknown; text?: unknown };
        if (p.role === "assistant" && typeof p.text === "string") {
          const marker = parseAskMarkerText(p.text);
          if (marker) {
            // 1. 説明テキスト (ask ブロック除去済) を先に送る。中身が空なら省略。
            const stripped = stripAskBlock(p.text);
            if (stripped) {
              await postFrame(opts.concordiaBaseUrl, opts.sessionId, seq++, "text", {
                ...(frame.payload as object),
                text: stripped,
              });
            }
            // 2. 質問カードを最後に送る (説明の後に届くよう await 後に投稿)。
            const qid = await postPendingQuestion(opts.concordiaBaseUrl, opts.sessionId, {
              id: "",
              question: marker.question,
              options: marker.options,
              multiSelect: marker.multiSelect,
            });
            if (qid != null) opts.onAskMarkerPosted?.(qid);
            continue; // raw JSON を含む元フレームは送らない (分割済み)
          }
        } else if (p.role === "user" && typeof p.text === "string") {
          opts.onUserReply?.();
        }
      }
      const seqNum = seq++;
      void postFrame(opts.concordiaBaseUrl, opts.sessionId, seqNum, frame.kind, frame.payload);
    }
  };

  const timer = setInterval(() => {
    void pollOnce().catch(() => {});
  }, POLL_INTERVAL_MS);
  timer.unref?.();

  const getSessionUuid = (): string | null => {
    if (!jsonlPath) return null;
    const slash = jsonlPath.lastIndexOf("/");
    const back = jsonlPath.lastIndexOf("\\");
    let base = jsonlPath.slice(Math.max(slash, back) + 1);
    if (base.endsWith(".jsonl")) base = base.slice(0, -".jsonl".length);
    return opts.provider.extractSessionId(base);
  };

  return {
    stop: () => {
      stopped = true;
      clearInterval(timer);
      if (claimPath) {
        try { unlinkSync(claimPath); } catch { /* best-effort */ }
        claimPath = null;
      }
    },
    getSessionUuid,
    getClaudeSessionId: getSessionUuid,
    getTranscriptPath: () => jsonlPath,
    readRecent: (limit, opts) => readRecentFromFile(jsonlPath, limit, opts?.raw ?? false),
  };
}

/**
 * 指定 JSONL の末尾 `limit` 行を読んで `TranscriptReadResult` を組み立てる純関数.
 * push 専用だった transcript-tail に「ローカルから直近を引く」 読み出し口を与える.
 *
 * - `jsonlPath` が null (transcript 未 discover) なら available:false で即返す.
 * - 非空行だけを母数にし、 末尾 `limit` 行を古い順で返す.
 * - raw=false: 各行を `lineToFrame` で slim frame 化 (parse 不能行は捨てる).
 * - raw=true : 各行を `JSON.parse` した生オブジェクト (parse 不能行は捨てる).
 *
 * 副作用は readFileSync 1 回のみ。 sidecar の `GET /v1/transcript` から呼ばれる.
 */
export function readRecentFromFile(
  jsonlPath: string | null,
  limit: number,
  raw: boolean,
): TranscriptReadResult {
  if (!jsonlPath) {
    return { path: null, available: false, total_lines: 0, returned: 0 };
  }
  let content: string;
  try {
    content = readFileSync(jsonlPath, "utf8");
  } catch {
    // claim 済だが読めない (削除/権限) — available:false で path だけ返す.
    return { path: jsonlPath, available: false, total_lines: 0, returned: 0 };
  }
  const allLines = content.split("\n").filter((l) => l.trim().length > 0);
  const want = Number.isFinite(limit) ? Math.max(0, Math.floor(limit)) : 0;
  const take = Math.min(want, allLines.length);
  const slice = take > 0 ? allLines.slice(allLines.length - take) : [];

  if (raw) {
    const lines: unknown[] = [];
    for (const l of slice) {
      try { lines.push(JSON.parse(l)); } catch { /* skip malformed */ }
    }
    return { path: jsonlPath, available: true, total_lines: allLines.length, returned: lines.length, lines };
  }
  const frames: Frame[] = [];
  for (const l of slice) {
    const f = lineToFrame(l);
    if (f) frames.push(f);
  }
  return { path: jsonlPath, available: true, total_lines: allLines.length, returned: frames.length, frames };
}

/**
 * 1 つの jsonl について `<path>.lictor-claim` を atomic create で取りに行く.
 * 取れたら claim path を返す. 既に他 wrapper が claim 済 or race で取れなかった
 * 場合は null. 1h 以上経った stale claim は wrapper crash 残骸とみなして剥がす.
 *
 * 純関数なので unit test で複数 wrapper の race を simulation できる.
 */
export function tryClaimJsonl(
  jsonlPath: string,
  staleMs: number = STALE_CLAIM_MS,
  ownerId = "",
): string | null {
  const cp = `${jsonlPath}.lictor-claim`;
  try {
    const cst = statSync(cp);
    if (Date.now() - cst.mtimeMs > staleMs) {
      // stale claim を剥がす前に旧所有者を控えてログる (誤投稿が再発した際の追跡用)。
      let staleOwner = "";
      try { staleOwner = readFileSync(cp, "utf8").trim(); } catch { /* best-effort */ }
      try { unlinkSync(cp); } catch { /* race; 別 wrapper が同時に剥がした */ }
      claimDbg(`stale claim removed path=${jsonlPath} staleOwner=${staleOwner || "?"} ageMs=${Math.round(Date.now() - cst.mtimeMs)} by=${ownerId || "?"}`);
    } else {
      return null; // active claim, owned by someone else
    }
  } catch {
    // no claim file
  }
  try {
    const fd = openSync(cp, "wx");
    try { writeSync(fd, ownerId); } catch { /* owner 記録は best-effort */ }
    closeSync(fd);
    claimDbg(`claim acquired path=${jsonlPath} owner=${ownerId || "?"}`);
    return cp;
  } catch {
    return null;
  }
}

/**
 * 再帰的に .jsonl を探す helper. depth で打ち止め (無限再帰防止).
 * mtime コールバックでフィルタ + 候補ピック.
 */
function walkJsonl(
  root: string,
  depth: number,
  visit: (path: string, st: Stats) => void,
): void {
  let entries: import("node:fs").Dirent[];
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = join(root, entry.name);
    if (entry.isDirectory()) {
      if (depth > 0) walkJsonl(full, depth - 1, visit);
      continue;
    }
    if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue;
    try {
      const st: Stats = statSync(full);
      visit(full, st);
    } catch {
      // file vanished between readdir + stat — ignore
    }
  }
}

interface Frame { kind: string; payload: unknown }

/**
 * Convert one JSONL line into the slim envelope Concordia broadcasts.
 *
 * Claude Code 形式と OpenAI Codex CLI 形式を両方サポート:
 *  - Claude : `{type:"user"|"assistant", message:{role,content:[...]}, uuid}`
 *           : `{type:"summary"|"system"|...}`
 *  - Codex  : `{timestamp, type:"response_item", payload:{type:"message", role, content:[{type:"input_text"|"output_text", text}]}}`
 *           : `{timestamp, type:"event_msg", payload:{type:"user_message"|"agent_message", message}}`
 *           : `{timestamp, type:"session_meta"|"turn_context", payload:{...}}`
 *
 * 未知の type は最後に `raw` frame として落とす.
 */
export function lineToFrame(line: string): Frame | null {
  let msg: any;
  try {
    msg = JSON.parse(line);
  } catch {
    return null;
  }
  if (!msg || typeof msg !== "object") return null;

  // ─── Lictor ローカル LLM エージェント形式 ──────────────────────────────
  // local-agent (`lictor cli local-agent`) の独自 JSONL は {ts, role, content}
  // で `type` を持たない。 role+content の string ペアで判定し text/system frame 化する。
  // (compaction 等 role を持たない行は下の type 分岐へ素通りし最終的に raw になる)
  if (
    msg.type === undefined &&
    typeof msg.role === "string" &&
    typeof msg.content === "string"
  ) {
    if (msg.role === "assistant" || msg.role === "user") {
      return { kind: "text", payload: { role: msg.role, text: msg.content.slice(0, 4000) } };
    }
    return { kind: "system", payload: { text: msg.content.slice(0, 4000) } };
  }

  const type = typeof msg.type === "string" ? msg.type : "unknown";

  // Claude per-message uuid — used by PR-F as a fork anchor.
  const claudeUuid = typeof msg.uuid === "string" ? msg.uuid : null;

  // ─── Claude Code 形式 ────────────────────────────────────────────────
  if (type === "user" || type === "assistant") {
    const content = msg.message?.content;
    if (Array.isArray(content)) {
      for (const part of content) {
        if (part?.type === "text" && typeof part.text === "string") {
          return { kind: "text", payload: { role: type, text: part.text, claude_uuid: claudeUuid } };
        }
        if (part?.type === "tool_use") {
          return {
            kind: "tool-use",
            payload: { role: type, name: part.name, input_preview: previewJson(part.input) },
          };
        }
        if (part?.type === "tool_result") {
          if (Array.isArray(part.content)) {
            for (const c of part.content) {
              if (
                c?.type === "image" &&
                c?.source?.type === "base64" &&
                typeof c?.source?.data === "string" &&
                c.source.data.length > 0
              ) {
                return {
                  kind: "image",
                  payload: { media_type: c.source.media_type ?? "image/png", data: c.source.data },
                };
              }
            }
          }
          return {
            kind: "tool-result",
            payload: {
              tool_use_id: part.tool_use_id,
              is_error: part.is_error === true,
              preview: previewJson(part.content),
            },
          };
        }
        if (part?.type === "thinking" && typeof part.thinking === "string") {
          return { kind: "thinking", payload: { role: type, preview: part.thinking.slice(0, 400) } };
        }
      }
    } else if (typeof content === "string") {
      return { kind: "text", payload: { role: type, text: content } };
    }
    return null;
  }

  if (type === "summary") {
    return { kind: "summary", payload: { text: String(msg.summary ?? "").slice(0, 400) } };
  }

  if (type === "system") {
    return { kind: "system", payload: { text: String(msg.text ?? msg.content ?? "").slice(0, 400) } };
  }

  // ─── Codex CLI 形式 ─────────────────────────────────────────────────
  // event_msg.user_message / agent_message は agent 内部処理を経た「ユーザ
  // 視点のメッセージ」 なので、 これを優先的に text frame 化する.
  if (type === "event_msg" && msg.payload && typeof msg.payload === "object") {
    const p: any = msg.payload;
    const pType = typeof p.type === "string" ? p.type : "";
    if (pType === "user_message" && typeof p.message === "string") {
      return { kind: "text", payload: { role: "user", text: p.message.slice(0, 4000) } };
    }
    if (pType === "agent_message" && typeof p.message === "string") {
      return { kind: "text", payload: { role: "assistant", text: p.message.slice(0, 4000) } };
    }
    // task_started, tool_call, etc. は raw 扱い (将来必要なら拡張).
  }

  // response_item は SDK レベルの 生 message. event_msg と二重に流すと
  // Web UI で重複するが、 system/developer メッセージ等は event_msg に乗らない
  // ので、 重複は許容して両方流す方が情報量が多い.
  if (type === "response_item" && msg.payload && typeof msg.payload === "object") {
    const p: any = msg.payload;
    const pType = typeof p.type === "string" ? p.type : "";
    if (pType === "message") {
      const role = normalizeCodexRole(p.role);
      if (role) {
        const text = extractCodexMessageText(p.content);
        if (text) return { kind: "text", payload: { role, text: text.slice(0, 4000) } };
      }
    }
    if (pType === "reasoning") {
      // reasoning は encrypted_content しか持たない場合がある.
      // summary 配列に preview があれば優先、 無ければ「reasoning」 のみ.
      const summary = Array.isArray(p.summary) ? p.summary : [];
      const previewParts: string[] = [];
      for (const s of summary) {
        if (typeof s === "string") previewParts.push(s);
        else if (typeof s?.text === "string") previewParts.push(s.text);
      }
      const preview = previewParts.join(" ").slice(0, 400);
      return { kind: "thinking", payload: { role: "assistant", preview: preview || "(encrypted)" } };
    }
  }

  return { kind: "raw", payload: { type, keys: Object.keys(msg).slice(0, 8) } };
}

/**
 * Codex の `payload.role` を Concordia の text frame role に正規化.
 * `developer` / `system` は assistant 扱いから外して raw に落とすため null を返す.
 */
function normalizeCodexRole(role: unknown): "user" | "assistant" | null {
  if (typeof role !== "string") return null;
  const r = role.toLowerCase();
  if (r === "user") return "user";
  if (r === "assistant") return "assistant";
  return null;
}

/**
 * Codex message の content 配列から表示用テキストを抽出.
 *
 *  - `[{type:"input_text",  text}]` — user message
 *  - `[{type:"output_text", text}]` — assistant message
 *  - `[{type:"text",        text}]` — provider 共通保険
 *  - `["..."]` — 文字列直挿し (まずあり得ないが念のため)
 */
function extractCodexMessageText(content: unknown): string | null {
  if (typeof content === "string" && content.trim()) return content;
  if (!Array.isArray(content)) return null;
  const out: string[] = [];
  for (const part of content) {
    if (typeof part === "string" && part.trim()) {
      out.push(part);
      continue;
    }
    if (part && typeof part === "object") {
      const t = (part as any).type;
      const text = (part as any).text;
      if (typeof text !== "string" || !text.trim()) continue;
      if (t === "input_text" || t === "output_text" || t === "text") out.push(text);
    }
  }
  return out.length > 0 ? out.join("\n") : null;
}

function previewJson(v: unknown): string {
  if (v == null) return "";
  if (typeof v === "string") return v.slice(0, 200);
  try {
    return JSON.stringify(v).slice(0, 200);
  } catch {
    return "[unserializable]";
  }
}

async function postFrame(
  baseUrl: string,
  sessionId: string,
  seq: number,
  kind: string,
  payload: unknown,
): Promise<void> {
  const url = `${baseUrl}/v1/sessions/${encodeURIComponent(sessionId)}/transcript-frame`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), POST_TIMEOUT_MS);
  try {
    await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ seq, kind, payload }),
      signal: ctrl.signal,
    });
  } catch {
    // best-effort
  } finally {
    clearTimeout(timer);
  }
}
