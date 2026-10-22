// Проверка собранного сайта (out/site) в настоящем Chrome, как на GitHub Pages — из подпапки /AnimForge/:
// страница поднимает Service Worker, грузит демо-модель, выполняет команды ядра в браузере, отдаёт glb.
//   pnpm site && pnpm site:check     (печатает SITE_CHECK_OK или первую ошибку)
import { createServer } from "node:http";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { extname, join, normalize } from "node:path";
import { chromium } from "playwright-core";
import { ROOT } from "../../packages/cli/src/node.ts";

const SITE = join(ROOT, "out/site");
const TYPES: Record<string, string> = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".glb": "model/gltf-binary" };
const http = createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://x");
  if (!url.pathname.startsWith("/AnimForge/")) return void res.writeHead(404).end(); // как Pages: всё сайта — под /AnimForge/
  let f = normalize(join(SITE, decodeURIComponent(url.pathname.slice("/AnimForge/".length))));
  if (existsSync(f) && statSync(f).isDirectory()) f = join(f, "index.html");
  if (!f.startsWith(SITE) || !existsSync(f)) return void res.writeHead(404).end();
  res.writeHead(200, { "content-type": TYPES[extname(f)] ?? "application/octet-stream" }).end(readFileSync(f));
});
await new Promise<void>((ok) => http.listen(5281, "127.0.0.1", ok));

const exe = process.env.CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
// свой профиль: второй запуск браузера с ним проверяет, что правки пережили смерть Service Worker (лежат в IndexedDB)
const profile = mkdtempSync(join(tmpdir(), "af-site-"));
const open = () => chromium.launchPersistentContext(profile, { executablePath: exe, headless: true, viewport: { width: 1400, height: 900 } });
let ctx = await open();
const errors: string[] = [];
let failed = "";
try {
  let page = ctx.pages()[0] ?? (await ctx.newPage());
  page.on("pageerror", (e) => errors.push(`страница: ${e.message}`));
  page.on("console", (m) => m.type() === "error" && !m.text().startsWith("Failed to load resource") && errors.push(`консоль: ${m.text()}`)); // коды ответов проверяют шаги
  const base = "http://127.0.0.1:5281/AnimForge/";
  await page.goto(`${base}?dir=projects/worker-demo`);
  await page.waitForFunction(() => document.body?.dataset.modelLoaded === "1", null, { timeout: 60000 });
  const api = (path: string, init?: RequestInit) => page.evaluate(async ([p, i]) => { const r = await fetch(p as string, i as RequestInit); return { status: r.status, type: r.headers.get("content-type"), text: await r.text() }; }, [path, init] as const);
  const post = (path: string, body: unknown) => api(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const step = async (label: string, r: Promise<{ status: number; text: string; type: string | null }>, want: (x: { status: number; text: string; type: string | null }) => boolean) => {
    const x = await r;
    console.log(`${want(x) ? "✓" : "✗"} ${label}: ${x.status} ${x.type?.includes("json") ? x.text.slice(0, 120) : x.type}`);
    if (!want(x) && !failed) failed = label;
  };
  await step("библиотека рецептов", api("api/library"), (x) => x.status === 200 && x.text.includes("waddle-walk"));
  await step("паки клипов", api("api/clips"), (x) => x.status === 200 && x.text.includes("takes"));
  await step("новый клип", post("api/command", { dir: "projects/worker-demo", name: "clip.add", args: { name: "site-test", duration: 1, loop: true } }), (x) => x.status === 200);
  await step("рецепт из библиотеки", post("api/command", { dir: "projects/worker-demo", name: "recipe.rig", args: { clip: "site-test", recipe: "waddle-walk", preset: "toolsup-worker" } }), (x) => x.status === 200);
  await step("клип из пака (докачка)", post("api/command", { dir: "projects/worker-demo", name: "clip.import", args: { pack: "quaternius-ual1", take: "Idle_Loop", as: "site-idle" } }), (x) => x.status === 200 || /дубл|take/.test(x.text));
  await step("проверка клипа", post("api/command", { dir: "projects/worker-demo", name: "check", args: { clip: "site-test" } }), (x) => x.status === 200);
  await step("выгрузка glb", api("api/download?dir=projects/worker-demo"), (x) => x.status === 200 && x.type === "model/gltf-binary");
  await step("FBX — честный отказ", api("api/download?dir=projects/worker-demo&format=fbx"), (x) => x.status >= 400 && x.text.includes("Blender"));
  // правка переживает перезапуск браузера: проект лежит в IndexedDB, а не в памяти Service Worker
  await ctx.close();
  ctx = await open();
  page = ctx.pages()[0] ?? (await ctx.newPage());
  await page.goto(`${base}?dir=projects/worker-demo`);
  await page.waitForFunction(() => document.body?.dataset.modelLoaded === "1", null, { timeout: 60000 });
  await step("проект после перезапуска", api("api/project?dir=projects/worker-demo"), (x) => x.status === 200);
  const p = await page.evaluate(async () => (await (await fetch("api/project?dir=projects/worker-demo")).json()).project.clips.map((c: { name: string }) => c.name));
  console.log(`${p.includes("site-test") ? "✓" : "✗"} клипы после перезапуска: ${p.join(", ")}`);
  if (!p.includes("site-test") && !failed) failed = "сохранение в браузере";
  await page.screenshot({ path: join(ROOT, "out/site-check.png") });
  // английский интерфейс: на экране (текст, title, placeholder) — ни одной русской строки, в том числе в «Расширенном»
  const cyr = async () => page.evaluate(() => {
    const out: string[] = [];
    const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT);
    for (let n = w.nextNode(); n; n = w.nextNode()) {
      if (n.nodeType === 3) { if (/[а-яё]/i.test((n as Text).data)) out.push((n as Text).data.trim()); }
      else for (const a of ["title", "placeholder"]) { const v = (n as Element).getAttribute(a); if (v && /[а-яё]/i.test(v)) out.push(v); }
    }
    return out;
  });
  const left = new Set<string>();
  for (const dir of ["worker-demo", "fish-demo"]) {
    await page.goto(`${base}?dir=projects/${dir}&lang=en`);
    await page.waitForFunction(() => document.body?.dataset.modelLoaded === "1", null, { timeout: 60000 });
    await page.waitForTimeout(800);
    (await cyr()).forEach((x) => left.add(x));
    await page.locator(".tabs button").nth(1).click();
    await page.waitForTimeout(800);
    (await cyr()).forEach((x) => left.add(x));
    await page.locator("button.adv").click();
    await page.waitForTimeout(800);
    (await cyr()).forEach((x) => left.add(x));
  }
  console.log(`${left.size ? "✗" : "✓"} английский интерфейс: русских строк на экране ${left.size}${left.size ? " — " + [...left].slice(0, 3).join(" | ") : ""}`);
  if (left.size && !failed) failed = "английский интерфейс";
  await page.goto(`${base}?dir=projects/worker-demo&lang=ru`); // вернуть язык профиля
} catch (e: any) {
  failed ||= String(e?.message ?? e).split("\n")[0];
} finally {
  await ctx.close();
  http.close();
  rmSync(profile, { recursive: true, force: true });
}
for (const e of errors) console.log(`  ! ${e}`);
console.log(failed ? `SITE_CHECK_FAIL ${failed}` : "SITE_CHECK_OK");
process.exit(failed ? 1 : 0);
