/* Lictor — domain / function relationship graph (cytoscape elements + render) */

// status: ok = spec と一致 / warn = spec 未記載 / drift = spec とコードが乖離 /
//         ext = 外部アクター・サービス
const DOMAINS = [
  { id: "d_pty",   label: "pty ラッピング",        status: "ok" },
  { id: "d_title", label: "端末タイトル",          status: "ok" },
  { id: "d_keys",  label: "キーストローク注入",    status: "ok" },
  { id: "d_conc",  label: "Concordia 連携",        status: "ok" },
  { id: "d_skill", label: "skill 注入",            status: "ok" },
  { id: "d_trans", label: "transcript リレー",     status: "ok" },
  { id: "d_perm",  label: "許可プロキシ",          status: "ok" },
  { id: "d_deleg", label: "委託 prompt 注入",      status: "ok" },
  { id: "d_task",  label: "タスク宣言",            status: "ok" },
  { id: "d_gate",  label: "AskUserQuestion gate",  status: "ok" },
  { id: "d_fs",    label: "filesystem RPC",        status: "warn" },
  { id: "d_local", label: "Local LLM provider",    status: "drift" },
  { id: "d_cli",   label: "CLI / entry",           status: "ok" },
];

// modules: parent = domain id
const MODULES = [
  // hub
  { id: "sidecar", parent: null, label: "sidecar.ts", status: "ok", hub: true,
    desc: "loopback HTTP ルータ。全エンドポイントの入口。sanitizeRenameArg（pty 注入の trust boundary）もここ。", spec: "spec/interface/sidecar-http-api.md" },

  // pty
  { id: "wrap", parent: "d_pty", label: "wrap.ts", status: "ok",
    desc: "node-pty で provider を spawn し I/O 中継。sidecar 起動・Concordia 登録・skill seed・transcript tail・delegation 注入を束ねる。", spec: "spec/feature/pty-wrapping.md" },
  { id: "provider", parent: "d_pty", label: "provider.ts", status: "ok",
    desc: "claude / codex / gemini / gemma4-12(famulus) を判定。binary・spawnArgs・skillStrategy・submitInject を持つ。", spec: "spec/feature/pty-wrapping.md" },

  // title
  { id: "osc", parent: "d_title", label: "osc.ts", status: "ok",
    desc: "sanitizeTitle（C0/DEL 除去・200 字 cap）+ writeOsc。OSC タイトルの trust boundary。", spec: "spec/feature/terminal-title.md" },
  { id: "autotitle", parent: "d_title", label: "auto-title.ts", status: "ok",
    desc: "persona + repo + branch + dirty/unpushed から自動タイトルを生成。競合時 ⚠N。", spec: "spec/feature/terminal-title.md" },
  { id: "stat", parent: "d_title", label: "stat.ts", status: "ok",
    desc: "git 現況（branch / dirty / unpushed / 直近 commit）を収集。10 分周期。", spec: "spec/feature/concordia-integration.md" },

  // keys
  { id: "askrelay", parent: "d_keys", label: "ask-question-relay.ts", status: "ok",
    desc: "AskUserQuestion の検知（detectAskUserQuestion）と回答キー注入（Down×(N-1)+Enter）。", spec: "spec/feature/keystroke-injection.md" },

  // concordia
  { id: "concordia", parent: "d_conc", label: "concordia.ts", status: "ok",
    desc: "Concordia クライアント。register / WS liveness / stat / chat / event / conflicts。best-effort。", spec: "spec/interface/concordia-client.md" },
  { id: "client", parent: "d_conc", label: "client.ts", status: "ok",
    desc: "HTTP クライアント下回り（fetch ラッパ）。", spec: "spec/interface/concordia-client.md" },
  { id: "ctypes", parent: "d_conc", label: "concordia-types.ts", status: "ok",
    desc: "Concordia API の型定義。", spec: "spec/interface/concordia-client.md" },
  { id: "reactor", parent: "d_conc", label: "event-reactor.ts", status: "ok",
    desc: "WS broadcast を受けてタイトルマーク（[!]）/ conflict refresh / session.inject を駆動。", spec: "spec/feature/concordia-integration.md" },
  { id: "meta", parent: "d_conc", label: "meta.ts", status: "ok",
    desc: "セッション meta（pid / cwd / persona 等）。", spec: "spec/feature/concordia-integration.md" },

  // skill
  { id: "skillinj", parent: "d_skill", label: "skill-injector.ts", status: "ok",
    desc: "per-session dir の writeSkill / deleteSkill（name 正規表現 + 32 KiB cap を強制）。", spec: "spec/feature/skill-injection.md" },
  { id: "memload", parent: "d_skill", label: "memory-loader.ts", status: "ok",
    desc: "純関数。(memoryDir, repoLeaf) から repo 関連メモリをスコア付きで返す。", spec: "spec/feature/skill-injection.md" },
  { id: "statestate", parent: "d_skill", label: "session-state-skill.ts", status: "ok",
    desc: "lictor-session-state skill（branch / dirty / unpushed）を 10 分周期で上書。", spec: "spec/feature/skill-injection.md" },
  { id: "endskill", parent: "d_skill", label: "session-end-skill.ts", status: "ok",
    desc: "終了時の report / 後片付け skill 関連。", spec: "spec/feature/skill-injection.md" },
  { id: "activerepos", parent: "d_skill", label: "active-repos.ts", status: "ok",
    desc: "アクティブ repo 集計（メモリ/状態供給の補助）。", spec: "spec/feature/skill-injection.md" },

  // transcript
  { id: "transtail", parent: "d_trans", label: "transcript-tail.ts", status: "ok",
    desc: "JSONL を claim して tail、frame 化し Concordia へ push。GET /v1/transcript の pull 元。gate の open/close も駆動。", spec: "spec/feature/transcript-relay.md" },

  // permission
  { id: "permhook", parent: "d_perm", label: "permission-hook.ts", status: "ok",
    desc: "PreToolUse hook ブリッジ。session-scoped settings 注入で許可/保留を Concordia へ。", spec: "spec/feature/permission-proxy.md" },

  // delegation
  { id: "deleg", parent: "d_deleg", label: "delegation-inject.ts", status: "ok",
    desc: "CONCORDIA_DELEGATION_PROMPT_FILE を読み・サニタイズし、TUI 起動後に一度だけ貼付+送信。", spec: "spec/feature/delegation-inject.md" },

  // task
  { id: "taskrelay", parent: "d_task", label: "task-relay.ts", status: "ok",
    desc: "タスク宣言を Concordia へ PATCH + event 発火 + lictor-current-task skill 更新。", spec: "spec/feature/task-protocol.md" },
  { id: "pendtasks", parent: "d_task", label: "pending-tasks.ts", status: "ok",
    desc: "60s 周期で pending-tasks を取得し lictor-pending-tasks skill に反映。", spec: "spec/feature/task-protocol.md" },
  { id: "confwatch", parent: "d_task", label: "conflict-watcher.ts", status: "ok",
    desc: "60s 周期で conflicts を監視し lictor-conflicts skill + タイトル ⚠N。", spec: "spec/feature/task-protocol.md" },

  // gate
  { id: "gate", parent: "d_gate", label: "pending-question-gate.ts", status: "ok",
    desc: "picker 表示中の通常 inject を FIFO 保留。tool_result 検知で flush。純粋な状態機械。", spec: "spec/feature/askquestion-pending-gate.md" },
  { id: "askhook", parent: "d_gate", label: "ask-question-hook.ts", status: "ok",
    desc: "PreToolUse(AskUserQuestion) hook。質問を回答前に /v1/internal/ask-question へ早期投稿。", spec: "spec/feature/askquestion-pending-gate.md" },
  { id: "askmarker", parent: "d_gate", label: "ask-marker.ts", status: "ok",
    desc: "質問マーカーの検知・整形補助。", spec: "spec/feature/askquestion-pending-gate.md" },
  { id: "askjson", parent: "d_gate", label: "ask-json.ts", status: "ok",
    desc: "AskUserQuestion ペイロードの抽出・整形。", spec: "spec/feature/askquestion-pending-gate.md" },

  // fs-rpc (undocumented)
  { id: "fsrpc", parent: "d_fs", label: "fs-rpc.ts", status: "warn",
    desc: "cwd 限定の read/list/grep（fsRead/fsList/fsGrep）。GET /v1/fs/* の実体。spec 未記載。", spec: "（spec 未記載）" },

  // local-llm (drift)
  { id: "localagent", parent: "d_local", label: "src/local-agent/*", status: "drift",
    desc: "内蔵 REPL（repl / ollama / compaction / transcript / hooks）。provider が famulus へ移行し旧実装として残存。", spec: "spec/local-llm-agent.md（陳腐化）" },

  // cli
  { id: "cli", parent: "d_cli", label: "cli.ts", status: "ok",
    desc: "lictor エントリ + cli サブコマンド（title / rename / chat / skill / task …）。HTTP 経由で sidecar を叩く。", spec: "spec/setup/setup.md" },
  { id: "version", parent: "d_cli", label: "version.ts", status: "ok",
    desc: "バイナリ version。GET /v1/version の元。", spec: "spec/setup/setup.md" },
];

