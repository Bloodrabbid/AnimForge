// make: от слов к клипам. Поиск по библиотеке, длина ударов, весь путь на копии рабочего Tools Up! (без видео — без Blender).
import assert from "node:assert/strict";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { libRoles, parseClips, presetDuration, searchPresets } from "../../core/src/index.ts";
import { ROOT, call, loadPresets } from "./node.ts";

const lib = loadPresets().map((l) => ({ recipe: l.recipe, roles: libRoles(l.recipe), presets: l.presets }));
const biped = { pelvis: ["a"], spine: ["b"], chest: ["c"], head: ["d"], arm_l: ["e", "f"], arm_r: ["g", "h"], leg_l: ["i", "j"], leg_r: ["k", "l"] };
const top = (q: string, style?: object, chains: Record<string, string[]> = biped, body = "biped") => searchPresets(q, lib, chains, body, style)[0]?.preset.name;

test("parseClips: имя=пресет{параметры}, слова, разделитель «;» или запятая", () => {
  assert.deepEqual(parseClips("walk=toolsup-calm{\"period\":0.6}; удар молотком"), [
    { name: "walk", query: "toolsup-calm", params: { period: 0.6 } },
    { name: undefined, query: "удар молотком", params: undefined },
  ]);
  assert.deepEqual(parseClips("ходьба, удар").map((c) => c.query), ["ходьба", "удар"]);
});

test("поиск по словам: раздел, прилагательное, прямое упоминание и стиль игры", () => {
  assert.equal(top("ленивая ходьба", { stylization: "cartoon" }), "toolsup-calm");
  assert.equal(top("ходьба", { stylization: "realistic", role: "player" }), "witcher-geralt-walk");
  assert.equal(top("ходьба как у голема", { stylization: "cartoon" }), "witcher-golem-walk", "прямое упоминание сильнее стиля");
  assert.equal(top("удар", { stylization: "cartoon", role: "npc" }), "toolsup-hammer");
  assert.equal(top("дыхание"), "tlj-breathe-idle", "idle — дыхание, а не волна хвоста");
  // у мультяшного стиля есть «хвост собаки в покое» Tools Up! — но idle персонажа — это дыхание (curl), а не волна
  assert.equal(searchPresets("idle", lib, biped, "biped", { stylization: "cartoon" })[0]?.recipe, "curl");
  assert.equal(top("акула плывёт", { stylization: "cartoon" }, { body: ["a", "b", "c"] }, "other")?.startsWith("dredge-"), true);
  assert.equal(top("прыжок с переворотом"), undefined, "чего нет — того нет");
});

test("поиск: «ходьба» — не бег, «удар» — не силовой заряд, двуногому — не походка многоногого", () => {
  const walk = searchPresets("ходьба", lib, biped, "biped").map((f) => f.preset.name);
  assert.ok(!walk.slice(0, 5).some((n) => /run/.test(n)), walk.join(" "));
  assert.equal(top("бег", { stylization: "realistic" })?.endsWith("run"), true);
  assert.notEqual(top("удар"), "witcher-power");
  assert.equal(top("силовой удар"), "witcher-power");
  assert.ok(!searchPresets("бег", lib, biped, "biped").some((f) => f.recipe === "multileg-gait"), "кикимора не бежит за двуногого");
});

test("длина разового клипа — от рецепта: удар до открытия окна ввода, заряд целиком", () => {
  const charge = lib.find((l) => l.recipe === "charge-release")!.presets[0].params;
  assert.equal(presetDuration("charge-release", charge), 4.7); // замах 1.7 + удержание 0.8 + выпуск 1.9 + 0.3
  const hammer = lib.find((l) => l.recipe === "melee-strike")!.presets.find((p) => p.name === "toolsup-hammer")!.params;
  assert.ok(Math.abs(presetDuration("melee-strike", hammer) - 1.465) < 1e-3); // окно ввода 1.165 + 0.3
});

test("make на копии рабочего: клипы по словам и стилю, пределы, glb и копия в папку Godot", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "af-make-test-"));
  try {
    const dir = join(tmp, "worker");
    cpSync(join(ROOT, "projects/worker-demo"), dir, { recursive: true });
    const game = join(tmp, "game");
    mkdirSync(game);
    writeFileSync(join(game, "project.godot"), "config_version=5\n");
    const r = (await call(dir, "make", { clips: "ленивая ходьба; удар; прыжок с переворотом", style: { stylization: "cartoon", role: "npc" }, godot: join(game, "anim"), video: false })) as any;
    assert.deepEqual(r.clips.map((c: any) => [c.name, c.preset]), [["walk", "toolsup-calm"], ["attack", "toolsup-hammer"]]);
    assert.deepEqual(r.missing.map((m: any) => m.query), ["прыжок с переворотом"]);
    assert.ok(existsSync(r.glb) && existsSync(join(game, "anim/worker-demo.glb")));
    assert.deepEqual(r.notes, [], "папка внутри проекта Godot — без предупреждений");
    const p = JSON.parse(readFileSync(join(dir, "animforge.json"), "utf8"));
    assert.equal(p.style.stylization, "cartoon", "карточка стиля запомнилась");
    assert.equal(p.godot, join(game, "anim"), "папка игры запомнилась");
    assert.equal(p.clips.find((c: any) => c.name === "attack").loop, false);
    // повторный make заменяет клип, а не плодит walk-2; стиль и папка игры берутся из проекта
    const r2 = (await call(dir, "make", { clips: "walk=toolsup-heavy", video: false })) as any;
    assert.equal(r2.godot, join(game, "anim/worker-demo.glb"));
    const p2 = JSON.parse(readFileSync(join(dir, "animforge.json"), "utf8"));
    assert.equal(p2.clips.filter((c: any) => c.name.startsWith("walk")).length, p.clips.filter((c: any) => c.name.startsWith("walk")).length);
    assert.equal(p2.clips.find((c: any) => c.name === "walk").layers[0].preset, "toolsup-heavy");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
