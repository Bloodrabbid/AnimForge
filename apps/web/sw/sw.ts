// Service Worker сайта AnimForge: «сервер» внутри браузера. Перехватывает запросы страницы к api/… и отвечает тем же
// обработчиком, что dev-сервер (routes.ts), только диск — в памяти (memfs, корень /af).
//
//   страница ──fetch api/…──▶ sw.ts ──▶ routes.handle ──▶ ядро и CLI (call, loadCtx) ──▶ memfs /af
//                                                                                      ▲
//            data/manifest.json + файлы (библиотека, демо-проекты) ───при старте──────┤
//            IndexedDB (проекты, которые правили в этом браузере) ───поверх──────────┘
//
// Паки клипов (десятки МБ) докачиваются только когда нужны (env.ensure).
import "./shims/globals.ts";
import { dirname, join, relative } from "node:path";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { env, failure, handle, type Reply } from "../routes.ts";

declare const self: ServiceWorkerGlobalScope;

const ROOT = "/af";
const BASE = new URL("./", self.location.href); // папка сайта: /AnimForge/ на GitHub Pages
interface Manifest {
  version: string;
  eager: string[]; // пути от корня репозитория — грузим сразу
  lazy: string[]; // большие файлы — по требованию
}
let manifest: Manifest;

// ── хранилище браузера: проект целиком (все файлы папки) под ключом «папка от корня» ─────────────────────────
const DB = "animforge";
function db(): Promise<IDBDatabase> {
  return new Promise((ok, fail) => {
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => r.result.createObjectStore("dirs");
    r.onsuccess = () => ok(r.result);
    r.onerror = () => fail(r.error);
  });
}
async function tx<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const d = await db();
  return new Promise((ok, fail) => {
    const r = fn(d.transaction("dirs", mode).objectStore("dirs"));
    r.onsuccess = () => ok(r.result);
    r.onerror = () => fail(r.error);
  });
}

function walk(dir: string, out: [string, Uint8Array][] = [], base = dir) {
  for (const name of readdirSync(dir) as string[]) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out, base);
    else out.push([relative(base, p), new Uint8Array(readFileSync(p))]);
  }
  return out;
}

async function save(dir: string) {
  const rel = relative(ROOT, dir);
  if (!existsSync(dir)) return void (await tx("readwrite", (s) => s.delete(rel)));
  await tx("readwrite", (s) => s.put(walk(dir), rel));
}

async function restore() {
  const keys = (await tx("readonly", (s) => s.getAllKeys())) as string[];
  for (const rel of keys) {
    const files = (await tx("readonly", (s) => s.get(rel))) as [string, Uint8Array][];
    for (const [f, bytes] of files) {
      const p = join(ROOT, rel, f);
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, bytes);
    }
  }
}

// ── наполнение файловой системы ──────────────────────────────────────────────────────────────────────────────
async function fetchInto(rel: string) {
  const r = await fetch(new URL(`data/${rel}?v=${manifest.version}`, BASE));
  if (!r.ok) throw new Error(`не скачался ${rel}: HTTP ${r.status}`);
  const p = join(ROOT, rel);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, new Uint8Array(await r.arrayBuffer()));
}

let ready: Promise<void> | undefined;
function boot() {
  return (ready ??= (async () => {
    mkdirSync("/tmp", { recursive: true }); // временные папки экспорта и упаковки
    manifest = await (await fetch(new URL("data/manifest.json", BASE), { cache: "no-store" })).json();
    for (let i = 0; i < manifest.eager.length; i += 16) await Promise.all(manifest.eager.slice(i, i + 16).map(fetchInto));
    await restore();
  })().catch((e) => {
    ready = undefined; // следующая попытка — заново
    throw e;
  }));
}

const loading = new Map<string, Promise<void>>();
env.ensure = async (abs) => {
  if (existsSync(abs)) return;
  const rel = relative(ROOT, abs);
  if (!manifest.lazy.includes(rel)) return;
  if (!loading.has(rel)) loading.set(rel, fetchInto(rel).finally(() => loading.delete(rel)));
  await loading.get(rel);
};
env.changed = save;
// демо-проекты: папки из списка «по требованию»; открытый или правленный (восстановлен из IndexedDB) — уже на месте
const lazyDirs = () => [...new Set(manifest.lazy.filter((f) => f.startsWith("projects/")).map((f) => f.split("/").slice(0, 2).join("/")))];
env.projects = lazyDirs;
const dirLoading = new Map<string, Promise<void>>();
env.ensureDir = async (rel) => {
  if (!lazyDirs().includes(rel) || existsSync(join(ROOT, rel, "animforge.json"))) return;
  if (!dirLoading.has(rel)) dirLoading.set(rel, Promise.all(manifest.lazy.filter((f) => f.startsWith(rel + "/")).map(fetchInto)).then(() => {}).finally(() => dirLoading.delete(rel)));
  await dirLoading.get(rel);
};
// своя модель без Blender: готовый glb со скелетом — как есть, остальное (FBX, OBJ, авториг) — только локально
env.newProject = async (dir, file, name) => {
  const { call } = await import("../../../packages/cli/src/node.ts");
  if (!/\.glb$/i.test(file)) throw new Error("На сайте открываются только .glb со скелетом. FBX, DAE и модели без скелета — в локальной версии (нужен Blender).");
  mkdirSync(join(dir, "assets"), { recursive: true });
  writeFileSync(join(dir, "assets/model.glb"), readFileSync(file));
  await call(dir, "init", { model: "assets/model.glb", name });
  const { loadCtx } = await import("../../../packages/cli/src/node.ts");
  if (!(await loadCtx(dir)).skeleton.nodes.some((n) => n.isJoint)) {
    const { rmSync } = await import("node:fs");
    rmSync(dir, { recursive: true, force: true });
    throw new Error("В модели нет скелета. Авториг нужен Blender — он есть в локальной версии AnimForge.");
  }
  const detect = (await call(dir, "rig.detect", {})) as { body?: string };
  return { detect };
};

function toResponse(r: Reply): Response {
  if ("json" in r) return new Response(JSON.stringify(r.json), { status: r.status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });
  const headers: Record<string, string> = { "content-type": r.type, "cache-control": "no-store" };
  if (r.filename) headers["content-disposition"] = `attachment; filename*=UTF-8''${encodeURIComponent(r.filename)}`;
  return new Response(r.bytes as BodyInit, { status: r.status, headers });
}

async function serve(request: Request): Promise<Response> {
  try {
    await boot();
    const url = new URL(request.url);
    if (url.pathname.endsWith("/api/events")) return new Response(null, { status: 204 });
    const body = request.method === "GET" || request.method === "HEAD" ? new Uint8Array() : new Uint8Array(await request.arrayBuffer());
    const headers = Object.fromEntries(request.headers.entries());
    return toResponse(await handle({ method: request.method, url, headers, body }));
  } catch (e) {
    return toResponse(failure(e));
  }
}

self.addEventListener("install", () => void self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));
self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (url.origin !== self.location.origin || !url.pathname.startsWith(BASE.pathname + "api/")) return;
  e.respondWith(serve(e.request));
});