// external actors
const EXTERNALS = [
  { id: "terminal", label: "ホスト端末 (pty)", status: "ext",
    desc: "Windows Terminal / iTerm2 / Alacritty 等。Lictor の process.stdout が繋がる本物の pty。" },
  { id: "tui", label: "claude / codex TUI", status: "ext",
    desc: "ラップ対象のエージェント CLI。pty 子プロセスとして起動される。" },
  { id: "concordiaSvc", label: "Concordia サービス", status: "ext",
    desc: "127.0.0.1:17330 のマルチエージェント調整サービス。register / WS / stat / chat / conflicts 等。" },
  { id: "famulus", label: "Famulus (外部)", status: "ext",
    desc: "別リポの Local LLM ランナ。gemma4-12 provider が `famulus run` で spawn（旧内蔵 REPL の後継）。" },
];

// edges: [source, target, label]
const EDGES = [
  ["terminal", "wrap", "pty I/O"],
  ["wrap", "tui", "spawn (node-pty)"],
  ["wrap", "provider", "判定"],
  ["wrap", "sidecar", "起動"],
  ["wrap", "concordia", "登録"],
  ["wrap", "skillinj", "seed"],
  ["wrap", "transtail", "tail 開始"],
  ["wrap", "deleg", "prompt 注入"],
  ["provider", "famulus", "gemma4-12"],
  ["provider", "localagent", "(旧) local"],

  ["sidecar", "osc", "title 書込"],
  ["sidecar", "askrelay", "answer"],
  ["sidecar", "concordia", "chat/event/report/conflicts proxy"],
  ["sidecar", "skillinj", "skill write/delete"],
  ["sidecar", "taskrelay", "task"],
  ["sidecar", "transtail", "getTranscript"],
  ["sidecar", "fsrpc", "fs read/list/grep"],
  ["sidecar", "tui", "ptyWriter 注入"],

  ["autotitle", "stat", "現況"],
  ["autotitle", "osc", "発行"],

  ["concordia", "client", "HTTP"],
  ["concordia", "concordiaSvc", "fetch / WS"],
  ["concordia", "reactor", "WS event"],
  ["reactor", "osc", "title mark"],
  ["reactor", "tui", "session.inject"],

  ["skillinj", "memload", "repo メモリ"],
  ["statestate", "skillinj", "state skill"],
  ["taskrelay", "concordia", "PATCH/event"],
  ["taskrelay", "skillinj", "current-task skill"],
  ["pendtasks", "concordia", "poll"],
  ["confwatch", "concordia", "poll"],
  ["confwatch", "osc", "⚠N"],

  ["transtail", "concordiaSvc", "frame push"],
  ["transtail", "gate", "open/close"],
  ["gate", "tui", "保留 flush → ptyWriter"],
  ["askhook", "sidecar", "/v1/internal/ask-question"],
  ["permhook", "sidecar", "/v1/internal/permission-check"],
  ["sidecar", "concordiaSvc", "permission request"],

  ["cli", "sidecar", "HTTP shortcut"],
  ["cli", "version", "—"],
];

