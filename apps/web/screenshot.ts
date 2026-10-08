// «Глаза» для интерфейса: скриншот страницы без окна и без кражи фокуса.
// Запускает headless Chromium (кэш playwright или Chrome) по протоколу CDP, ждёт загрузки модели и снимает PNG.
// Использование (сервер `pnpm web` должен работать):
//   pnpm web:shot 't=0.3&paused=1&bone=spine_5' out/web/t0.3.png
// Проверка живого обновления: AF_THEN="pnpm af recipe.set ..." pnpm web:shot ... — команда выполнится при открытой странице.
import { execSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

const [query = "paused=1", out = "out/web/shot.png"] = process.argv.slice(2);
const port = Number(process.env.PORT ?? 5178);
const dir = process.env.AF_DIR ?? "projects/fish-demo";
// AF_URL — снять любую страницу (например, чужой сервис для сравнения): ждём AF_WAIT_MS вместо загрузки модели
const url = process.env.AF_URL ?? `http://localhost:${port}/?dir=${encodeURIComponent(dir)}&${query}`;

function browser(): string {
  if (process.env.CHROME) return process.env.CHROME;
  const cache = join(homedir(), "Library/Caches/ms-playwright");
  if (existsSync(cache)) {
    for (const d of readdirSync(cache).filter((d) => d.startsWith("chromium_headless_shell-")).sort().reverse()) {
      for (const sub of readdirSync(join(cache, d))) {
        const bin = join(cache, d, sub, "headless_shell");
        if (existsSync(bin)) return bin;
      }
    }
  }
  return "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
}

const profile = mkdtempSync(join(tmpdir(), "af-shot-"));
const proc = spawn(
  browser(),
  ["--headless=new", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--hide-scrollbars", "--remote-debugging-port=0", `--user-data-dir=${profile}`, "--window-size=1400,900", "about:blank"],
  { stdio: ["ignore", "ignore", "pipe"] },
);

const wsUrl: string = await new Promise((ok, fail) => {
  let buf = "";
  proc.stderr!.on("data", (d) => {
    buf += d;
    const m = buf.match(/DevTools listening on (ws:\/\/\S+)/);
    if (m) ok(m[1]);
  });
  proc.on("exit", () => fail(new Error("браузер завершился:\n" + buf)));
  setTimeout(() => fail(new Error("браузер не ответил")), 15000);
});

// протокол CDP поверх WebSocket — без зависимостей
const ws = new WebSocket(wsUrl);
await new Promise((ok) => ws.addEventListener("open", ok, { once: true }));
let seq = 0;
const pending = new Map<number, (r: any) => void>();
ws.addEventListener("message", (e) => {
  const msg = JSON.parse(String(e.data));
  if (msg.id && pending.has(msg.id)) {
    pending.get(msg.id)!(msg);
    pending.delete(msg.id);
  }
});
const send = (method: string, params: object = {}, sessionId?: string) =>
  new Promise<any>((ok, fail) => {
    const id = ++seq;
    pending.set(id, (m) => (m.error ? fail(new Error(`${method}: ${m.error.message}`)) : ok(m.result)));
    ws.send(JSON.stringify({ id, method, params, sessionId }));
  });

try {
  const { targetId } = await send("Target.createTarget", { url: "about:blank" });
  const { sessionId } = await send("Target.attachToTarget", { targetId, flatten: true });
  await send("Emulation.setDeviceMetricsOverride", { width: 1400, height: 900, deviceScaleFactor: 1, mobile: false }, sessionId);
  await send("Page.navigate", { url }, sessionId);
  const deadline = Date.now() + 20000;
  if (process.env.AF_URL) await new Promise((r) => setTimeout(r, Number(process.env.AF_WAIT_MS ?? 8000)));
  else for (;;) {
    const r = await send("Runtime.evaluate", { expression: "document.body?.dataset.modelLoaded === '1'", returnByValue: true }, sessionId);
    if (r.result.value) break;
    if (Date.now() > deadline) throw new Error("модель не загрузилась за 20 с");
    await new Promise((r) => setTimeout(r, 200));
  }
  if (process.env.AF_THEN) {
    // проверка живого обновления: при открытой странице меняем проект снаружи (как агент через CLI)
    // и ждём, что страница сама перечитала animforge.json
    execSync(process.env.AF_THEN, { stdio: "inherit" });
    for (const until = Date.now() + 10000; ; ) {
      const r = await send("Runtime.evaluate", { expression: "document.querySelector('.status')?.textContent ?? ''", returnByValue: true }, sessionId);
      if (String(r.result.value).includes("перечитан")) break;
      if (Date.now() > until) throw new Error("страница не обновилась после изменения на диске");
      await new Promise((r) => setTimeout(r, 200));
    }
  }
  if (process.env.AF_EVAL) {
    // произвольный JS на странице перед снимком (клик по карточке и т.п.), потом пауза AF_WAIT_MS
    // скрипт может увести страницу на другой адрес (загрузка модели) — тогда ответа не будет, это не ошибка
    await send("Runtime.evaluate", { expression: process.env.AF_EVAL, awaitPromise: true }, sessionId).catch(() => {});
    await new Promise((r) => setTimeout(r, Number(process.env.AF_WAIT_MS ?? 3000)));
  }
  if (process.env.AF_DRAG) {
    // перетащить ручку активной цели настоящей мышью: AF_DRAG="dx,dy" — сдвиг в пикселях от её центра
    const [dx, dy] = process.env.AF_DRAG.split(",").map(Number);
    await new Promise((r) => setTimeout(r, 800));
    const h = await send("Runtime.evaluate", { expression: "window.__afHandle ? window.__afHandle() : null", returnByValue: true }, sessionId);
    if (!h.result.value) throw new Error("нет активной цели для перетаскивания");
    const [x, y] = h.result.value as [number, number];
    const mouse = (type: string, px: number, py: number, buttons = 1) =>
      send("Input.dispatchMouseEvent", { type, x: px, y: py, button: "left", buttons, clickCount: 1 }, sessionId);
    const before = await send("Runtime.evaluate", { expression: "document.querySelector('.status')?.textContent ?? ''", returnByValue: true }, sessionId);
    await mouse("mouseMoved", x, y, 0);
    await mouse("mousePressed", x, y);
    for (let k = 1; k <= 10; k++) await mouse("mouseMoved", x + (dx * k) / 10, y + (dy * k) / 10);
    await mouse("mouseReleased", x + dx, y + dy, 0);
    for (const until = Date.now() + 10000; ; ) {
      const s = await send("Runtime.evaluate", { expression: "document.querySelector('.status')?.textContent ?? ''", returnByValue: true }, sessionId);
      if (s.result.value !== before.result.value) {
        console.log(`статус: ${s.result.value}`);
        break;
      }
      if (Date.now() > until) throw new Error("перетаскивание не дошло до команды");
      await new Promise((r) => setTimeout(r, 200));
    }
    await new Promise((r) => setTimeout(r, 1500));
  }
  if (process.env.AF_CLICK) {
    // нажать кнопку по началу её текста (например «Ключ в t») и дождаться ответа команды в строке статуса
    const before = await send("Runtime.evaluate", { expression: "document.querySelector('.status')?.textContent ?? ''", returnByValue: true }, sessionId);
    const click = `(() => { const b = [...document.querySelectorAll('button')].find((b) => b.textContent.trim().startsWith(${JSON.stringify(process.env.AF_CLICK)})); b?.click(); return !!b; })()`;
    const r = await send("Runtime.evaluate", { expression: click, returnByValue: true }, sessionId);
    if (!r.result.value) throw new Error(`нет кнопки «${process.env.AF_CLICK}»`);
    for (const until = Date.now() + 10000; ; ) {
      const s = await send("Runtime.evaluate", { expression: "document.querySelector('.status')?.textContent ?? ''", returnByValue: true }, sessionId);
      if (s.result.value !== before.result.value) {
        console.log(`статус: ${s.result.value}`);
        break;
      }
      if (Date.now() > until) throw new Error("команда не ответила");
      await new Promise((r) => setTimeout(r, 200));
    }
  }
  await new Promise((r) => setTimeout(r, 500)); // пара кадров отрисовки после загрузки
  const { data } = await send("Page.captureScreenshot", { format: "png" }, sessionId);
  const file = resolve(out);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, Buffer.from(data, "base64"));
  console.log(file);
} finally {
  ws.close();
  proc.kill();
  setTimeout(() => rmSync(profile, { recursive: true, force: true }), 300);
}
