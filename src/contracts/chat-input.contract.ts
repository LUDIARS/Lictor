import { TextDecoder } from "node:util";

// Fixed diagnostics only: never include source bytes, paths, or decoded text.
export default {
  post: (result: { text: string } | { error: string }, bytes: Uint8Array): true | string => {
    let expected: string;
    try {
      expected = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
    } catch {
      return "error" in result && result.error === "invalid_utf8"
        ? true : "invalid UTF-8 rejection mismatch";
    }
    if (expected.startsWith("\uFEFF")) expected = expected.slice(1);
    if (!expected.trim()) {
      return "error" in result && result.error === "empty_text"
        ? true : "empty text rejection mismatch";
    }
    return "text" in result && result.text === expected ? true : "chat text preservation mismatch";
  },
};
