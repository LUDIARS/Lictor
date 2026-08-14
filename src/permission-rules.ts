/**
 * settings.json の permissions 規則を読み、 ツール呼び出しがどの規則に当たるかを
 * **監査注記のために** 判定する。
 *
 * ここでの判定は許可判断の正本ではない (正本は Claude Code 自身)。 目的は
 * 監査ログに「どの層のどの規則で自動許可されたのか / どの規則にも当たらずに
 * 通ったのか」 を残し、 settings.json の漏れを可視化することだけ。
 * したがって近似で足りる代わりに、 過剰に allow と言わない側へ倒す
 * (判定できなければ null = 規則なし)。
 *
 * 層の優先順位は Claude Code に合わせて deny > ask > allow、
 * ファイルは cwd 側 (local → project) → ユーザ設定の順に見る。
 */

import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { homedir } from "node:os";

export type RuleEffect = "allow" | "deny" | "ask";

export interface PermissionRuleLayer {
  /** 読み元 (絶対パス)。 監査ログにそのまま載る。 */
  source: string;
  allow: string[];
  deny: string[];
  ask: string[];
}

export interface RuleMatch {
  effect: RuleEffect;
  rule: string;
  source: string;
}

interface SettingsShape {
  permissions?: { allow?: unknown; deny?: unknown; ask?: unknown };
}

function readStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}

/** 1 ファイルを層として読む。 読めない / 壊れている場合は null。 */
export function readPermissionLayer(path: string): PermissionRuleLayer | null {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return null;
  }
  let parsed: SettingsShape;
  try {
    parsed = JSON.parse(raw) as SettingsShape;
  } catch {
    return null;
  }
  const permissions = parsed.permissions ?? {};
  const layer: PermissionRuleLayer = {
    source: path,
    allow: readStringArray(permissions.allow),
    deny: readStringArray(permissions.deny),
    ask: readStringArray(permissions.ask),
  };
  if (!layer.allow.length && !layer.deny.length && !layer.ask.length) return null;
  return layer;
}

/**
 * cwd から上へ辿って `.claude/settings.local.json` / `.claude/settings.json` を集め、
 * 最後にユーザ設定 (`~/.claude/settings.json`) を加える。
 * 近い層を先に返す (deny/ask/allow の探索順とは独立)。
 */
export function loadPermissionLayers(cwd: string, home = homedir()): PermissionRuleLayer[] {
  const layers: PermissionRuleLayer[] = [];
  let dir = resolve(cwd);
  for (;;) {
    for (const name of ["settings.local.json", "settings.json"]) {
      const layer = readPermissionLayer(join(dir, ".claude", name));
      if (layer) layers.push(layer);
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  const userLayer = readPermissionLayer(join(home, ".claude", "settings.json"));
  if (userLayer) layers.push(userLayer);
  return layers;
}

interface ParsedRule {
  tool: string;
  specifier: string | null;
}

export function parseRule(rule: string): ParsedRule | null {
  const trimmed = rule.trim();
  if (!trimmed) return null;
  const m = /^([A-Za-z_][\w.-]*)\((.*)\)$/.exec(trimmed);
  if (!m) return { tool: trimmed, specifier: null };
  return { tool: m[1], specifier: m[2] };
}

/** glob 風の specifier を正規表現へ落とす (`*` = 任意、 `**` = 区切りを跨ぐ)。 */
function globToRegExp(specifier: string): RegExp {
  const escaped = specifier.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  const globStarPlaceholder = "__LICTOR_GLOBSTAR__";
  const pattern = escaped
    .replace(/\*\*/g, globStarPlaceholder)
    .replace(/\*/g, "[^/\\\\]*")
    .replaceAll(globStarPlaceholder, ".*");
  return new RegExp(`^${pattern}$`);
}

/** Bash コマンドを、 規則が個別に当たるべき単位へ割る。 */
export function splitCommandSegments(command: string): string[] {
  return command
    .split(/&&|\|\||;|\|/)
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0);
}

function bashSpecifierMatches(specifier: string, segment: string): boolean {
  if (specifier.endsWith(":*")) {
    const prefix = specifier.slice(0, -2).trim();
    return segment === prefix || segment.startsWith(`${prefix} `);
  }
  if (specifier.includes("*")) return globToRegExp(specifier).test(segment);
  return segment === specifier;
}

/** 1 規則が 1 ツール呼び出しに当たるか。 */
export function ruleMatches(rule: string, toolName: string, toolInput: unknown): boolean {
  const parsed = parseRule(rule);
  if (!parsed) return false;
  if (parsed.tool !== toolName) return false;
  if (parsed.specifier === null || parsed.specifier === "*") return true;

  const input = (typeof toolInput === "object" && toolInput !== null ? toolInput : {}) as Record<string, unknown>;
  if (toolName === "Bash") {
    const command = typeof input.command === "string" ? input.command : null;
    if (!command) return false;
    // 連結コマンドは「全ての区間が当たる」 ときだけ当たったとみなす。
    const segments = splitCommandSegments(command);
    return segments.length > 0 && segments.every((segment) => bashSpecifierMatches(parsed.specifier as string, segment));
  }
  const target = typeof input.file_path === "string"
    ? input.file_path
    : typeof input.path === "string"
      ? input.path
      : typeof input.url === "string"
        ? input.url
        : null;
  if (!target) return false;
  const normalized = target.replace(/\\/g, "/");
  const specifier = (parsed.specifier as string).replace(/^\/\//, "").replace(/\\/g, "/");
  if (specifier.includes("*")) return globToRegExp(specifier).test(normalized);
  return normalized === specifier || normalized.startsWith(`${specifier}/`);
}

/**
 * deny > ask > allow の順に、 近い層から探して最初の一致を返す。
 * どれにも当たらなければ null (= 規則に載っていない)。
 */
export function matchPermissionRule(
  layers: PermissionRuleLayer[],
  toolName: string,
  toolInput: unknown,
): RuleMatch | null {
  const effects: RuleEffect[] = ["deny", "ask", "allow"];
  for (const effect of effects) {
    for (const layer of layers) {
      for (const rule of layer[effect]) {
        if (ruleMatches(rule, toolName, toolInput)) {
          return { effect, rule, source: layer.source };
        }
      }
    }
  }
  return null;
}
