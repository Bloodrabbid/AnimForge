// Английский интерфейс: у каждой русской строки, которую может увидеть пользователь, есть перевод, и переводчик
// собирает шаблоны с подстановками. Новая строка без перевода — тест падает: `pnpm i18n:extract` покажет, какие.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { ROOT, extract } from "../i18n/extract.ts";
import { tr } from "./i18n/translate.ts";

const DICT = JSON.parse(readFileSync(join(ROOT, "apps/web/src/i18n/en.json"), "utf8")) as Record<string, string>;

test("словарь en.json покрывает все русские строки интерфейса, ядра и библиотеки", () => {
  const missing = [...extract()].filter(([k]) => !(k in DICT)).map(([k, at]) => `${at}: ${k}`);
  assert.deepEqual(missing.slice(0, 20), [], `без перевода ${missing.length} — pnpm i18n:extract`);
});

test("переводы: без кириллицы, подстановок {} столько же, сколько в ключе", () => {
  const bad = Object.entries(DICT).filter(([ru, en]) => /[а-яё]/i.test(en) || (ru.match(/\{\}/g) ?? []).length !== (en.match(/\{\d*\}/g) ?? []).length);
  assert.deepEqual(bad.slice(0, 10), []);
});

test("переводчик: точная строка, шаблон с русской подстановкой, составной текст через « · »", () => {
  const exact = Object.entries(DICT).find(([ru]) => !ru.includes("{}") && ru.length > 12)!;
  assert.equal(tr(`  ${exact[0]}\n `), exact[1], "пробелы схлопываются");
  const pat = Object.entries(DICT).find(([ru, en]) => /^[^{}]+\{\}[^{}]+$/.test(ru) && en.includes("{}"))!;
  const [a, b] = pat[0].split("{}");
  assert.equal(tr(`${a}xyz${b}`), pat[1].replace("{}", "xyz"), "шаблон");
  assert.equal(tr(`${a}${exact[0]}${b}`), pat[1].replace("{}", exact[1]), "русская подстановка переводится");
  assert.equal(tr(`${exact[0]} · 42`), `${exact[1]} · 42`, "составной текст");
  assert.equal(tr("abc 12"), null, "латиница не трогается");
  assert.equal(tr("совершенно неизвестная строка"), null);
});
