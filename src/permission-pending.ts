/**
 * PreToolUse で観測したツール呼び出しの短期保持。
 *
 * Notification hook (`Claude needs your permission to use Bash`) は
 * **どのコマンドか** を持っていない。 許可カードに実コマンドを載せるには、
 * 直前の PreToolUse 観測と突き合わせる必要がある。
 *
 * PreToolUse hook はツール実行をブロックするため、 ここでの記録は同期・O(1)・
 * 失敗しない実装に保つ (ネットワークもファイル I/O も挟まない)。
 */

export interface PermissionObservation {
  requestId: string;
  toolName: string;
  toolInput: unknown;
  permissionMode: string | null;
  /** 単調増加のタイムスタンプ (ms)。 テストは論理時計を渡す。 */
  at: number;
}

export interface PendingBufferOptions {
  /** 保持する最大件数。 古いものから捨てる。 */
  maxEntries?: number;
  /** 突き合わせを許す最大経過時間 (ms)。 */
  ttlMs?: number;
  /** 現在時刻。 テストは論理時計を差す。 */
  now?: () => number;
}

const DEFAULT_MAX_ENTRIES = 32;
const DEFAULT_TTL_MS = 120_000;

/**
 * 直近のツール呼び出しリングバッファ。
 *
 * 突き合わせは「新しい順に走査して、 ツール名が一致する最初の未消費観測」。
 * ツール名が読めない Notification では単に最新の未消費観測を返す。
 */
export class PermissionPendingBuffer {
  private readonly entries: PermissionObservation[] = [];
  private readonly maxEntries: number;
  private readonly ttlMs: number;
  private readonly now: () => number;

  constructor(options: PendingBufferOptions = {}) {
    this.maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
    this.ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
    this.now = options.now ?? (() => Date.now());
  }

  get size(): number {
    return this.entries.length;
  }

  record(observation: Omit<PermissionObservation, "at"> & { at?: number }): PermissionObservation {
    const entry: PermissionObservation = { ...observation, at: observation.at ?? this.now() };
    this.entries.push(entry);
    while (this.entries.length > this.maxEntries) this.entries.shift();
    return entry;
  }

  /**
   * Notification と突き合わせて観測を 1 件取り出す (取り出したものは消える)。
   * TTL 切れの観測は突き合わせ対象にせず、 その場で捨てる。
   */
  take(toolName: string | null): PermissionObservation | null {
    const cutoff = this.now() - this.ttlMs;
    for (let i = this.entries.length - 1; i >= 0; i -= 1) {
      const entry = this.entries[i];
      if (entry.at < cutoff) {
        // これより前は全て期限切れ。 まとめて捨てる。
        this.entries.splice(0, i + 1);
        return null;
      }
      if (toolName === null || entry.toolName === toolName) {
        this.entries.splice(i, 1);
        return entry;
      }
    }
    return null;
  }

  clear(): void {
    this.entries.length = 0;
  }
}
