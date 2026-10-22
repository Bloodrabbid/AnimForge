// Все русские строки, которые может увидеть пользователь сайта: литералы и JSX-текст интерфейса, тексты ядра
// (рецепты, категории, стили, проверки) и библиотека (пресеты, паки клипов). Шаблон `a ${x} b` → ключ «a {} b».
// Словарь перевода — apps/web/src/i18n/en.json; тест i18n.test.ts требует перевод для каждого ключа.
//   pnpm i18n:extract — печатает недостающие ключи (JSON) для перевода
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "@babel/parser";

export const ROOT = join(import.meta.dirname, "../../..");
const CYR = /[а-яё]/i;
/** исходники, из которых текст доходит до экрана */
export const SOURCES = [
  // clipNames.ts не нужен: на английском у дублей паков — исходные имена; style.ts — тоже (STYLE100 → humanize)
  ...readdirSync(join(ROOT, "apps/web/src")).filter((f) => /\.tsx?$/.test(f) && !f.includes(".test.") && f !== "clipNames.ts").map((f) => `apps/web/src/${f}`),
  ...["recipes", "plan", "hands", "rig", "directions", "bodies", "templates"].map((f) => `packages/core/src/${f}.ts`),
  "packages/cli/src/checks.ts",
].filter((f) => { try { readFileSync(join(ROOT, f)); return true; } catch { return false; } });

export const norm = (s: string) => s.replace(/\s+/g, " ").trim();

/** склейки «+»: ключ целиком и его части по порядку — перевод склейки = склейка переводов частей */
export const joins: string[][] = [];
const parts = (n: any): string[] => (n.type === "BinaryExpression" ? [...parts(n.left), ...parts(n.right)] : [n.type === "StringLiteral" ? n.value : n.quasis.map((q: any) => q.value.cooked ?? q.value.raw).join("{}")]);

function fromSource(file: string, out: Map<string, string>) {
  const code = readFileSync(join(ROOT, file), "utf8");
  const ast = parse(code, { sourceType: "module", plugins: ["typescript", "jsx"], errorRecovery: true });
  const add = (s: string, at: number | undefined) => {
    const k = norm(s);
    if (CYR.test(k) && !out.has(k)) out.set(k, `${file}:${code.slice(0, at ?? 0).split("\n").length}`);
  };
  // "a" + "b" + `c ${x}` — одна строка на экране: ключ — склейка частей (части тоже ключи — по ним собирается перевод)
  const flat = (n: any): string | null =>
    n.type === "StringLiteral" ? n.value
    : n.type === "TemplateLiteral" ? n.quasis.map((q: any) => q.value.cooked ?? q.value.raw).join("{}")
    : n.type === "BinaryExpression" && n.operator === "+" ? ((a, b) => (a != null && b != null ? a + b : null))(flat(n.left), flat(n.right))
    : null;
  const walk = (n: any, parent?: any) => {
    if (!n || typeof n.type !== "string") return;
    if (n.type === "ImportDeclaration") return;
    if (n.type === "BinaryExpression" && n.operator === "+" && parent?.type !== "BinaryExpression") {
      const whole = flat(n);
      if (whole != null) { add(whole, n.start); joins.push(parts(n)); }
    }
    if (n.type === "StringLiteral" && parent?.type !== "ImportDeclaration") add(n.value, n.start);
    else if (n.type === "TemplateLiteral") add(n.quasis.map((q: any) => q.value.cooked ?? q.value.raw).join("{}"), n.start);
    else if (n.type === "JSXText") add(n.value, n.start);
    for (const k of Object.keys(n)) {
      if (k === "loc" || k === "leadingComments" || k === "trailingComments" || k === "innerComments") continue;
      const v = n[k];
      if (Array.isArray(v)) v.forEach((c) => walk(c, n));
      else if (v && typeof v === "object") walk(v, n);
    }
  };
  walk(ast.program);
}

/** строки данных библиотеки: всё строковое с кириллицей (help, provenance, паки) */
function fromJson(file: string, out: Map<string, string>) {
  const walk = (v: unknown) => {
    if (typeof v === "string") {
      // целиком и по частям « · »: интерфейс показывает название пака кусками
      for (const k of [norm(v), ...v.split(" · ").map(norm)]) if (CYR.test(k) && !out.has(k)) out.set(k, file);
    }
    else if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === "object") Object.values(v).forEach(walk);
  };
  walk(JSON.parse(readFileSync(join(ROOT, file), "utf8")));
}

export function extract(): Map<string, string> {
  const out = new Map<string, string>();
  joins.length = 0;
  for (const f of SOURCES) fromSource(f, out);
  for (const f of readdirSync(join(ROOT, "library/presets")).filter((f) => f.endsWith(".json"))) fromJson(`library/presets/${f}`, out);
  fromJson("library/clips/packs.json", out);
  return out;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const file = join(ROOT, "apps/web/src/i18n/en.json");
  const dict = JSON.parse(readFileSync(file, "utf8")) as Record<string, string>;
  const all = extract();
  // --join: перевести склейки по переведённым частям и дописать в словарь
  if (process.argv.includes("--join")) {
    let n = 0;
    for (const ps of joins) {
      const key = norm(ps.join(""));
      if (key in dict || !/[а-яё]/i.test(key)) continue;
      const en = ps.map((p) => (/[а-яё]/i.test(p) ? dict[norm(p)] : p.trim()));
      if (en.some((x) => x == null)) continue;
      dict[key] = en.map((x) => x!.trim()).filter(Boolean).join(" ");
      n++;
    }
    writeFileSync(file, JSON.stringify(Object.fromEntries(Object.entries(dict).sort(([a], [b]) => (a < b ? -1 : 1))), null, 1) + "\n");
    console.error(`склеек переведено: ${n}`);
  }
  const missing = [...all].filter(([k]) => !(k in dict));
  if (process.argv.includes("--stats")) {
    const by = new Map<string, number>();
    for (const [, at] of missing) { const f = at.split(":")[0]; by.set(f, (by.get(f) ?? 0) + 1); }
    console.log(`всего ${all.size}, без перевода ${missing.length}`);
    for (const [f, n] of [...by].sort((a, b) => b[1] - a[1])) console.log(`  ${n}\t${f}`);
  } else console.log(JSON.stringify(Object.fromEntries(missing.map(([k, at]) => [k, at])), null, 1));
}
