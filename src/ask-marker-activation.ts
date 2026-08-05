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
