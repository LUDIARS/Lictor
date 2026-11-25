import type { ProviderConfig } from "./provider.js";
import { contract } from './contracts/contract-runtime.js'; /* augur-inject:import:ccf6726a */
import augurContract_d4228bc5 from './contracts/grok-transcript-pin.contract.js'; /* augur-inject:contract-predicate:7f8c09b5 */

export interface GrokTranscriptPin {
  args: string[];
  path: string;
}

export function resolveGrokTranscriptPin(
  provider: ProviderConfig,
  args: readonly string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
  createUuid: () => string,
): GrokTranscriptPin | null {
  if (provider.name !== "grok" || !provider.supportsSessionPin
    || !provider.sessionPinArgs || !provider.pinnedTranscriptFile) return null;

  const separator = args.indexOf("--");
  const options = separator === -1 ? args : args.slice(0, separator);
  let hasExplicitId = false;
  let explicitId: string | undefined;
  let hasResumeOption = false;
  for (const [index, arg] of options.entries()) {
    const equals = arg.indexOf("=");
    const option = equals < 0 ? arg : arg.slice(0, equals);
    switch (option) {
      case "-s":
      case "--session-id":
        if (!hasExplicitId) explicitId = equals < 0 ? options[index + 1] : arg.slice(equals + 1);
        hasExplicitId = true;
        break;
      case "-r":
      case "--resume":
      case "-c":
      case "--continue":
      case "--fork-session":
        hasResumeOption = true;
        break;
    }
  }
  if (hasExplicitId) {
    if (!explicitId || provider.extractSessionId(explicitId) !== explicitId) return null;
    const path = provider.pinnedTranscriptFile(cwd, explicitId, env);
    return path ? { args: [], path } : null;
  }
  if (hasResumeOption) return null;

  const uuid = createUuid();
  const path = provider.pinnedTranscriptFile(cwd, uuid, env);
  return path ? { args: provider.sessionPinArgs(uuid), path } : null;
}
// @ts-expect-error augur-inject
resolveGrokTranscriptPin = contract(resolveGrokTranscriptPin, { ...augurContract_d4228bc5, contractId: 'C-16', mode: 'observe', sample: 1, where: 'src/grok-transcript-pin.ts:8', rule: 'contract-wrap', id: 'd4228bc5' }); /* augur-inject:contract-wrap:d4228bc5 */
