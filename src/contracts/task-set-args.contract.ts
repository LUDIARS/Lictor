import { isAbsolute } from "node:path";

type Parse = { ok: true; payload: { repo?: string; branch?: string; desc?: string } }
  | { ok: false; help: true; usage: string } | { ok: false; help?: false; error: string };

// Fixed diagnostics only: never include paths or descriptions.
export default {
  post: (result: Parse, args: readonly string[]): true | string => {
    if (args.some((a, i) => (a === "--help" || a === "-h") && !args.slice(0, i).includes("--desc"))) {
      return !result.ok && result.help === true && result.usage.includes("--repo") ? true : "help usage mismatch";
    }
    if (!result.ok) {
      if (result.help) return "unexpected help";
      return result.error.includes("--repo") ? true : "rejection without usage";
    }
    const p = result.payload;
    if (p.repo !== undefined && !isAbsolute(p.repo)) return "repo not absolute";
    const d = args.indexOf("--desc");
    if (d >= 0 && p.desc !== args.slice(d + 1).join(" ")) return "desc did not take trailing words";
    return true;
  },
};
