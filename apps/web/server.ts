// Dev-сервер веб-интерфейса AnimForge: Vite (страница) + API из routes.ts поверх настоящего диска.
// Тот же routes.ts работает и на сайте — в Service Worker поверх файловой системы в памяти браузера (sw/sw.ts).
import { watch, type FSWatcher } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer as createVite } from "vite";
import { failure, handle, projectDir, type Reply } from "./routes.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT ?? 5178);

// Слежение за animforge.json: один fs.watch на папку, рассылка всем подписчикам SSE.
interface Watch {
  watcher: FSWatcher;
  clients: Set<ServerResponse>;
  timer?: NodeJS.Timeout;
}
const watchers = new Map<string, Watch>();

function startWatch(dir: string): Watch {
  const clients = new Set<ServerResponse>();
  const w: Watch = {
    clients,
    // следим за папкой, а не за файлом: редакторы и git часто заменяют файл целиком
    watcher: watch(dir, (_ev, name) => {
      if (name && name !== "animforge.json") return;
      clearTimeout(w.timer);
      w.timer = setTimeout(() => {
        for (const c of clients) c.write(`event: change\ndata: ${JSON.stringify({ at: Date.now() })}\n\n`);
      }, 60);
    }),
  };
  return w;
}

function subscribe(dir: string, res: ServerResponse) {
  let w = watchers.get(dir);
  if (!w) watchers.set(dir, (w = startWatch(dir)));
  const entry = w;
  entry.clients.add(res);
  return () => {
    entry.clients.delete(res);
    if (entry.clients.size === 0) {
      clearTimeout(entry.timer);
      entry.watcher.close();
      watchers.delete(dir);
    }
  };
}


async function readRaw(req: IncomingMessage): Promise<Uint8Array> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > 300 << 20) throw new Error("файл больше 300 МБ");
    chunks.push(c as Buffer);
  }
  return Buffer.concat(chunks);
}

function send(res: ServerResponse, r: Reply) {
  if ("json" in r) {
    res.writeHead(r.status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
    return res.end(JSON.stringify(r.json));
  }
  res.writeHead(r.status, {
    "content-type": r.type,
    "cache-control": "no-store",
    ...(r.filename ? { "content-disposition": `attachment; filename*=UTF-8''${encodeURIComponent(r.filename)}` } : {}),
  });
  res.end(Buffer.from(r.bytes));
}

async function api(req: IncomingMessage, res: ServerResponse, url: URL) {
  if (req.method === "GET" && url.pathname === "/api/events") {
    // живое обновление — только у сервера: на сайте проект меняет лишь сама страница
    const dir = projectDir(url.searchParams.get("dir"));
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store", connection: "keep-alive" });
    res.write(`event: hello\ndata: {}\n\n`);
    const unsubscribe = subscribe(dir, res);
    const ping = setInterval(() => res.write(`: ping\n\n`), 25000);
    req.on("close", () => {
      clearInterval(ping);
      unsubscribe();
    });
    return;
  }
  const headers = Object.fromEntries(Object.entries(req.headers).map(([k, v]) => [k, Array.isArray(v) ? v[0] : v]));
  send(res, await handle({ method: req.method ?? "GET", url, headers, body: await readRaw(req) }));
}

const http = createServer();
const vite = await createVite({
  root: HERE,
  configFile: join(HERE, "vite.config.ts"),
  server: { middlewareMode: true, hmr: { server: http } },
  appType: "spa",
});

http.on("request", (req, res) => {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
  if (!url.pathname.startsWith("/api/")) return vite.middlewares(req, res);
  api(req, res, url).catch((e) => {
    if (res.headersSent) return res.end();
    send(res, failure(e));
  });
});

http.listen(PORT, "127.0.0.1", () => {
  console.log(`AnimForge web: http://localhost:${PORT}/?dir=projects/fish-demo`);
});
