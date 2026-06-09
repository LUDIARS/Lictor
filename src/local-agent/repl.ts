/**
 * ローカル LLM 対話 REPL。spec/local-llm-agent.md「REPL ループ」。
 *
 * Lictor の wrap が本プロセスを pty で包む。stdin は pty slave (TTY) なので
 * readline で行入力を受ける。Concordia/Discord からの inject は wrap が
 * child.write で stdin に流すため、同じ 'line' イベントで拾える (文脈に乗る)。
 * 推論も compaction の要約も**ローカル LLM だけ**で完結する。
 */

import * as readline from "node:readline";
import type { LocalAgentConfig } from "./config.js";
import { chat, chatStream, type ChatMessage, type OllamaClientOptions } from "./ollama.js";
import {
  appendCompaction,
  appendMessage,
  loadLiveMessages,
  transcriptPath,
} from "./transcript.js";
import { buildSummaryMessages, compact, shouldCompact } from "./compaction.js";
import { loadHooks, runHooks } from "./hooks.js";

const HELP = [
  "コマンド:",
  "  /compact   会話を要約して文脈を畳む (手動)",
  "  /tokens    現在の推定トークン量を表示",
  "  /help      このヘルプ",
  "  /exit /quit  終了",
].join("\n");

export async function runRepl(cfg: LocalAgentConfig): Promise<void> {
  const opts: OllamaClientOptions = {
    baseUrl: cfg.baseUrl,
    model: cfg.model,
    apiKey: cfg.apiKey,
    maxTokens: cfg.maxTokens,
    timeoutMs: cfg.timeoutMs,
  };
  const path = transcriptPath(cfg.sessionsDir, cfg.sessionId);
  const hooks = loadHooks(cfg.hooksPath);
  const cwd = process.cwd();

  // messages: [persona system?, ...復元した live working set]
  const messages: ChatMessage[] = [];
  if (cfg.system) messages.push({ role: "system", content: cfg.system });
  messages.push(...loadLiveMessages(path));

  const out = process.stdout;
  out.write(`Local LLM (${cfg.model} @ ${cfg.baseUrl})  —  /help でコマンド\n`);
  const resumed = messages.filter((m) => m.role !== "system").length;
  if (resumed > 0) out.write(`(${resumed} 件の会話を復元しました)\n`);

  await runHooks("SessionStart", { sessionId: cfg.sessionId, cwd }, hooks).catch(() => "");

  const rl = readline.createInterface({ input: process.stdin, output: out });
  rl.setPrompt("\n> ");
  rl.prompt();

  // 要約器: ローカル LLM (chat) で畳む対象を要約。
  const summarize = (toSummarize: ChatMessage[]) =>
    chat(buildSummaryMessages(toSummarize), { ...opts, maxTokens: Math.min(opts.maxTokens, 1024) });

  const doCompact = async (): Promise<void> => {
    const before = messages.length;
    const r = await compact(messages, cfg, summarize);
    if (r.dropped <= 0) {
      out.write("(畳む対象がありません)\n");
      return;
    }
    messages.length = 0;
    messages.push(...r.messages);
    appendCompaction(path, r.summary, r.dropped);
    out.write(`(コンパクション: ${r.dropped} 件を要約に畳みました。${before}→${messages.length} メッセージ)\n`);
  };

  return new Promise<void>((resolve) => {
    let busy = false;
    // 生成中 (busy) に届いた追加入力は捨てず FIFO キューに積み、生成完了後に
    // 順次処理する。ローカル LLM は 1 応答に数十秒かかるため、その間の inject
    // (Discord/Web/手入力) を無言ドロップしないための backpressure。
    const queue: string[] = [];

    // 1 プロンプトの生成サイクル。busy を立てて readline を pause し、完了後に
    // pump() で次のキューを引く (finally で必ず busy を倒す)。
    const handlePrompt = async (line: string): Promise<void> => {
      busy = true;
      rl.pause();
      try {
        // UserPromptSubmit hook → additionalContext を system に足す
        const extra = await runHooks(
          "UserPromptSubmit",
          { sessionId: cfg.sessionId, cwd, prompt: line },
          hooks,
        ).catch(() => "");
        if (extra) {
          const ctxMsg = `[hook:UserPromptSubmit]\n${extra}`;
          messages.push({ role: "system", content: ctxMsg });
          appendMessage(path, "system", ctxMsg);
        }

        messages.push({ role: "user", content: line });
        appendMessage(path, "user", line);

        let answer = "";
        try {
          answer = await chatStream(messages, opts, (t) => out.write(t));
        } catch (err) {
          out.write(`\n[エラー] ${(err as Error).message}\n`);
        }
        out.write("\n");
        if (answer) {
          messages.push({ role: "assistant", content: answer });
          appendMessage(path, "assistant", answer);
        }

        await runHooks("Stop", { sessionId: cfg.sessionId, cwd }, hooks).catch(() => "");

        if (shouldCompact(messages, cfg)) {
          await doCompact().catch((e) =>
            out.write(`\n(コンパクション失敗: ${(e as Error).message})\n`),
          );
        }
      } finally {
        busy = false;
        rl.resume();
        pump();
      }
    };

    // 1 行をコマンド or プロンプトに振り分ける (busy でない前提)。コマンドは同期で
    // 返り、プロンプトは handlePrompt が busy=true にして非同期実行する。
    const dispatch = (line: string): void => {
      if (line === "/exit" || line === "/quit") {
        rl.close();
        return;
      }
      if (line === "/help") {
        out.write(HELP + "\n");
        return;
      }
      if (line === "/tokens") {
        // 動的 import を避けるため estimate はここで軽く再計算
        const est = messages.reduce((n, m) => n + 4 + m.content.length, 0);
        out.write(`(推定 ~${est} 文字相当 / ${messages.length} メッセージ)\n`);
        return;
      }
      void handlePrompt(line);
    };

    // busy でない間だけキューを引く。コマンドは同期で返るのでループ継続、プロンプト
    // は busy=true でループ脱出 (その finally が再度 pump する)。空になったらプロンプト表示。
    const pump = (): void => {
      while (!busy) {
        const next = queue.shift();
        if (next === undefined) {
          rl.prompt();
          return;
        }
        dispatch(next);
      }
    };

    rl.on("line", (lineRaw) => {
      const line = lineRaw.trim();
      if (!line) {
        if (!busy) rl.prompt();
        return;
      }
      if (busy) {
        queue.push(line);
        out.write(`\n(生成中につきキューに追加 — 待ち ${queue.length} 件)\n`);
        return;
      }
      queue.push(line);
      pump();
    });

    rl.on("close", () => {
      out.write("\n(セッション終了)\n");
      resolve();
    });
  });
}
