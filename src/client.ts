import http from "node:http";
import { readFileSync } from "node:fs";
import { LICTOR_NAME, LICTOR_VERSION } from "./version.js";

export async function runClient(args: string[]): Promise<void> {
  const [sub, ...rest] = args;

  // `lictor cli version` must work without a sidecar — it's the same kind of
  // CLI-introspection command as `--version`, and a hook that wants to log
  // the version shouldn't fail just because no session is wrapped.
  if (sub === "version") {
    await cmdVersion(process.env.LICTOR_PORT);
    return;
  }

  const port = process.env.LICTOR_PORT;
  if (!port) {
    process.stderr.write(
      "lictor cli: LICTOR_PORT not set — this command must run under `lictor claude ...`.\n" +
        "Tip: existing Concordia hooks that bypass Lictor will keep working, but get no\n" +
        "session integration. Wrap with lictor to enable persona-aware title / chat / stat.\n",
    );
    process.exit(2);
  }

  switch (sub) {
    case "title":
      await cmdTitle(port, rest);
      return;
    case "title-auto":
      await postNoBody(port, "/v1/title/auto");
      return;
    case "rename":
      await cmdRename(port, rest);
      return;
    case "meta":
      process.stdout.write((await getText(port, "/v1/meta")) + "\n");
      return;
    case "health":
      process.stdout.write((await getText(port, "/v1/health")) + "\n");
      return;
    case "session":
      process.stdout.write((await getText(port, "/v1/concordia/session")) + "\n");
      return;
    case "chat":
      await cmdChat(port, rest);
      return;
    case "event":
      await cmdEvent(port, rest);
      return;
    case "conflicts":
      await cmdConflicts(port, rest);
      return;
    case "skill":
      await cmdSkill(port, rest);
      return;
    case "task":
      await cmdTask(port, rest);
      return;
    case "state":
      process.stdout.write((await getText(port, "/v1/lictor/state")) + "\n");
      return;
    case "slash":
      await cmdSlash(port, rest);
      return;
    case "keys":
      await cmdKeys(port, rest);
      return;
    case "answer":
      await cmdAnswer(port, rest);
      return;
    case "enter":
      await cmdKeys(port, ["\r"]);
      return;
    case "down":
      await cmdKeys(port, ["\x1b[B"]);
      return;
    case "up":
      await cmdKeys(port, ["\x1b[A"]);
      return;
    case "esc":
      await cmdKeys(port, ["\x1b"]);
      return;
    // Convenience shortcuts that map 1:1 onto common Claude Code slash commands.
    // Anything not covered here can be invoked as `lictor cli slash <cmd> [args]`.
    case "clear":
    case "compact":
    case "help":
    case "cost":
    case "export":
    case "init":
    case "model":
      await cmdSlash(port, [sub, ...rest]);
      return;
    default:
      process.stderr.write(
        `lictor cli: unknown subcommand '${sub ?? "(none)"}'.\n` +
          `Available: title, title-auto, rename, meta, health, session, chat, event, conflicts, skill, task, state, version.\n`,
      );
      process.exit(2);
  }
}

async function cmdVersion(port: string | undefined): Promise<void> {
  // 1) Wrapped session: ask the sidecar for the running version. Useful when
  //    the user has multiple lictor installs (npm link / global vs dev) and
  //    wants to verify which one this session is actually running.
  // 2) Standalone: fall back to the local CLI's version so this command never
  //    fails — `lictor cli version` should behave like `--version` from any
  //    context, including hooks that just want to log the version string.
  if (port) {
    try {
      const reply = await getText(port, "/v1/version");
      process.stdout.write(reply + "\n");
      return;
    } catch {
      // Sidecar exists but version endpoint failed (old sidecar / network).
      // Fall through to local version rather than crashing.
    }
  }
  process.stdout.write(JSON.stringify({ name: LICTOR_NAME, version: LICTOR_VERSION }) + "\n");
}

