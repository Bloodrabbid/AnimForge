import { createRoot } from "react-dom/client";
import { App } from "./App.tsx";
import { WEB } from "./api.ts";
import "./styles.css";

/** Сайт: дождаться, пока Service Worker (sw/sw.ts) возьмёт страницу под себя, — до этого запросам api/ некому ответить. */
async function serviceWorker() {
  if (!("serviceWorker" in navigator)) throw new Error("Браузер без Service Worker — AnimForge на сайте не запустится. Нужен свежий Chrome, Safari или Firefox.");
  await navigator.serviceWorker.register("./sw.js", { scope: "./" });
  if (navigator.serviceWorker.controller) return;
  await new Promise<void>((ok) => navigator.serviceWorker.addEventListener("controllerchange", () => ok(), { once: true }));
}

const root = createRoot(document.getElementById("root")!);
if (WEB) {
  root.render(<div className="boot">AnimForge загружается…</div>);
  serviceWorker().then(
    () => root.render(<App />),
    (e) => root.render(<div className="boot">{String(e?.message ?? e)}</div>),
  );
} else root.render(<App />);