const STATUS_COLOR = {
  ok:    "#3fb950",
  warn:  "#d29922",
  drift: "#f85149",
  ext:   "#bc8cff",
  hub:   "#6ea8fe",
};

function buildElements() {
  const els = [];
  DOMAINS.forEach((d) => els.push({ data: { id: d.id, label: d.label, kind: "domain", status: d.status } }));
  MODULES.forEach((m) => els.push({ data: {
    id: m.id, parent: m.parent || undefined, label: m.label,
    kind: m.hub ? "hub" : "module", status: m.status, desc: m.desc, spec: m.spec,
  }}));
  EXTERNALS.forEach((e) => els.push({ data: { id: e.id, label: e.label, kind: "ext", status: "ext", desc: e.desc, spec: "外部" } }));
  EDGES.forEach(([s, t, l], i) => els.push({ data: { id: "e" + i, source: s, target: t, label: l } }));
  return els;
}

window.addEventListener("DOMContentLoaded", () => {
  const cy = cytoscape({
    container: document.getElementById("cy"),
    elements: buildElements(),
    minZoom: 0.2, maxZoom: 2.5,
    style: [
      { selector: "node[kind='domain']", style: {
        "label": "data(label)", "text-valign": "top", "text-halign": "center",
        "color": "#9aa7b4", "font-size": 13, "font-weight": "bold",
        "background-color": "#11161f", "background-opacity": 0.5,
        "border-width": 1, "border-color": "#2b3340", "border-style": "dashed",
        "shape": "round-rectangle", "padding": 12,
      }},
      { selector: "node[kind='module'], node[kind='hub'], node[kind='ext']", style: {
        "label": "data(label)", "color": "#e6edf3", "font-size": 11,
        "text-valign": "center", "text-halign": "center", "text-wrap": "wrap", "text-max-width": 110,
        "background-color": (n) => STATUS_COLOR[n.data("status")] || "#586069",
        "background-opacity": 0.92, "shape": "round-rectangle",
        "width": "label", "height": "label", "padding": 8,
        "border-width": 1, "border-color": "#0d1117",
      }},
      { selector: "node[kind='hub']", style: {
        "background-color": STATUS_COLOR.hub, "font-size": 13, "font-weight": "bold",
        "border-width": 2, "border-color": "#e6edf3",
      }},
      { selector: "node[kind='ext']", style: {
        "background-color": "#1c2330", "border-width": 2, "border-color": STATUS_COLOR.ext, "color": STATUS_COLOR.ext, "shape": "round-rectangle",
      }},
      { selector: "edge", style: {
        "width": 1.3, "line-color": "#30363d", "target-arrow-color": "#30363d",
        "target-arrow-shape": "triangle", "curve-style": "bezier", "arrow-scale": 0.8,
        "label": "data(label)", "font-size": 8, "color": "#6e7681", "text-opacity": 0,
        "text-rotation": "autorotate", "text-background-color": "#0d1117", "text-background-opacity": 1, "text-background-padding": 2,
      }},
      { selector: "node:selected", style: { "border-width": 3, "border-color": "#6ea8fe" } },
      { selector: ".faded", style: { "opacity": 0.12 } },
      { selector: ".hl", style: { "line-color": "#6ea8fe", "target-arrow-color": "#6ea8fe", "width": 2.2, "text-opacity": 1, "z-index": 99 } },
    ],
    layout: { name: "cose", animate: false, padding: 30, nodeRepulsion: 9000, idealEdgeLength: 95, nestingFactor: 1.1, gravity: 0.6 },
  });

  const info = document.getElementById("node-info");
  const defaultInfo = info.innerHTML;

  cy.on("tap", "node", (evt) => {
    const n = evt.target;
    if (n.data("kind") === "domain") return;
    cy.elements().addClass("faded");
    const neigh = n.closedNeighborhood();
    neigh.removeClass("faded");
    n.connectedEdges().removeClass("faded").addClass("hl");
    const status = n.data("status");
    const badge = { ok: "spec ✓", warn: "spec 未記載", drift: "spec と乖離", ext: "外部" }[status] || status;
    info.innerHTML =
      "<strong>" + n.data("label") + "</strong> &nbsp;<span class='chip " +
      (status === "ok" ? "ok" : status === "warn" ? "warn" : status === "drift" ? "drift" : "") + "'>" + badge + "</span>" +
      "<br>" + (n.data("desc") || "") +
      (n.data("spec") ? "<br><span class='small dim mono'>" + n.data("spec") + "</span>" : "");
  });

  cy.on("tap", (evt) => {
    if (evt.target === cy) {
      cy.elements().removeClass("faded").removeClass("hl");
      info.innerHTML = defaultInfo;
    }
  });

  document.getElementById("fit").addEventListener("click", () => cy.fit(undefined, 30));
  document.getElementById("relayout").addEventListener("click", () =>
    cy.layout({ name: "cose", animate: true, padding: 30, nodeRepulsion: 9000, idealEdgeLength: 95 }).run());
});
