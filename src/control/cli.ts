import http from "node:http";
import { DEFAULT_CONTROL_PORT, startControlServer } from "./server.js";
import { readToken } from "./token.js";

const HELP = `lictor control — long-lived orchestrator daemon

Usage:
  lictor control start [--port <p>]    Run the control daemon (long-lived).
                                       Generates ~/.claude/lictor/control.token
                                       on first run.
  lictor control spawn [opts...]       Ask the daemon to launch a new wrapped
                                       session. Options:
                                         --provider {claude|codex} (default claude)
                                         --mode {tab|window}       (default tab)
                                         --cwd <path>
                                         --title <text>
                                         --port <p>                (default ${DEFAULT_CONTROL_PORT})
                                         -- <args>...              passed to provider
  lictor control sessions              List recently spawned sessions (last 50).
  lictor control health                Ping the daemon.
`;

export async function runControl(args: string[]): Promise<void> {
  const [sub, ...rest] = args;
  switch (sub) {
    case undefined:
    case "--help":
    case "-h":
      process.stdout.write(HELP);
      return;
    case "start":
      await cmdStart(rest);
      return;
    case "spawn":
      await cmdSpawn(rest);
      return;
    case "sessions":
      await cmdGet(rest, "/v1/sessions");
      return;
    case "health":
      await cmdGet(rest, "/v1/health");
      return;
    default:
      process.stderr.write(`lictor control: unknown subcommand '${sub}'\n\n${HELP}`);
      process.exit(2);
  }
}

async function cmdStart(rest: string[]): Promise<void> {
  const port = takeNumberFlag(rest, "--port") ?? DEFAULT_CONTROL_PORT;
  const server = await startControlServer({ port });
  process.stdout.write(
    `lictor control: listening on 127.0.0.1:${server.port}\n` +
      `lictor control: token written to ~/.claude/lictor/control.token\n` +
      `lictor control: Ctrl-C to stop\n`,
  );
  // Keep alive — server is the only ref holder. Ignore SIGINT/SIGTERM so the
  // user sees one clean shutdown line.
  const shutdown = (sig: NodeJS.Signals) => {
    process.stdout.write(`lictor control: shutting down (${sig})\n`);
    server.close();
    process.exit(0);
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

interface SpawnArgs {
  provider: "claude" | "codex";
  mode: "tab" | "window";
  cwd?: string;
  title?: string;
  args: string[];
  port: number;
}

function parseSpawnArgs(rest: string[]): SpawnArgs {
  const args: SpawnArgs = {
    provider: "claude",
    mode: "tab",
    args: [],
    port: DEFAULT_CONTROL_PORT,
  };
  for (let i = 0; i < rest.length; i++) {
    const tok = rest[i];
    if (tok === "--provider") {
      const v = rest[++i];
      if (v !== "claude" && v !== "codex") throw new Error(`--provider must be claude|codex (got ${v})`);
      args.provider = v;
    } else if (tok === "--mode") {
      const v = rest[++i];
      if (v !== "tab" && v !== "window") throw new Error(`--mode must be tab|window (got ${v})`);
      args.mode = v;
    } else if (tok === "--cwd") {
      args.cwd = rest[++i];
    } else if (tok === "--title") {
      args.title = rest[++i];
    } else if (tok === "--port") {
      const v = Number(rest[++i]);
      if (!Number.isFinite(v) || v < 1 || v > 65535) throw new Error(`--port must be 1-65535`);
      args.port = v;
    } else if (tok === "--") {
      args.args = rest.slice(i + 1);
      break;
    } else {
      throw new Error(`unexpected arg '${tok}' (use -- before provider args)`);
    }
  }
  return args;
}

async function cmdSpawn(rest: string[]): Promise<void> {
  let parsed: SpawnArgs;
  try {
    parsed = parseSpawnArgs(rest);
  } catch (err) {
    process.stderr.write(`lictor control spawn: ${(err as Error).message}\n`);
    process.exit(2);
  }
  const token = readToken();
  if (!token) {
    process.stderr.write(
      `lictor control spawn: no token at ~/.claude/lictor/control.token.\n` +
        `Start the daemon once with \`lictor control start\` to generate one.\n`,
    );
    process.exit(2);
  }
  const body = JSON.stringify({
    provider: parsed.provider,
    mode: parsed.mode,
    cwd: parsed.cwd,
    title: parsed.title,
    args: parsed.args,
  });
  const reply = await postJson(parsed.port, "/v1/spawn", body, token);
  process.stdout.write(reply + "\n");
}

async function cmdGet(rest: string[], path: string): Promise<void> {
  const port = takeNumberFlag(rest, "--port") ?? DEFAULT_CONTROL_PORT;
  const token = readToken();
  if (path !== "/v1/health" && !token) {
    process.stderr.write(`lictor control: no token. Start the daemon to generate one.\n`);
    process.exit(2);
  }
  const reply = await getText(port, path, token);
  process.stdout.write(reply + "\n");
}

function takeNumberFlag(rest: string[], flag: string): number | null {
  const i = rest.indexOf(flag);
  if (i < 0) return null;
  const v = Number(rest[i + 1]);
  if (!Number.isFinite(v) || v < 1 || v > 65535) return null;
  // Mutate in place so subsequent parsing doesn't trip.
  rest.splice(i, 2);
  return v;
}

function postJson(port: number, path: string, body: string, token: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port,
        path,
        method: "POST",
        headers: {
          "content-type": "application/json",
          "content-length": Buffer.byteLength(body),
          authorization: `Bearer ${token}`,
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          if (res.statusCode === 200) resolve(text);
          else reject(new Error(`HTTP ${res.statusCode}: ${text}`));
        });
      },
    );
    req.on("error", reject);
    req.end(body);
  });
}

function getText(port: number, path: string, token: string | null): Promise<string> {
  return new Promise((resolve, reject) => {
    const headers: http.OutgoingHttpHeaders = {};
    if (token) headers.authorization = `Bearer ${token}`;
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port,
        path,
        method: "GET",
        headers,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          if (res.statusCode === 200) resolve(text);
          else reject(new Error(`HTTP ${res.statusCode}: ${text}`));
        });
      },
    );
    req.on("error", reject);
    req.end();
  });
}
