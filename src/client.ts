import http from "node:http";

export async function runClient(args: string[]): Promise<void> {
  const [sub, ...rest] = args;

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
    default:
      process.stderr.write(
        `lictor cli: unknown subcommand '${sub ?? "(none)"}'.\n` +
          `Available: title, title-auto, meta, health, session, chat, event, conflicts.\n`,
      );
      process.exit(2);
  }
}

async function cmdTitle(port: string, rest: string[]): Promise<void> {
  const text = rest.join(" ");
  if (!text) {
    process.stderr.write("usage: lictor cli title <text>\n");
    process.exit(2);
  }
  await postJson(port, "/v1/title", { text });
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
