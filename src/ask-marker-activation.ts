export type AskMarkerInjection = "none" | "claude-system-prompt";

export type AskMarkerActivationReason =
  | "concordia-disabled"
  | "codex-external-steering"
  | "claude-system-prompt"
  | "session-injector-missing"
  | "provider-unsupported";

export interface AskMarkerActivationPlan {
  enabled: boolean;
  injection: AskMarkerInjection;
  reason: AskMarkerActivationReason;
}

/**
 * ask マーカーの transcript 検出可否と、provider 固有の steering 注入を分離する。
 * Codex のルールはグローバル skill / セッション外 steering から供給されるため、
 * session-scoped SkillInjector が無くても Concordia 連携中は検出を有効にする。
 *
 * @implements SPEC-ASK-MARKER-ACTIVATION
 */
export function planAskMarkerActivation(
  providerName: string,
  concordiaAvailable: boolean,
  injectorAvailable: boolean,
): AskMarkerActivationPlan {
  if (!concordiaAvailable) {
    return { enabled: false, injection: "none", reason: "concordia-disabled" };
  }

  if (providerName === "codex") {
    return { enabled: true, injection: "none", reason: "codex-external-steering" };
  }

  if (providerName === "claude") {
    if (!injectorAvailable) {
      return { enabled: false, injection: "none", reason: "session-injector-missing" };
    }
    return { enabled: true, injection: "claude-system-prompt", reason: "claude-system-prompt" };
  }

  return { enabled: false, injection: "none", reason: "provider-unsupported" };
}

/**
 * Cc spawn の Claude セッションで組み込み `AskUserQuestion` を **物理的に**
 * 使えなくするための起動引数。
 *
 * system prompt 追記 (ASK_MARKER_CLAUDE_ADDENDUM) は soft な指示にすぎず、
 * Claude Code 既定プロンプトの「判断に迷ったら AskUserQuestion」と競合したとき
 * 負けることがある (2026-09-05: 委託子セッションが picker を開き、リレー越しに
 * 回答できず停止した)。picker は Discord からは押せないので、Cc spawn では
 * ツールごと外して ask マーカーだけを回答経路にする。
 *
 * enrollment (= CONCORDIA_SPAWN_ID) を持たない起動は **人間が端末の前にいる**
 * 対話セッションなので、picker は普通に答えられる。ここで外すと利便性を削るだけ
 * なので付けない。
 *
 * @implements SPEC-ASK-MARKER-ACTIVATION
 */
export function askUserQuestionDisableArgs(
  providerName: string,
  enrollment: string | null,
): string[] {
  if (providerName !== "claude") return [];
  if (!enrollment || !enrollment.trim()) return [];
  return ["--disallowedTools", "AskUserQuestion"];
}
