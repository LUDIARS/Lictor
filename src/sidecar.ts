import http from "node:http";
import type { AddressInfo } from "node:net";
import { setTitle } from "./osc.js";
import type { Meta } from "./meta.js";

export interface Sidecar {
  port: number;
  close: () => void;
}

export async function startSidecar(meta: Meta): Promise<Sidecar> {
  const server = http.createServer((req, res) => {
    // Hard guard: only accept loopback connections.
    const remote = req.socket.remoteAddress ?? "";
    if (remote !== "127.0.0.1" && remote !== "::1" && remote !== "::ffff:127.0.0.1") {
      res.writeHead(403);
      res.end('{"error":"loopback only"}');
      return;
    }

    if (req.method === "GET" && req.url === "/v1/health") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end('{"ok":true}');
      return;
    }

    if (req.method === "GET" && req.url === "/v1/meta") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(meta));
      return;
    }

    if (req.method === "POST" && req.url === "/v1/title") {
      collectJson(req, (err, body) => {
        if (err) {
          res.writeHead(400, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: err.message }));
          return;
        }
        const text = body && typeof body === "object" ? (body as { text?: unknown }).text : undefined;
        if (typeof text !== "string") {
          res.writeHead(400, { "content-type": "application/json" });
          res.end('{"error":"body.text (string) is required"}');
          return;
        }
        setTitle(text);
        res.writeHead(200, { "content-type": "application/json" });
        res.end('{"ok":true}');
      });
      return;
    }

    res.writeHead(404, { "content-type": "application/json" });
    res.end('{"error":"not found"}');
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address() as AddressInfo | null;
      if (!addr) {
        reject(new Error("failed to bind sidecar"));
        return;
      }
      resolve({
        port: addr.port,
        close: () => {
          try {
            server.close();
          } catch {
            // best-effort
          }
        },
      });
    });
  });
}

function collectJson(
  req: http.IncomingMessage,
  cb: (err: Error | null, body: unknown) => void,
): void {
  const chunks: Buffer[] = [];
  let total = 0;
  const MAX = 64 * 1024; // 64 KiB cap
  req.on("data", (c: Buffer) => {
    total += c.length;
    if (total > MAX) {
      req.destroy();
      cb(new Error("body too large"), null);
      return;
    }
    chunks.push(c);
  });
  req.on("end", () => {
    const raw = Buffer.concat(chunks).toString("utf8");
    if (!raw) {
      cb(null, {});
      return;
    }
    try {
      cb(null, JSON.parse(raw));
    } catch {
      cb(new Error("invalid JSON"), null);
    }
  });
  req.on("error", (e) => cb(e, null));
}
