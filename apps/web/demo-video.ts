// Демо-ролик возможностей: запись собранного сайта (out/site) в Chrome по сценарию, с подписями и курсором на странице.
// Результат — docs/demo.mp4 (полный ролик) и docs/demo.gif (для README).
//   pnpm site && pnpm demo:video
import { execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { extname, join, normalize } from "node:path";
import { chromium, type Page } from "playwright-core";
import { ROOT } from "../../packages/cli/src/node.ts";

const SITE = join(ROOT, "out/site");
const TYPES: Record<string, string> = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".glb": "model/gltf-binary" };
const http = createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://x");
  if (!url.pathname.startsWith("/AnimForge/")) return void res.writeHead(404).end();
  let f = normalize(join(SITE, decodeURIComponent(url.pathname.slice("/AnimForge/".length))));
  if (existsSync(f) && statSync(f).isDirectory()) f = join(f, "index.html");
  if (!f.startsWith(SITE) || !existsSync(f)) return void res.writeHead(404).end();
  res.writeHead(200, { "content-type": TYPES[extname(f)] ?? "application/octet-stream" }).end(readFileSync(f));
});
await new Promise<void>((ok) => http.listen(5282, "127.0.0.1", ok));
const BASE = "http://127.0.0.1:5282/AnimForge/";
const W = 1280, H = 720;

