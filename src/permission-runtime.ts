/**
 * 許可経路の実体 (PreToolUse 記録 → Notification 起点のカード → 打鍵での回答)。
 *
 * sidecar.ts は HTTP の入口だけを持ち、 判断と状態はここに閉じる。
 *
 * 経路の全体像:
 *   1. PreToolUse hook が全ツール呼び出しを投げてくる。 auto mode では decision を
 *      返さず、 観測をリングバッファに積んで即座に解放する (レイテンシ 0)。
 *   2. Claude が許可待ちで止まると Notification hook が来る。 そこで初めて
 *      直前の観測と突き合わせ、 Concordia へ許可カードを出す。
 *   3. Discord / Web UI の回答は `/v1/internal/permission-response` に返る。
 *      hook を掴んでいないので、 開いている TUI ダイアログへ打鍵で届ける。
 *   4. 1〜3 の全てを監査 JSONL に残す。 「規則に当たらないまま自動で通ったもの」 が
 *      settings.json の漏れ候補として後から数えられる。
 */

import { randomUUID } from "node:crypto";
import { resolveActiveReposDir } from "./active-repos.js";
import { classifyPermissionRequest, type PermissionRequestKind } from "./permission-classify.js";
import type { PermissionDeferObserver } from "./permission-defer.js";
import { writePermissionLog } from "./permission-log.js";
import { PermissionPendingBuffer, type PermissionObservation } from "./permission-pending.js";
import { classifyNotification } from "./permission-notify.js";
import { buildPermissionAnswerSequence, toPermissionAnswer } from "./permission-answer.js";
import { detectEvasion } from "./permission-evasion.js";
import { loadPermissionLayers, matchPermissionRule, type PermissionRuleLayer } from "./permission-rules.js";
import {
  createPermissionAuditWriter,
  summarizeToolInput,
  type PermissionAuditWriter,
  type PermissionOutcome,
} from "./permission-audit.js";

/** sidecar 側の依存を最小限で受け取るための面 (テストから組み立てやすくする)。 */
export interface PermissionHost {
  sessionId: string | null;
  cwd: string;
  concordia: {
    permissionRequest: (
      id: string,
      payload: { request_id: string; tool_name: string; tool_input: unknown },
    ) => Promise<unknown>;
  } | null;
  ptyWriter: ((data: string) => void) | null;
}

export interface PermissionRuntimeOptions {
  pending?: PermissionPendingBuffer;
  audit?: PermissionAuditWriter;
  notifications?: Map<string, PermissionObservation>;
  /** settings 層のローダ。 テストは固定値を差す。 */
  loadLayers?: (cwd: string) => PermissionRuleLayer[];
  /** 現在時刻。通知カードの回答期限をテスト可能にする。 */
  now?: () => number;
}

export interface CheckPayload {
  tool_name: string;
  tool_input?: unknown;
  permission_mode?: unknown;
  guard_result?: unknown;
}

export interface CheckOutcome {
  kind: PermissionRequestKind;
  requestId: string;
  /** true = decision を返さず hook を解放した。 */
  deferred: boolean;
}

export interface NotificationOutcome {
  kind: "permission" | "idle" | "unknown";
  matched: boolean;
  requestId: string | null;
  posted: boolean;
}

export class PermissionRuntime {
  readonly pending: PermissionPendingBuffer;
  readonly notifications: Map<string, PermissionObservation>;
  private readonly audit: PermissionAuditWriter;
  private readonly loadLayers: (cwd: string) => PermissionRuleLayer[];
  private readonly now: () => number;
  private layers: PermissionRuleLayer[] | null = null;

  constructor(private readonly host: PermissionHost, options: PermissionRuntimeOptions = {}) {
    this.pending = options.pending ?? new PermissionPendingBuffer();
    this.notifications = options.notifications ?? new Map();
    this.audit = options.audit ?? createPermissionAuditWriter(resolveActiveReposDir());
    this.loadLayers = options.loadLayers ?? ((cwd) => loadPermissionLayers(cwd));
    this.now = options.now ?? (() => Date.now());
  }

  /** settings 層は 1 セッション中は変わらない前提で 1 度だけ読む。 */
  private ruleLayers(): PermissionRuleLayer[] {
    if (this.layers === null) {
      try {
        this.layers = this.loadLayers(this.host.cwd);
      } catch {
        this.layers = [];
      }
    }
    return this.layers;
  }

  private record(
    observation: PermissionObservation,
    outcome: PermissionOutcome,
    extra: { message?: string; decision?: string } = {},
  ): void {
    const input = (typeof observation.toolInput === "object" && observation.toolInput !== null
      ? observation.toolInput
      : {}) as Record<string, unknown>;
    this.audit.write({
      ts: new Date().toISOString(),
      session_id: this.host.sessionId,
      cwd: this.host.cwd,
      tool: observation.toolName,
      summary: summarizeToolInput(observation.toolName, observation.toolInput),
      permission_mode: observation.permissionMode,
      outcome,
      request_id: observation.requestId,
      rule: matchPermissionRule(this.ruleLayers(), observation.toolName, observation.toolInput),
      evasion: detectEvasion(input.command).map((flag) => flag.code),
      ...extra,
    });
  }

