// Скриншоты возможностей для README: собранный сайт (out/site) в Chrome, каждый кадр — в чистом профиле.
// Результат — docs/screens/<имя>.png (русский интерфейс) и docs/screens/en/<имя>.png (AF_LANG=en), 1600 px.
//   pnpm site && pnpm screens && AF_LANG=en pnpm screens
import { execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { extname, join, normalize } from "node:path";
import { chromium, type Page } from "playwright-core";
import { ROOT } from "../../packages/cli/src/node.ts";
import { tr } from "./src/i18n/translate.ts";

const EN = process.env.AF_LANG === "en";
/** надпись интерфейса на языке съёмки */
const ui = (ru: string) => (EN ? tr(ru) ?? ru : ru);
const OUT = join(ROOT, "docs/screens", EN ? "en" : "");
mkdirSync(OUT, { recursive: true });

const SITE = join(ROOT, "out/site");
const TYPES: Record<string, string> = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json" };
const http = createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://x");
  let f = normalize(join(SITE, decodeURIComponent(url.pathname.slice("/AnimForge/".length))));
  if (existsSync(f) && statSync(f).isDirectory()) f = join(f, "index.html");
  if (!url.pathname.startsWith("/AnimForge/") || !f.startsWith(SITE) || !existsSync(f)) return void res.writeHead(404).end();
  res.writeHead(200, { "content-type": TYPES[extname(f)] ?? "application/octet-stream" }).end(readFileSync(f));
});
await new Promise<void>((ok) => http.listen(5286, "127.0.0.1", ok));
const browser = await chromium.launch({ executablePath: process.env.CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", headless: true });

let p: Page;
const open = async (dir: string, extra = "") => {
  await p.goto(`http://127.0.0.1:5286/AnimForge/?dir=${dir}&lang=${EN ? "en" : "ru"}${extra}`);
  await p.waitForFunction(() => document.body?.dataset.modelLoaded === "1", null, { timeout: 90000 });
  await p.waitForTimeout(700);
};
const tab = (t: string) => p.locator(".tabs button", { hasText: ui(t) }).first().click();
const adv = async () => { if (!(await p.locator(".tabs button", { hasText: ui("Кожа") }).count())) await p.locator("button.adv").click(); await p.waitForTimeout(400); };
const clip = (t: string) => p.locator(".clip-tabs button", { hasText: t }).first().click();
let failed = 0;
async function shot(name: string, fn: () => Promise<void>) {
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 1, locale: EN ? "en-US" : "ru-RU" });
  p = await ctx.newPage();
  try {
    await fn();
    await p.waitForTimeout(1000);
    const file = join(OUT, `${name}.png`);
    await p.screenshot({ path: file });
    if (existsSync("/opt/homebrew/bin/pngquant")) execFileSync("/opt/homebrew/bin/pngquant", ["--force", "--skip-if-larger", "--quality=70-90", "--output", file, file]);
    console.log(`✓ ${name} ${(statSync(file).size / 1e3).toFixed(0)} КБ`);
  } catch (e: any) {
    failed++;
    console.log(`✗ ${name}: ${String(e?.message ?? e).split("\n")[0]}`);
  } finally {
    await ctx.close();
  }
}

await shot("1-rig-hierarchy", async () => {
  await open("projects/human-demo"); await adv(); await tab("Кости"); await p.locator("button", { hasText: ui("Иерархия") }).click();
  await p.keyboard.press("w"); await p.keyboard.press("Space");
});
await shot("2-weight-paint", async () => {
  await open("projects/human-demo"); await adv(); await tab("Кожа"); await tab("Кости"); await p.locator("button", { hasText: ui("Иерархия") }).click();
  await p.locator(".tab-body input").first().fill("thigh.L"); await p.waitForTimeout(400);
  await p.locator(".tab-body").first().locator("text=/DEF-thigh\\.L/").first().click();
  await p.keyboard.press("Space");
});
await shot("3-layers-limb-curves", async () => {
  await open("projects/worker-demo"); await adv(); await tab("Движение"); await p.keyboard.press("k"); await p.waitForTimeout(1500);
});
await shot("4-bone-mapping", async () => {
  await open("projects/human-demo", "&left=clips"); await p.locator(".tab-body input[placeholder]").first().fill("Zombie"); await p.waitForTimeout(800);
  await p.locator(".clip-card", { hasText: "CC BY 4.0" }).first().click(); await p.waitForTimeout(6000);
  await p.locator("button", { hasText: new RegExp(`^${ui("Кости")}`) }).first().click();
});
await shot("5-limb-trails", async () => {
  await open("projects/human-demo"); await clip("sword"); await p.keyboard.press("t"); await p.waitForTimeout(4000);
});
await shot("6-preset-preview", async () => {
  await open("projects/human-demo");
  const c = p.locator(".cards .card", { hasText: "witcher-geralt-run" }).first(); await c.scrollIntoViewIfNeeded(); await c.hover(); await p.waitForTimeout(2500);
});
await shot("7-rig-by-points", async () => {
  await open("projects/worker-demo"); await adv(); await tab("Кожа"); await p.locator("button", { hasText: ui("Скелет по точкам") }).click();
});

await browser.close();
http.close();
console.log(failed ? `SCREENS_FAIL ${failed}` : `SCREENS_OK ${OUT}`);
process.exit(failed ? 1 : 0);
