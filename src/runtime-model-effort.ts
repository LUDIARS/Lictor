const MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$/u;
const CLAUDE_EFFORTS = new Set(["low", "medium", "high", "xhigh", "max"]);
type PtyWriter = (data: string) => void;

// A single TUI has one input buffer. Keep each model/effort pair contiguous
// when separate loopback requests arrive concurrently.
const pendingSwitches = new WeakMap<PtyWriter, Promise<void>>();

export interface RuntimeModelEffortRequest {
  model: string;
  effort: string;
}

export type RuntimeModelEffortResult =
  | { ok: true; status: 200; message: string }
  | { ok: false; status: 400 | 409 | 503; error: string; message?: string };

/**
 * Apply an exact provider-native runtime switch when the wrapped provider has
 * a non-interactive command grammar. Codex `/model` is a picker, so guessing
 * key sequences would make the selected model catalog-order dependent; fail
 * explicitly and let Concordia offer re-spawn/manual selection instead.
 *
 * @implements SPEC-RUNTIME-MODEL-EFFORT
 */
export async function applyRuntimeModelEffort(input: {
  provider: string | null;
  request: RuntimeModelEffortRequest;
  write: PtyWriter | null;
}): Promise<RuntimeModelEffortResult> {
  if (!input.write) {
    return { ok: false, status: 503, error: "pty_not_available" };
  }
  const model = input.request.model.trim();
  const effort = input.request.effort.trim().toLowerCase();
  if (!MODEL_RE.test(model)) {
    return { ok: false, status: 400, error: "invalid_model" };
  }
  if (input.provider === "codex") {
    return {
      ok: false,
      status: 409,
      error: "interactive_selection_required",
      message: `Codex TUI の /model は選択画面です。model=${model}, effort=${effort} を手動選択するか、この設定で再Spawnしてください。`,
    };
  }
  if (input.provider !== "claude") {
    return { ok: false, status: 409, error: "provider_runtime_switch_unsupported" };
  }
  if (!CLAUDE_EFFORTS.has(effort)) {
    return { ok: false, status: 400, error: "invalid_effort" };
  }

  await queueClaudeSwitch(input.write, model, effort);
  return {
    ok: true,
    status: 200,
    message: `Claude model=${model}, effort=${effort} への切替コマンドを送信しました。`,
  };
}

/** @implements SPEC-RUNTIME-MODEL-EFFORT */
function queueClaudeSwitch(write: PtyWriter, model: string, effort: string): Promise<void> {
  const previous = pendingSwitches.get(write) ?? Promise.resolve();
  const current = previous.then(async () => {
    write(`/model ${model}\r`);
    // Let Claude Code finish the first slash command before submitting the next
    // one. A single combined write can be interpreted as input to a transient UI.
    await new Promise<void>((resolve) => setTimeout(resolve, 200));
    write(`/effort ${effort}\r`);
  });
  // The caller receives a failed write; later requests must not remain blocked
  // behind that rejected switch.
  pendingSwitches.set(write, current.catch(() => {}));
  return current;
}
