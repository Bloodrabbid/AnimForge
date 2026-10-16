// Русские названия библиотеки клипов: стили наборов — фразами, остальное — по словам; поиск по-русски с окончаниями.
// Покрытие: во всей библиотеке почти не остаётся непереведённых английских слов.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { NodeIO } from "@gltf-transform/core";
import { ALL_EXTENSIONS } from "@gltf-transform/extensions";
import { norm, ruName, searchText, wordHit } from "./clipNames.ts";

test("названия: стиль после движения — фразой, у прочих паков то же слово — по словарю слов", () => {
  assert.equal(ruName("walk_Zombie_loop"), "шаг · зомби");
  assert.equal(ruName("strafe-run_HandsInPockets_loop"), "бег вбок · руки в карманах");
  assert.equal(ruName("bow_not-confident_001"), "поклон · неуверенно");
  assert.equal(ruName("transition-walk-run-2_SpinClock"), "переход шаг ↔ бег · кружась по часовой");
  // «Punch» у Quaternius — не стиль 100STYLE «удар на каждом шаге»
  assert.equal(ruName("Punch_Enter"), "удар кулаком · вход");
  assert.equal(ruName("DogArmature|DogArmature|Idle"), "стойка");
  assert.equal(ruName("120_01_Alien_Turn"), "пришелец · разворот");
  // CMU «Walk_Crouched» — не стиль набора: слово словаря «присед», а не фраза 100STYLE «пригнувшись»
  assert.equal(ruName("136_09_Walk_Crouched"), "шаг · присед");
});

test("поиск: по-русски с окончаниями и по-английски", () => {
  const t = (take: string) => norm(searchText(take, "пак"));
  assert.ok(wordHit(t("bow_happy_001"), norm("поклоны")));
  assert.ok(["бег", "назад"].every((w) => wordHit(t("run-back_Old_loop"), w)));
  assert.ok(wordHit(t("walk_Tiptoe_loop"), norm("цыпочках")));
  assert.ok(wordHit(t("walk_Neutral_loop"), "шагом"), "окончание из двух букв");
  assert.ok(wordHit(t("walk_WalkingStickLeft_loop"), "stick"));
  assert.ok(!wordHit(t("walk_Zombie_loop"), "бег"));
});

test("покрытие: во всей библиотеке непереведённых английских слов — единицы", async () => {
  const ROOT = join(import.meta.dirname, "../../..");
  const packs = JSON.parse(readFileSync(join(ROOT, "library/clips/packs.json"), "utf8")).packs;
  const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);
  let words = 0, latin = 0;
  const left = new Map<string, number>();
  for (const p of packs) {
    for (const a of (await io.read(join(ROOT, "library/clips", p.file))).getRoot().listAnimations()) {
      for (const w of ruName(a.getName()).split(/[\s·↔]+/).filter(Boolean)) {
        words++;
        if (/^[a-z]{2,}/i.test(w)) // одиночная буква — вариант дубля (Death_B) 
          { latin++; left.set(w, (left.get(w) ?? 0) + 1); }
      }
    }
  }
  console.log(`непереведено ${latin} из ${words}`);
  assert.ok(latin <= 3, `непереведено ${latin} из ${words}: ${[...left].sort((a, b) => b[1] - a[1]).slice(0, 15).map(([w, c]) => `${w}:${c}`).join(" ")}`);
});
