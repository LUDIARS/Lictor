export interface ProviderRuntimeMetadata {
  model?: string;
  effort?: string;
}

/**
 * Extract the explicit runtime identity from the wrapped provider's CLI args.
 *
 * Concordia displays `model` and `effort` from session metadata. Lictor must
 * publish the values passed to Claude without normalizing them, because the
 * provider CLI remains authoritative for accepted identifiers and effort
 * levels. Empty values and values that are actually another option are
 * ignored. As with the CLI, a later nonempty occurrence wins.
 */
export function providerRuntimeMetadata(
  providerName: string,
  args: readonly string[],
): ProviderRuntimeMetadata {
  if (providerName !== "claude") return {};

  const metadata: ProviderRuntimeMetadata = {};
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--") break;

    const model = optionValue(arg, "--model");
    if (model !== null) {
      if (model !== "") metadata.model = model;
      continue;
    }
    if (arg === "--model") {
      const value = separateOptionValue(args[index + 1]);
      if (value !== null) {
        metadata.model = value;
        index += 1;
      }
      continue;
    }

    const effort = optionValue(arg, "--effort");
    if (effort !== null) {
      if (effort !== "") metadata.effort = effort;
      continue;
    }
    if (arg === "--effort") {
      const value = separateOptionValue(args[index + 1]);
      if (value !== null) {
        metadata.effort = value;
        index += 1;
      }
    }
  }
  return metadata;
}

function optionValue(arg: string, option: string): string | null {
  const prefix = `${option}=`;
  if (!arg.startsWith(prefix)) return null;
  const value = arg.slice(prefix.length);
  return value.trim() ? value : "";
}

function separateOptionValue(value: string | undefined): string | null {
  if (value === undefined || !value.trim() || value.startsWith("--")) return null;
  return value;
}
