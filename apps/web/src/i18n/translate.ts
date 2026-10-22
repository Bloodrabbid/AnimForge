// Английский интерфейс без правки компонентов: React рисует русский текст, переводчик тут же заменяет его по словарю.
// Ключи словаря — русские строки как в исходниках (пробелы схлопнуты); «{}» — место для подстановки: «примерка {}: …».
// Подстановки, которые сами по-русски (имя тела, категория), переводятся тем же словарём.
import DICT from "./en.json";
import { EN } from "./lang.ts";

const CYR = /[а-яё]/i;
const exact = new Map<string, string>();
const patterns: { re: RegExp; en: string; lit: number }[] = [];
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
for (const [ru, en] of Object.entries(DICT as Record<string, string>)) {
  if (!ru.includes("{}")) exact.set(ru, en);
  else patterns.push({ re: new RegExp("^" + ru.split("{}").map(esc).join("([\\s\\S]*?)") + "$"), en, lit: ru.replace(/\{\}/g, "").length });
}
patterns.sort((a, b) => b.lit - a.lit); // самый конкретный шаблон — первым

const cache = new Map<string, string | null>();
/** перевод строки или null, если словарь её не знает */
export function tr(text: string): string | null {
  const key = text.replace(/\s+/g, " ").trim();
  if (!CYR.test(key)) return null;
  const ck = text.includes("\n") ? text : key;
  const hit = cache.get(ck);
  if (hit !== undefined) return hit;
  let res: string | null = exact.get(key) ?? null;
  // многострочный текст (подсказки) — по строкам; непереведённая строка остаётся как есть
  if (res == null && /\n/.test(text.trim())) {
    const src = text.split("\n");
    const lines = src.map((l) => (CYR.test(l) ? tr(l) ?? l : l));
    if (lines.some((l, i) => l !== src[i])) res = lines.join("\n");
  }
  if (res == null) {
    for (const p of patterns) {
      const m = key.match(p.re);
      if (!m) continue;
      let i = 0;
      const subs = m.slice(1).map((s) => (CYR.test(s) ? tr(s) ?? s : s));
      res = p.en.replace(/\{(\d*)\}/g, (_, n) => subs[n === "" ? i++ : Number(n)] ?? "");
      break;
    }
  }
  // составной текст через « · » или «: » — по частям
  if (res == null) {
    for (const sep of [" · ", ": ", ", ", " — "]) {
      if (!key.includes(sep)) continue;
      const parts = key.split(sep).map((s) => (CYR.test(s) ? tr(s) : s));
      if (parts.every((s) => s != null)) { res = parts.join(sep); break; }
    }
  }
  if (cache.size > 5000) cache.clear();
  cache.set(ck, res);
  if (res == null) missing.add(key);
  return res;
}
/** перевод для кода, который сам режет или склеивает текст: на английском — по словарю, иначе — как есть */
export function t(ru: string): string {
  return EN ? tr(ru) ?? ru : ru;
}

/** чего не нашлось в словаре — для проверки сайта (window.__afMissing) */
export const missing = new Set<string>();

function textNode(n: Text) {
  const v = n.data;
  if (!CYR.test(v)) return;
  const t = tr(v);
  if (t == null) return;
  const lead = v.match(/^\s*/)![0], tail = v.match(/\s*$/)![0];
  n.data = lead + t + tail;
}
const ATTRS = ["title", "placeholder", "aria-label"];
function element(el: Element) {
  for (const a of ATTRS) {
    const v = el.getAttribute(a);
    if (v && CYR.test(v)) { const t = tr(v); if (t != null) el.setAttribute(a, t); }
  }
}
function deep(n: Node) {
  if (n.nodeType === 3) return textNode(n as Text);
  if (n.nodeType !== 1) return;
  element(n as Element);
  const w = document.createTreeWalker(n, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT);
  for (let c = w.nextNode(); c; c = w.nextNode()) c.nodeType === 3 ? textNode(c as Text) : element(c as Element);
}

/** включить перевод страницы: всё, что уже есть, и всё, что React нарисует потом */
export function startTranslator() {
  deep(document.body);
  new MutationObserver((list) => {
    for (const m of list) {
      if (m.type === "characterData") textNode(m.target as Text);
      else if (m.type === "attributes") element(m.target as Element);
      else m.addedNodes.forEach(deep);
    }
  }).observe(document.body, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ATTRS });
  const confirm0 = window.confirm.bind(window), alert0 = window.alert.bind(window);
  window.confirm = (m?: string) => confirm0(m && (tr(m) ?? m));
  window.alert = (m?: string) => alert0(m && (tr(m) ?? m));
  document.documentElement.lang = "en";
  (window as unknown as { __afMissing: Set<string> }).__afMissing = missing;
}
