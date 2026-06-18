/* Lictor sidecar HTTP API — data model
 * Source of truth: src/sidecar.ts (handler `handle`). All endpoints bind to
 * 127.0.0.1 / ::1 only; loopback guard runs first. Body cap 64 KiB.
 * spec: "ok"   = documented in spec/interface/sidecar-http-api.md and matches code
 *       "warn" = implemented in code but missing / partial in spec
 */
window.LICTOR_API = {
  meta: {
    base: "http://127.0.0.1:${LICTOR_PORT}",
    invariants: [
      "全リクエストは 127.0.0.1 / ::1 発のみ（ハンドラ先頭で loopback 検証）。",
      "Body cap 64 KiB。タイトル長 200 文字（C0/DEL 除去後）。",
      "TUI 書き込み系（rename/slash/keys/answer）は注入前に必ずサニタイズ。",
      "Concordia 依存は best-effort。未登録時は 500 ではなく 503 で劣化。",
    ],
  },
  groups: [
    {
      name: "ヘルス & メタ",
      endpoints: [
        {
          method: "GET", path: "/v1/health", spec: "ok",
          desc: "ヘルスチェック",
          behavior: "sidecar の生存確認。",
          response: `{"ok": true}`,
        },
        {
          method: "GET", path: "/v1/version", spec: "ok",
          desc: "バイナリのバージョン",
          behavior: "この sidecar を動かしている lictor バイナリの version（npm link 元と異なる場合がある）。",
          response: `{"name": "lictor", "version": "<semver>"}`,
        },
        {
          method: "GET", path: "/v1/meta", spec: "ok",
          desc: "セッション meta + persona",
          behavior: "PID / cwd / WT_SESSION / persona などのセッションメタを返す。",
          response: `{ pid, cwd, sessionStart, persona, ... }`,
        },
        {
          method: "GET", path: "/v1/concordia/session", spec: "ok",
          desc: "Concordia セッション情報",
          behavior: "保持中の Discord channel ids を含むセッション概要。",
          response: `{ session_id, persona, role_label, concordia_enabled, discord }`,
        },
      ],
    },
    {
      name: "端末タイトル",
      endpoints: [
        {
          method: "POST", path: "/v1/title", spec: "ok",
          desc: "OSC 0 発行 + 手動オーバーライド",
          params: [{ k: "text", t: "string", d: "タイトル文字列。C0/DEL 除去後 200 文字に cap。" }],
          behavior: "OSC 0 を発行し手動オーバーライドを立てる。以降の自動更新を抑止。",
          response: `{ "ok": true, "title": "<sanitized>" }`,
        },
        {
          method: "POST", path: "/v1/title/auto", spec: "ok",
          desc: "手動オーバーライド解除",
          behavior: "手動オーバーライドを外す。次の stat 周期から自動タイトルが再開。",
          response: `{ "ok": true }`,
        },
      ],
    },
    {
      name: "キーストローク注入（trust boundary）",
      endpoints: [
        {
          method: "POST", path: "/v1/rename", spec: "ok",
          desc: "claude TUI へ /rename 注入",
          params: [{ k: "text", t: "string", d: "セッション名。サニタイズ後 /rename <text>\\r を注入。" }],
          behavior: "claude TUI stdin に /rename <text>\\r を打鍵。実セッション非ラップ時は 503。",
          response: `200 { "ok": true }  /  503 (no pty)`,
        },
        {
          method: "POST", path: "/v1/slash", spec: "ok",
          desc: "汎用 slash 注入",
          params: [
            { k: "cmd", t: "string", d: "slash コマンド名。正規表現 ^[a-z][a-z0-9-]{0,40}$。" },
            { k: "args", t: "string?", d: "引数（任意）。" },
          ],
          behavior: "/<cmd> <args>\\r を TUI に注入。",
          response: `{ "ok": true }`,
        },
        {
          method: "POST", path: "/v1/keys", spec: "ok",
          desc: "生キーストローク注入",
          params: [{ k: "data", t: "string", d: "生キー列。C0 制御は \\t \\n \\r \\b ESC 以外除去。Ctrl-C はドロップ。" }],
          behavior: "誤セッション kill を防ぐため Ctrl-C を落としつつ生キーを pty へ。",
          response: `{ "ok": true }`,
        },
        {
          method: "POST", path: "/v1/answer", spec: "ok",
          desc: "AskUserQuestion picker 回答",
          params: [
            { k: "choice", t: "number", d: "1-based の選択肢（1–50）。Down×(choice-1) + Enter を送る。" },
            { k: "escape_first", t: "boolean?", d: "先に ESC を送るか（任意）。" },
          ],
          behavior: "picker のナビゲーション＋確定キーを注入して回答。",
          response: `{ "ok": true }`,
        },
      ],
    },
    {
      name: "Concordia 中継",
      endpoints: [
        {
          method: "POST", path: "/v1/chat", spec: "ok",
          desc: "Concordia /v1/chat へ中継",
          params: [
            { k: "channel", t: "string", d: "送信先チャンネル。" },
            { k: "text", t: "string", d: "本文。" },
            { k: "author_label", t: "string?", d: "未指定なら persona から自動補完（混線防止）。" },
            { k: "in_reply_to", t: "string?", d: "返信先（任意）。" },
            { k: "scope", t: "string?", d: "スコープ（任意）。" },
          ],
          behavior: "権威ある session_id を付与し、保持中の discord_channel_id を解決して中継。Concordia 未登録時 503。",
          response: `200 (relayed)  /  503 (no Concordia)`,
        },
        {
          method: "POST", path: "/v1/report", spec: "ok",
          desc: "日報独白を追記",
          params: [
            { k: "monologue", t: "string", d: "日報の独白テキスト。" },
            { k: "role", t: "string?", d: "ロール（任意）。" },
          ],
          behavior: "Concordia /v1/reports/:id/append へ session_id を刻んで追記。",
          response: `200  /  503 (no Concordia)`,
        },
        {
          method: "POST", path: "/v1/event", spec: "ok",
          desc: "イベント中継",
          params: [
            { k: "kind", t: "string", d: "イベント種別。" },
            { k: "payload", t: "object?", d: "ペイロード（任意）。" },
            { k: "ts", t: "string?", d: "タイムスタンプ（任意）。" },
          ],
          behavior: "Concordia /v1/sessions/:id/event へ中継。",
          response: `200  /  503 (no Concordia)`,
        },
        {
          method: "GET", path: "/v1/conflicts", spec: "ok",
          desc: "競合確認",
          params: [
            { k: "repo", t: "query?", d: "対象 repo パス（既定 = cwd）。" },
            { k: "branch", t: "query?", d: "対象 branch（任意）。" },
          ],
          behavior: "Concordia /v1/monitor/conflicts へ中継（自セッションを除外）。",
          response: `200 { conflicts }  /  503 (no Concordia)`,
        },
      ],
    },
    {
      name: "Skill 注入",
      endpoints: [
        {
          method: "GET", path: "/v1/skill", spec: "ok",
          desc: "注入済 skill 一覧",
          behavior: "注入済 skill 名と claude が走査する dir を返す。",
          response: `{ dir, skills: ["lictor-persona", ...] }`,
        },
        {
          method: "POST", path: "/v1/skill", spec: "ok",
          desc: "SKILL.md 書込/上書",
          params: [
            { k: "name", t: "string", d: "skill 名。正規表現 ^[a-z][a-z0-9-]{0,63}$（kebab-case）。" },
            { k: "content", t: "string", d: "SKILL.md 本文。32 KiB cap。" },
          ],
          behavior: "SKILL.md を書込/上書。既存名は claude が live-reload、新規名は再起動まで未認識。",
          response: `200 { "ok": true }  /  400 (bad name / too large)`,
        },
        {
          method: "DELETE", path: "/v1/skill/<name>", spec: "ok",
          desc: "注入 skill を削除",
          behavior: "指定名の注入 skill を削除。",
          response: `{ "ok": true }`,
        },
      ],
    },
    {
      name: "タスク & 状態",
      endpoints: [
        {
          method: "POST", path: "/v1/lictor/task", spec: "ok",
          desc: "タスク宣言",
          params: [
            { k: "branch", t: "string?", d: "作業ブランチ（任意）。" },
            { k: "desc", t: "string?", d: "作業内容の説明（任意）。" },
          ],
          behavior: "Concordia session を PATCH + event 発火 + lictor-current-task skill を更新。",
          response: `{ branch, desc, updatedAt }`,
        },
        {
          method: "GET", path: "/v1/lictor/task", spec: "ok",
          desc: "現在タスク取得",
          behavior: "現在のタスク状態を返す。",
          response: `{ branch, desc, updatedAt }`,
        },
        {
          method: "GET", path: "/v1/lictor/state", spec: "ok",
          desc: "状態スナップショット",
          behavior: "ダッシュボード用の状態スナップショット。",
          response: `{ notify, conflict, task }`,
        },
      ],
    },
    {
      name: "Transcript",
      endpoints: [
        {
          method: "GET", path: "/v1/transcript", spec: "ok",
          desc: "ラップ中 CLI の transcript",
          params: [
            { k: "limit", t: "query?", d: "返却行数 1–500（既定 50）。" },
            { k: "raw", t: "query?", d: "1 でパース済 JSONL オブジェクト、既定は slim frame。" },
          ],
          behavior: "発見済みの JSONL を再読みして末尾 limit 行を返す。transcript-tail 非活性（Concordia 無 / pty 無）時 503。",
          response: `{ path, available, total_lines, returned, frames | lines }  /  503`,
        },
      ],
    },
    {
      name: "Filesystem RPC（cwd 限定）",
      specNote: "spec/interface 未記載（実装・テストは存在）。Concordia がこれらを proxy する。",
      endpoints: [
        {
          method: "GET", path: "/v1/fs/read", spec: "warn",
          desc: "ファイル読み取り（cwd 限定）",
          params: [{ k: "path", t: "query", d: "cwd 起点の相対パス。範囲外/不正は 400。" }],
          behavior: "cwd に閉じたファイル読み取り（fsRead）。",
          response: `200 { path, content, ... }  /  400 { error }`,
        },
        {
          method: "GET", path: "/v1/fs/list", spec: "warn",
          desc: "ディレクトリ列挙（cwd 限定）",
          params: [{ k: "path", t: "query?", d: "cwd 起点の相対パス（既定 \".\"）。" }],
          behavior: "cwd に閉じたディレクトリ列挙（fsList）。",
          response: `200 { entries }  /  400 { error }`,
        },
        {
          method: "GET", path: "/v1/fs/grep", spec: "warn",
          desc: "grep（cwd 限定）",
          params: [
            { k: "pattern", t: "query", d: "検索パターン。" },
            { k: "path", t: "query?", d: "検索起点（任意）。" },
            { k: "flags", t: "query?", d: "フラグ（任意）。" },
          ],
          behavior: "cwd に閉じた grep（fsGrep）。",
          response: `200 { matches }  /  400 { error }`,
        },
      ],
    },
    {
      name: "内部（フック / Concordia 用）",
      specNote: "claude 内のフックではなく、lictor cli permission-hook / ask-question-hook と Concordia の proxy が叩く。",
      endpoints: [
        {
          method: "POST", path: "/v1/internal/permission-check", spec: "warn",
          desc: "PreToolUse 許可判断を Concordia へ",
          params: [
            { k: "tool_name", t: "string", d: "判定対象ツール名（必須）。" },
            { k: "tool_input", t: "object?", d: "ツール入力（任意）。" },
            { k: "timeout_ms", t: "number?", d: "待機タイムアウト（既定 60s、最大 600s）。" },
          ],
          behavior: "Concordia へ許可要求を投げ Web UI モーダルの応答を待つ。Concordia 不在・到達不可・タイムアウト時は default-allow（Lictor は黙って deny しない）。",
          response: `{ decision: "allow"|"deny"|"ask", reason? }`,
        },
        {
          method: "POST", path: "/v1/internal/ask-question", spec: "warn",
          desc: "AskUserQuestion 早期投稿",
          behavior: "picker-open 時に質問を回答前に Concordia へ投稿し Discord から答えられるようにする。fire-and-forget。decision は返さず picker をそのまま開かせる。",
          response: `{ "ok": true }`,
        },
        {
          method: "POST", path: "/v1/internal/permission-response", spec: "warn",
          desc: "許可応答の受け口",
          behavior: "Concordia 側の判断（allow/deny/ask）を pending な permission-check へ解決として渡す。",
          response: `{ "ok": true }`,
        },
        {
          method: "POST", path: "/v1/internal/force-exit", spec: "warn",
          desc: "ラップ中 AI プロセスを kill",
          behavior: "ラップ中 AI プロセスに SIGTERM。Concordia がセッション DELETE 後に呼ぶ。pty を包んでいない（smoke harness 等）時は 503。",
          response: `200  /  503 (no pty)`,
        },
      ],
    },
  ],
};
