import { isDeepStrictEqual } from "node:util";
import type { GrokTranscriptPin } from "../grok-transcript-pin.js";
import type { ProviderConfig } from "../provider.js";

export default {
  post(
    result: GrokTranscriptPin | null,
    provider: ProviderConfig,
    args: readonly string[],
    cwd: string,
    env: NodeJS.ProcessEnv,
  ): true | string {
    if (provider.name !== "grok" || !provider.supportsSessionPin) {
      return result === null || "applied Grok session pin to another provider";
    }
    const separator = args.indexOf("--");
    const options = separator < 0 ? args : args.slice(0, separator);
    const explicit = options.findIndex((arg) => /^(?:-s|--session-id)(?:=|$)/.test(arg));
    if (explicit >= 0) {
      const arg = options[explicit];
      const id = arg.includes("=") ? arg.slice(arg.indexOf("=") + 1) : options[explicit + 1];
      const uuid = id && provider.extractSessionId(id) === id ? id : null;
      const path = uuid ? provider.pinnedTranscriptFile?.(cwd, uuid, env) ?? null : null;
      const expected = path ? { args: [], path } : null;
      return isDeepStrictEqual(result, expected) || "explicit Grok session ID was not preserved";
    }
    if (options.some((arg) => /^(?:-r|--resume|-c|--continue|--fork-session)(?:=|$)/.test(arg))) {
      return result === null || "resume or fork flags must suppress automatic Grok session IDs";
    }
    const uuid = result?.args[1];
    return (!!uuid && provider.extractSessionId(uuid) === uuid
      && result?.args.length === 2 && result.args[0] === "--session-id"
      && result.path === provider.pinnedTranscriptFile?.(cwd, uuid, env))
      || "new Grok session must use one UUID for both the CLI and the transcript";
  },
};