const tmp = mkdtempSync(join(tmpdir(), "af-demo-"));
const browser = await chromium.launch({ executablePath: process.env.CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", headless: true });
const ctx = await browser.newContext({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
const page = await ctx.newPage();

// запись: screencast Chrome — JPEG-кадры с метками времени (только когда картинка меняется), паузы — длительностью кадра
const frames: { file: string; ts: number }[] = [];
let recording = false;
const cdp = await ctx.newCDPSession(page);
cdp.on("Page.screencastFrame", async (f) => {
  if (recording) {
    const file = join(tmp, `f${String(frames.length).padStart(6, "0")}.jpg`);
    writeFileSync(file, Buffer.from(f.data, "base64"));
    frames.push({ file, ts: f.metadata.timestamp ?? Date.now() / 1000 });
  }
  await cdp.send("Page.screencastFrameAck", { sessionId: f.sessionId }).catch(() => {});
});
await cdp.send("Page.startScreencast", { format: "jpeg", quality: 92, maxWidth: W, maxHeight: H, everyNthFrame: 1 });

// подпись внизу, заставка и курсор — свои элементы поверх страницы (переживают переходы: addInitScript)
await ctx.addInitScript(() => {
  addEventListener("DOMContentLoaded", () => {
    const st = document.createElement("style");
    st.textContent = `
      #demo-cap{position:fixed;left:50%;bottom:64px;transform:translateX(-50%);z-index:99999;background:rgba(20,16,10,.88);color:#ffd27a;
        font:600 26px/1.3 system-ui,sans-serif;padding:12px 26px;border-radius:12px;border:1px solid #ffb84d55;pointer-events:none;
        transition:opacity .35s;white-space:nowrap;box-shadow:0 8px 30px #0008}
      #demo-cap small{display:block;color:#e8dcc4;font-weight:400;font-size:17px}
      #demo-card{position:fixed;inset:0;z-index:100000;display:grid;place-items:center;background:radial-gradient(#2a2117,#110d08);
        color:#ffd27a;font:700 64px/1.15 system-ui,sans-serif;text-align:center;transition:opacity .5s}
      #demo-card p{font:400 26px/1.5 system-ui,sans-serif;color:#e8dcc4;margin:18px 0 0}
      #demo-cur{position:fixed;z-index:100001;width:22px;height:22px;margin:-11px 0 0 -11px;border-radius:50%;background:#ffb84dcc;
        border:2px solid #fff;pointer-events:none;transition:transform .12s;left:-50px;top:-50px}
      #demo-cur.down{transform:scale(.7)}`;
    document.head.append(st);
    const cur = Object.assign(document.createElement("div"), { id: "demo-cur" });
    document.body.append(cur);
    addEventListener("mousemove", (e) => { cur.style.left = e.clientX + "px"; cur.style.top = e.clientY + "px"; }, true);
    addEventListener("mousedown", () => cur.classList.add("down"), true);
    addEventListener("mouseup", () => cur.classList.remove("down"), true);
  });
});

const wait = (ms: number) => page.waitForTimeout(ms);
async function caption(title: string, sub = "") {
  await page.evaluate(([t, s]) => {
    let c = document.getElementById("demo-cap");
    if (!c) { c = document.createElement("div"); c.id = "demo-cap"; document.body.append(c); }
    c.innerHTML = `${t}${s ? `<small>${s}</small>` : ""}`;
    c.style.opacity = "1";
  }, [title, sub]);
}
async function card(html: string, ms: number) {
  await page.evaluate((h) => {
    document.getElementById("demo-cap")?.style.setProperty("opacity", "0");
    const c = Object.assign(document.createElement("div"), { id: "demo-card", innerHTML: `<div>${h}</div>` });
    document.body.append(c);
  }, html);
  await wait(ms);
  await page.evaluate(() => { const c = document.getElementById("demo-card")!; c.style.opacity = "0"; setTimeout(() => c.remove(), 600); });
}
async function open(dir: string, extra = "") {
  await page.goto(`${BASE}?dir=${dir}${extra}`);
  await page.waitForFunction(() => document.body?.dataset.modelLoaded === "1", null, { timeout: 90000 });
  await wait(400);
}
/** курсор плавно к элементу и клик */
async function click(sel: string | ReturnType<Page["locator"]>, pause = 350) {
  const loc = typeof sel === "string" ? page.locator(sel).first() : sel;
  await loc.scrollIntoViewIfNeeded();
  const b = (await loc.boundingBox())!;
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2, { steps: 18 });
  await wait(pause);
  await page.mouse.down();
  await wait(90);
  await page.mouse.up();
}
async function hover(sel: string, ms: number) {
  const b = (await page.locator(sel).first().boundingBox())!;
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2, { steps: 18 });
  await wait(ms);
}
/** протащить ползунок до доли u ширины */
async function slide(loc: ReturnType<Page["locator"]>, from: number, to: number) {
  await loc.scrollIntoViewIfNeeded();
  const b = (await loc.boundingBox())!;
  const y = b.y + b.height / 2;
  await page.mouse.move(b.x + b.width * from, y, { steps: 15 });
  await page.mouse.down();
  await page.mouse.move(b.x + b.width * to, y, { steps: 30 });
  await page.mouse.up();
}

try {
  // прогрев: Service Worker и данные — до записи заставки
  await open("projects/worker-demo");
  recording = true;
  await card(`AnimForge<p>Анимация любой 3D-модели — прямо в браузере<br>рецепты движений по замерам из настоящих игр</p>`, 3200);

  // 1. библиотека и примерка
  await caption("Библиотека: 222 пресета движений", "наведите — превью на вашем скелете, клик — примерка без записи");
  await hover(".cards .card:nth-child(3)", 1600);
  await click(page.locator(".cards .card", { hasText: "toolsup-heavy" }));
  await wait(2600);
  await click('button:has-text("Применить")');
  await wait(800);

  // 2. ручки
  await caption("Главные ручки: правка движения ползунками", "темп, крен, подскок — сразу на модели");
  const sliders = page.locator('.k-row input[type="range"], label input[type="range"]');
  await slide(sliders.nth(1), 0.35, 0.85);
  await wait(1300);
  await slide(sliders.nth(2), 0.6, 0.95);
  await wait(1800);

  // 3. разные тела
  await caption("Любое тело: рыба, змея, щупальце, четвероногое", "шаблоны тел и автоматический поиск цепочек скелета");
  await open("projects/fish-demo");
  await caption("Любое тело: рыба, змея, щупальце, четвероногое", "волна по позвоночнику — рецепт wave");
  await wait(2400);
  await open("projects/snake-demo");
  await caption("Любое тело: рыба, змея, щупальце, четвероногое", "змея — тот же рецепт с другими пресетами");
  await wait(2200);
  await open("projects/quadruped-demo");
  await caption("Любое тело: рыба, змея, щупальце, четвероногое", "походка четвероногого: шаг и галоп");
  await click('.clip-tabs button:has-text("gallop")');
  await wait(2600);

  // 4. паки клипов
  await open("projects/worker-demo", "&left=clips");
  await caption("Паки готовых клипов: CC0, CMU, 100STYLE, Bandai", "перенос на любой скелет — автор и лицензия в карточке");
  await click('input[placeholder^="Поиск: зомби"]');
  await page.keyboard.type("Dance_Loop", { delay: 70 });
  await wait(700);
  await click(page.locator(".clip-card", { hasText: "UAL" }).first().or(page.locator(".clip-card").first()));
  await page.waitForTimeout(3500);
  await click('button:has-text("Применить")');
  await wait(800);

  // 5. проверки
  await open("projects/worker-demo");
  await caption("Автопроверки: пол, кожа, скольжение ног, рывки", "и починка одной кнопкой");
  await click('section.checks button:has-text("Проверить")');
  await wait(3200);

  // 6. выгрузка
  await caption("Скачать GLB — в Godot, Blender, Unity, Unreal", "локальная версия: ещё FBX, авториг, аддон Godot с живыми рецептами");
  await hover('a:has-text("Скачать GLB")', 2600);

  await page.evaluate(() => document.getElementById("demo-cap")?.style.setProperty("opacity", "0"));
  await page.evaluate(() => document.body.append(Object.assign(document.createElement("div"), { id: "demo-card", innerHTML: `<div>Попробовать<p>bloodrabbid.github.io/AnimForge<br>github.com/Bloodrabbid/AnimForge</p></div>` })));
  await wait(3500); // финальная заставка остаётся до конца ролика
} finally {
  recording = false;
  await cdp.send("Page.stopScreencast").catch(() => {});
  await browser.close();
  http.close();
}

const out = join(ROOT, "docs");
mkdirSync(out, { recursive: true });
const ff = (args: string[]) => execFileSync("ffmpeg", ["-y", "-loglevel", "error", ...args], { stdio: "inherit" });
// список для concat: каждый кадр держится до следующего, последний — полсекунды
const list = frames.map((f, i) => `file '${f.file}'\nduration ${((frames[i + 1]?.ts ?? f.ts + 0.5) - f.ts).toFixed(4)}`).join("\n") + `\nfile '${frames.at(-1)!.file}'\n`;
writeFileSync(join(tmp, "list.txt"), list);
ff(["-f", "concat", "-safe", "0", "-i", join(tmp, "list.txt"), "-vf", "fps=30,format=yuv420p", "-c:v", "libx264", "-crf", "20", "-preset", "slow", "-movflags", "+faststart", join(out, "demo.mp4")]);
ff(["-i", join(out, "demo.mp4"), "-vf", "fps=10,scale=880:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=96:stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=4:diff_mode=rectangle", join(tmp, "demo.gif")]);
execFileSync("gifsicle", ["-O3", "--lossy=60", join(tmp, "demo.gif"), "-o", join(out, "demo.gif")]);
rmSync(tmp, { recursive: true, force: true });
const mb = (f: string) => (statSync(join(out, f)).size / 1e6).toFixed(1);
console.log(`DEMO_OK docs/demo.mp4 ${mb("demo.mp4")} МБ, docs/demo.gif ${mb("demo.gif")} МБ`);
