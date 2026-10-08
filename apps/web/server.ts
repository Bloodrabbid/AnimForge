// Dev-сервер веб-интерфейса AnimForge: Vite (страница) + маленький API поверх тех же адаптеров, что у CLI.
// Логики анимации здесь нет: проект читается через loadCtx, любое действие — call() из packages/cli/src/node.ts.
import { createReadStream, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, watch, type FSWatcher } from "node:fs";
import { tmpdir } from "node:os";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer as createVite } from "vite";
import { RECIPES, ROOT, call, dryRun, exportGlb, loadCtx, loadPresets, projectFile } from "../../packages/cli/src/node.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT ?? 5178);

/** Папка проекта из запроса — только внутри репозитория и только там, где лежит animforge.json. */
function projectDir(raw: string | null): string {
  if (!raw) throw new HttpError(400, "нужен параметр dir, например projects/fish-demo");
  const dir = resolve(ROOT, raw);
  if (dir !== ROOT && !dir.startsWith(ROOT + sep)) throw new HttpError(400, "dir должен быть внутри репозитория");
  if (!existsSync(projectFile(dir))) throw new HttpError(404, `нет проекта: ${relative(ROOT, dir)}/animforge.json`);
  return dir;
}

class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

function sendJson(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
}

async function readBody(req: IncomingMessage): Promise<any> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const text = Buffer.concat(chunks).toString("utf8");
  try {
    return text ? JSON.parse(text) : {};
  } catch {
    throw new HttpError(400, "тело запроса — не JSON");
  }
}

// Команды выполняются строго по очереди: каждая читает файл, меняет и пишет — параллельные затёрли бы друг друга.
let queue: Promise<unknown> = Promise.resolve();
function serial<T>(fn: () => Promise<T>): Promise<T> {
  const p = queue.then(fn, fn);
  queue = p.catch(() => {});
  return p;
}

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

async function api(req: IncomingMessage, res: ServerResponse, url: URL) {
  const path = url.pathname;
  if (req.method === "GET" && path === "/api/project") {
    const dir = projectDir(url.searchParams.get("dir"));
    const ctx = await loadCtx(dir);
    return sendJson(res, 200, { dir: relative(ROOT, dir), project: ctx.project, skeleton: ctx.skeleton });
  }
  if (req.method === "POST" && path === "/api/command") {
    const body = await readBody(req);
    const dir = projectDir(body.dir);
    if (typeof body.name !== "string") throw new HttpError(400, "нужно имя команды: name");
    try {
      const result = await serial(() => call(dir, body.name, body.args ?? {}));
      return sendJson(res, 200, { ok: true, result });
    } catch (e: any) {
      return sendJson(res, 400, { ok: false, error: String(e?.message ?? e) });
    }
  }
  if (req.method === "POST" && path === "/api/preview") {
    // примерка: шаги выполняются на копии проекта (body.project или с диска), ответ — получившийся проект, диск не трогается
    const body = await readBody(req);
    const dir = projectDir(body.dir);
    try {
      const r = await serial(() => dryRun(dir, body.steps ?? [], body.project));
      return sendJson(res, 200, { ok: true, ...r });
    } catch (e: any) {
      return sendJson(res, 400, { ok: false, error: String(e?.message ?? e) });
    }
  }
  if (req.method === "GET" && path === "/api/library") {
    // пресеты с происхождением и что нужно рецепту от скелета: роли → цепочки
    const lib = loadPresets().map((l) => {
      const def = RECIPES[l.recipe];
      const roles = def?.roles
        ? Object.fromEntries(Object.entries(def.roles).map(([role, r]) => [role, { chain: typeof r.chain === "function" ? r.chain("r") : r.chain, optional: !!r.optional }]))
        : null;
      return { recipe: l.recipe, help: def?.help ?? "", roles, presets: l.presets };
    });
    return sendJson(res, 200, lib);
  }
  if (req.method === "GET" && path === "/api/projects") {
    // все проекты внутри репозитория: projects/* и out/*/* (тестовые с чужими моделями)
    const found: string[] = [];
    const scan = (rel: string, depth: number) => {
      const abs = join(ROOT, rel);
      if (!existsSync(abs)) return;
      for (const e of readdirSync(abs, { withFileTypes: true })) {
        if (!e.isDirectory() || e.name.startsWith(".") || e.name === "node_modules") continue;
        const r = `${rel}/${e.name}`;
        if (existsSync(projectFile(join(ROOT, r)))) found.push(r);
        else if (depth > 1) scan(r, depth - 1);
      }
    };
    scan("projects", 1);
    scan("out", 2);
    return sendJson(res, 200, found);
  }
  if (req.method === "GET" && path === "/api/download") {
    // запечь все клипы в glb и отдать файлом
    const dir = projectDir(url.searchParams.get("dir"));
    const tmp = mkdtempSync(join(tmpdir(), "af-dl-"));
    try {
      const ctx = await loadCtx(dir);
      const out = join(tmp, `${ctx.project.name || "animforge"}.glb`);
      await serial(() => exportGlb(ctx, out));
      res.writeHead(200, {
        "content-type": "model/gltf-binary",
        "content-disposition": `attachment; filename*=UTF-8''${encodeURIComponent(ctx.project.name || "animforge")}.glb`,
        "cache-control": "no-store",
      });
      res.end(readFileSync(out));
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
    return;
  }
  if (req.method === "GET" && path === "/api/model") {
    const dir = projectDir(url.searchParams.get("dir"));
    const project = JSON.parse(readFileSync(projectFile(dir), "utf8"));
    const file = resolve(dir, project.model);
    if (!existsSync(file)) throw new HttpError(404, `нет модели ${project.model}`);
    res.writeHead(200, { "content-type": "model/gltf-binary", "cache-control": "no-store" });
    createReadStream(file).pipe(res);
    return;
  }
  if (req.method === "GET" && path === "/api/events") {
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
  throw new HttpError(404, `нет такого API: ${req.method} ${path}`);
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
    sendJson(res, e instanceof HttpError ? e.status : 500, { ok: false, error: String(e?.message ?? e) });
  });
});

http.listen(PORT, "127.0.0.1", () => {
  console.log(`AnimForge web: http://localhost:${PORT}/?dir=projects/fish-demo`);
});
