/**
 * 会話ログのサイズ管理 + 閾値超過時のコンパクション。spec/local-llm-agent.md §2。
 *
 * 依存を増やさない (prebuilt-only 規約) ため、トークン量は文字ベースの
 * ヒューリスティックで推定する (正確なトークナイザは入れない)。
 * 要約は**ローカル LLM だけ**で生成する (クラウド非依存)。
 */

import type { ChatMessage } from "./ollama.js";

/**
 * 文字列のトークン量を粗く推定。CJK は 1 文字 ≒ 1 token、それ以外 (英数記号・
 * 空白) は ≒ 0.3 token として数える (英語 4 char ≒ 1 token の慣習に近い、
 * かつ単調増加)。
 */
export function estimateTextTokens(text: string): number {
  let t = 0;
  for (const ch of text) {
    const cp = ch.codePointAt(0) ?? 0;
    // CJK 統合漢字 / かな / 全角記号帯はおおむね 0x3000 以上。
    t += cp >= 0x3000 ? 1 : 0.3;
  }
  return Math.ceil(t);
}

/** messages 全体の推定トークン量 (1 メッセージあたり 4 token のオーバーヘッド込み)。 */
export function estimateTokens(messages: ChatMessage[]): number {
  let t = 0;
  for (const m of messages) t += 4 + estimateTextTokens(m.content);
  return t;
}

export interface CompactionConfig {
  contextTokens: number;
  compactRatio: number;
  keepRecent: number;
}

/** 閾値 (contextTokens * compactRatio) を超えているか。 */
export function shouldCompact(messages: ChatMessage[], cfg: CompactionConfig): boolean {
  return estimateTokens(messages) > cfg.contextTokens * cfg.compactRatio;
}

export interface CompactionResult {
  messages: ChatMessage[];
  /** 生成された要約 (no-op 時は空)。 */
  summary: string;
  /** 要約に畳み込んだ (= live から外した) メッセージ件数。 */
  dropped: number;
}

/** 要約器: 畳む対象メッセージ群を受け取り、要約テキストを返す (ローカル LLM 呼び出し)。 */
export type Summarizer = (toSummarize: ChatMessage[]) => Promise<string>;

/**
 * コンパクション本体。
 *
 * - 先頭の system (= persona/head) は保持。
 * - body のうち末尾 `keepRecent` 件を残し、それより古い塊を `summarize` で 1 件の
 *   要約 system に畳む。古い要約 system があっても塊に含めて再要約される。
 * - 畳む対象が `keepRecent` 以下なら no-op。
 * - `summarize` が throw / 空を返したら **切り詰めフォールバック** (要約なしで古い
 *   塊を捨て、その旨の system を 1 件残す) — セッションは止めない。
 */
export async function compact(
  messages: ChatMessage[],
  cfg: CompactionConfig,
  summarize: Summarizer,
): Promise<CompactionResult> {
  const head: ChatMessage[] = messages.length > 0 && messages[0].role === "system" ? [messages[0]] : [];
  const body = messages.slice(head.length);
  if (body.length <= cfg.keepRecent) {
    return { messages, summary: "", dropped: 0 };
  }
  const toSummarize = body.slice(0, body.length - cfg.keepRecent);
  const recent = body.slice(body.length - cfg.keepRecent);

  let summary = "";
  try {
    summary = (await summarize(toSummarize)).trim();
  } catch {
    summary = "";
  }
  const summaryMsg: ChatMessage = summary
    ? { role: "system", content: `これまでの会話の要約:\n${summary}` }
    : { role: "system", content: "(古い会話は文脈長のため省略されました)" };

  return {
    messages: [...head, summaryMsg, ...recent],
    summary,
    dropped: toSummarize.length,
  };
}

/** 畳む対象メッセージ群を要約プロンプトに整形する (Summarizer 実装の補助)。 */
export function buildSummaryMessages(toSummarize: ChatMessage[]): ChatMessage[] {
  const log = toSummarize
    .map((m) => `${m.role === "user" ? "ユーザ" : m.role === "assistant" ? "アシスタント" : "システム"}: ${m.content}`)
    .join("\n");
  return [
    {
      role: "system",
      content:
        "次の会話ログを、後で文脈として参照できるよう日本語で簡潔に要約してください。" +
        "要点・決定事項・ユーザの意図・未解決事項を箇条書きで。冗長な前置きは不要。",
    },
    { role: "user", content: log },
  ];
}