async function cmdKeys(port: string, rest: string[]): Promise<void> {
  const data = rest.join(" ");
  if (!data) {
    process.stderr.write("usage: lictor cli keys <data>\n");
    process.exit(2);
  }
  const reply = await postJsonText(port, "/v1/keys", { data });
  process.stdout.write(reply + "\n");
}

async function cmdAnswer(port: string, rest: string[]): Promise<void> {
  const n = Number(rest[0]);
  if (!Number.isInteger(n) || n < 1) {
    process.stderr.write("usage: lictor cli answer <choice-index (1-based)>\n");
    process.exit(2);
  }
  const escapeFirst = rest.includes("--escape");
  const payload: { choice: number; escape_first?: boolean } = { choice: n };
  if (escapeFirst) payload.escape_first = true;
  const reply = await postJsonText(port, "/v1/answer", payload);
  process.stdout.write(reply + "\n");
}

async function cmdSlash(port: string, rest: string[]): Promise<void> {
  const cmd = rest[0];
  if (!cmd) {
    process.stderr.write("usage: lictor cli slash <cmd> [args...]\n");
    process.exit(2);
  }
  const args = rest.slice(1).join(" ");
  const payload: { cmd: string; args?: string } = { cmd };
  if (args) payload.args = args;
  const reply = await postJsonText(port, "/v1/slash", payload);
  process.stdout.write(reply + "\n");
}

async function cmdTask(port: string, rest: string[]): Promise<void> {
  const [op, ...more] = rest;
  if (op === "get" || op === undefined) {
    process.stdout.write((await getText(port, "/v1/lictor/task")) + "\n");
    return;
  }
  if (op !== "set") {
    process.stderr.write(`lictor cli task: unknown op '${op}'. Use get | set [--branch <b>] [--desc <text>].\n`);
    process.exit(2);
  }
  // Parse --branch / --desc. Keep it minimal — no full getopts dep.
  let branch: string | undefined;
  let desc: string | undefined;
  for (let i = 0; i < more.length; i++) {
    const tok = more[i];
    if (tok === "--branch" && i + 1 < more.length) {
      branch = more[++i];
    } else if (tok === "--desc" && i + 1 < more.length) {
      // Allow trailing tokens to form the description if not quoted in shell.
      desc = more.slice(i + 1).join(" ");
      break;
    } else {
      process.stderr.write(`lictor cli task set: unexpected arg '${tok}'\n`);
      process.exit(2);
    }
  }
  if (branch === undefined && desc === undefined) {
    process.stderr.write("usage: lictor cli task set [--branch <b>] [--desc <text>]\n");
    process.exit(2);
  }
  const payload: { branch?: string; desc?: string } = {};
  if (branch !== undefined) payload.branch = branch;
  if (desc !== undefined) payload.desc = desc;
  const reply = await postJsonText(port, "/v1/lictor/task", payload);
  process.stdout.write(reply + "\n");
}

async function cmdSkill(port: string, rest: string[]): Promise<void> {
  const [op, ...more] = rest;
  if (!op || op === "list") {
    process.stdout.write((await getText(port, "/v1/skill")) + "\n");
    return;
  }
  if (op === "set") {
    const name = more[0];
    const file = more[1];
    if (!name || !file) {
      process.stderr.write("usage: lictor cli skill set <name> <markdown-file>\n");
      process.exit(2);
    }
    let content: string;
    try {
      content = readFileSync(file, "utf8");
    } catch (err) {
      process.stderr.write(`lictor cli skill set: cannot read ${file}: ${(err as Error).message}\n`);
      process.exit(2);
    }
    await postJson(port, "/v1/skill", { name, content });
    return;
  }
  if (op === "delete" || op === "rm") {
    const name = more[0];
    if (!name) {
      process.stderr.write("usage: lictor cli skill delete <name>\n");
      process.exit(2);
    }
    const { status, body } = await request(port, "DELETE", `/v1/skill/${encodeURIComponent(name)}`);
    process.stdout.write(body + "\n");
    if (status !== 200) process.exit(1);
    return;
  }
  process.stderr.write(
    `lictor cli skill: unknown op '${op}'. Use list | set <name> <file> | delete <name>.\n`,
  );
  process.exit(2);
}