  /**
   * PreToolUse の入口。 auto mode (`record-only`) では観測を積むだけで解放する。
   * それ以外は従来どおり defer / 人間確認へ振り分ける。
   */
  observeCheck(payload: CheckPayload, defer: PermissionDeferObserver): CheckOutcome {
    const requestId = randomUUID();
    const kind = classifyPermissionRequest(payload);
    const observation: PermissionObservation = {
      requestId,
      toolName: payload.tool_name,
      toolInput: payload.tool_input,
      permissionMode: typeof payload.permission_mode === "string" ? payload.permission_mode : null,
      at: Date.now(),
    };

    if (kind === "record-only") {
      this.pending.record(observation);
      // ここではまだ結末が判らない。 人間に聞かれたなら Notification が来て
      // `prompted` で上書き記録される。 来なければこの行が結末になる。
      this.record(observation, "auto-allowed");
      writePermissionLog({
        action: "deferred",
        request_id: requestId,
        kind,
        tool_name: payload.tool_name,
        deferred_ms: 0,
      });
      return { kind, requestId, deferred: true };
    }

    if (kind === "self-processable") {
      defer.observe({ requestId, toolName: payload.tool_name, toolInput: payload.tool_input });
      writePermissionLog({
        action: "deferred",
        request_id: requestId,
        kind,
        tool_name: payload.tool_name,
        deferred_ms: defer.deferMs,
      });
      return { kind, requestId, deferred: true };
    }

    this.record(observation, "hook-gated");
    return { kind, requestId, deferred: false };
  }

  /**
   * Notification の入口。 許可待ちのときだけ Concordia へカードを出す。
   * 突き合わせに失敗しても (観測が期限切れ等) カードは出す — 「止まっている」 事実の
   * ほうが、 コマンド名が載っていることより重要なため。
   */
  async handleNotification(message: unknown): Promise<NotificationOutcome> {
    const classified = classifyNotification(message);
    const text = typeof message === "string" ? message : "";

    if (classified.kind !== "permission") {
      if (classified.kind === "unknown" && text) {
        // 文言変更を沈黙で握りつぶさない。
        this.record(
          {
            requestId: randomUUID(),
            toolName: classified.toolName ?? "unknown",
            toolInput: null,
            permissionMode: null,
            at: Date.now(),
          },
          "notification-unknown",
          { message: text },
        );
      }
      return { kind: classified.kind, matched: false, requestId: null, posted: false };
    }

    const matched = this.pending.take(classified.toolName);
    const observation: PermissionObservation = matched ?? {
      requestId: randomUUID(),
      toolName: classified.toolName ?? "unknown",
      toolInput: null,
      permissionMode: null,
      at: Date.now(),
    };

    if (!this.host.concordia || !this.host.sessionId) {
      this.record(observation, matched ? "prompted" : "notification-unmatched", { message: text });
      return { kind: "permission", matched: matched !== null, requestId: observation.requestId, posted: false };
    }

    // A notification card has no hook-held request that can time out on its
    // own. Keep its lifetime bounded so a late remote response cannot send a
    // key to a dialog the user has already handled (or to the normal TUI).
    const notification = { ...observation, at: this.now() };
    this.notifications.set(notification.requestId, notification);
    try {
      await this.host.concordia.permissionRequest(this.host.sessionId, {
        request_id: notification.requestId,
        tool_name: notification.toolName,
        tool_input: notification.toolInput,
      });
    } catch {
      this.notifications.delete(notification.requestId);
      this.record(observation, "post-failed", { message: text });
      writePermissionLog({
        action: "post-failed",
        request_id: observation.requestId,
        kind: "user-confirmation",
        tool_name: observation.toolName,
        deferred_ms: 0,
        error: "permission notification failed",
      });
      return { kind: "permission", matched: matched !== null, requestId: observation.requestId, posted: false };
    }

    this.record(observation, matched ? "prompted" : "notification-unmatched", { message: text });
    writePermissionLog({
      action: "posted-immediately",
      request_id: observation.requestId,
      kind: "user-confirmation",
      tool_name: observation.toolName,
      deferred_ms: 0,
    });
    return { kind: "permission", matched: matched !== null, requestId: observation.requestId, posted: true };
  }

  /**
   * Notification 起点の要求への回答を TUI へ届ける。
   * 対象が無ければ false (呼び出し側が hook 待ちの経路へ回す)。
   */
  answer(requestId: string, decision: unknown): { handled: boolean; error?: string } {
    const observation = this.notifications.get(requestId);
    if (!observation) return { handled: false };
    if (this.now() - observation.at >= 600_000) {
      this.notifications.delete(requestId);
      return { handled: false };
    }
    const answer = toPermissionAnswer(decision);
    if (!answer) {
      // "ask" = 人間が TUI で決める。 待ち行列からは外すが打鍵はしない。
      this.notifications.delete(requestId);
      return { handled: true };
    }
    if (!this.host.ptyWriter) {
      this.notifications.delete(requestId);
      return { handled: true, error: "pty not available — cannot answer the dialog" };
    }
    this.notifications.delete(requestId);
    this.host.ptyWriter(buildPermissionAnswerSequence(answer));
    this.record(observation, "answered-remote", { decision: answer });
    writePermissionLog({
      action: "posted-after-defer",
      request_id: requestId,
      kind: "user-confirmation",
      tool_name: observation.toolName,
      deferred_ms: 0,
    });
    return { handled: true };
  }

  /** 停止時に待ち行列を捨てる (再開後の誤注入を防ぐ)。 */
  dispose(): void {
    this.notifications.clear();
    this.pending.clear();
  }
}
