/**
 * OpenAI 互換 `/v1/chat/completions` クライアント (Ollama / vLLM / LM Studio)。
 * 本エージェントは**ローカル LLM だけで完結**する (応答も compaction の要約も
 * 同じローカルエンドポイントを使う。クラウド依存ゼロ)。chat wire 固定
 * (Ollama は /v1/chat/completions を安定サポート。codex 0.13x の responses
 * 専用問題とは無関係 = 我々は HTTP を直接叩くだけ)。
 */

export type ChatRole = "system" | "user" | "assistant";

export interface ChatMessage {
  role: ChatRole;
  content: string;
}

export interface OllamaClientOptions {
  baseUrl: string;
  model: string;
  apiKey: string;
  maxTokens: number;
  timeoutMs: number;
}

function headers(apiKey: string): Record<string, string> {
  const h: Record<string, string> = { "content-type": "application/json" };
  if (apiKey) h.authorization = `Bearer ${apiKey}`;
  return h;
}

/**
 * ストリーミング応答。delta を `onToken` に逐次渡しつつ、全文を返す。
 * reasoning モデル (Gemma 4 等) は `message.reasoning`/`delta.reasoning` に
 * 思考を出すが、ここでは最終回答 (`content`) だけを拾う。
 */
export async function chatStream(
  messages: ChatMessage[],
  opts: OllamaClientOptions,
  onToken: (text: string) => void,
): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs);
  let full = "";
  try {
    const res = await fetch(`${opts.baseUrl}/chat/completions`, {
      method: "POST",
      headers: headers(opts.apiKey),
      body: JSON.stringify({
        model: opts.model,
        messages,
        max_tokens: opts.maxTokens,
        stream: true,
      }),
      signal: controller.signal,
    });
    if (!res.ok || !res.body) {
      const body = await res.text().catch(() => "");
      throw new Error(`local LLM http ${res.status}: ${body.slice(0, 200)}`);
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      // SSE: `data: {json}\n\n` 行単位。複数行をまとめて処理する。
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line.startsWith("data:")) continue;
        const payload = line.slice(5).trim();
        if (payload === "[DONE]") continue;
        try {
          const obj = JSON.parse(payload) as {
            choices?: { delta?: { content?: string } }[];
          };
          const piece = obj.choices?.[0]?.delta?.content;
          if (piece) {
            full += piece;
            onToken(piece);
          }
        } catch {
          // 部分行 / 非 JSON は無視 (次チャンクで揃う)。
        }
      }
    }
    return full;
  } finally {
    clearTimeout(timer);
  }
}

/** 非ストリーミング (compaction の要約生成用)。全文を返す。 */
export async function chat(messages: ChatMessage[], opts: OllamaClientOptions): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs);
  try {
    const res = await fetch(`${opts.baseUrl}/chat/completions`, {
      method: "POST",
      headers: headers(opts.apiKey),
      body: JSON.stringify({
        model: opts.model,
        messages,
        max_tokens: opts.maxTokens,
        stream: false,
      }),
      signal: controller.signal,
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`local LLM http ${res.status}: ${body.slice(0, 200)}`);
    }
    const data = (await res.json()) as {
      choices?: { message?: { content?: string } }[];
    };
    return (data.choices?.[0]?.message?.content ?? "").trim();
  } finally {
    clearTimeout(timer);
  }
}