async function cmdTitle(port: string, rest: string[]): Promise<void> {
  const text = rest.join(" ");
  if (!text) {
    process.stderr.write("usage: lictor cli title <text>\n");
    process.exit(2);
  }
  await postJson(port, "/v1/title", { text });
}

async function cmdRename(port: string, rest: string[]): Promise<void> {
  const text = rest.join(" ");
  if (!text) {
    process.stderr.write("usage: lictor cli rename <text>\n");
    process.exit(2);
  }
  await postJson(port, "/v1/rename", { text });
}

async function cmdChat(port: string, rest: string[]): Promise<void> {
  const channel = rest[0];
  const text = rest.slice(1).join(" ");
  if (!channel || !text) {
    process.stderr.write("usage: lictor cli chat <channel> <text...>\n");
    process.exit(2);
  }
  const reply = await postJsonText(port, "/v1/chat", { channel, text });
  process.stdout.write(reply + "\n");
}

async function cmdEvent(port: string, rest: string[]): Promise<void> {
  const kind = rest[0];
  if (!kind) {
    process.stderr.write("usage: lictor cli event <kind> [json-payload]\n");
    process.exit(2);
  }
  let payload: unknown = undefined;
  if (rest[1]) {
    try {
      payload = JSON.parse(rest.slice(1).join(" "));
    } catch (err) {
      process.stderr.write(`lictor cli event: payload must be valid JSON (${(err as Error).message})\n`);
      process.exit(2);
    }
  }
  const reply = await postJsonText(port, "/v1/event", { kind, payload });
  process.stdout.write(reply + "\n");
}

async function cmdConflicts(port: string, rest: string[]): Promise<void> {
  const params = new URLSearchParams();
  if (rest[0]) params.set("repo", rest[0]);
  if (rest[1]) params.set("branch", rest[1]);
  const qs = params.toString();
  const path = qs ? `/v1/conflicts?${qs}` : "/v1/conflicts";
  process.stdout.write((await getText(port, path)) + "\n");
}

function postJson(port: string, path: string, payload: unknown): Promise<void> {
  const body = JSON.stringify(payload);
  return request(port, "POST", path, body).then(({ status, body: text }) => {
    if (status !== 200) throw new Error(`HTTP ${status}: ${text}`);
  });
}

function postJsonText(port: string, path: string, payload: unknown): Promise<string> {
  const body = JSON.stringify(payload);
  return request(port, "POST", path, body).then(({ status, body: text }) => {
    if (status !== 200) throw new Error(`HTTP ${status}: ${text}`);
    return text;
  });
}

function postNoBody(port: string, path: string): Promise<void> {
  return request(port, "POST", path).then(({ status, body }) => {
    if (status !== 200) throw new Error(`HTTP ${status}: ${body}`);
  });
}

function getText(port: string, path: string): Promise<string> {
  return request(port, "GET", path).then(({ status, body }) => {
    if (status !== 200) throw new Error(`HTTP ${status}: ${body}`);
    return body;
  });
}

interface ResponseLite {
  status: number;
  body: string;
}

function request(
  port: string,
  method: string,
  path: string,
  body?: string,
): Promise<ResponseLite> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port: Number(port),
        path,
        method,
        headers:
          body !== undefined
            ? {
                "content-type": "application/json",
                "content-length": Buffer.byteLength(body),
              }
            : undefined,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => {
          resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") });
        });
      },
    );
    req.on("error", reject);
    if (body !== undefined) req.end(body);
    else req.end();
  });
}
