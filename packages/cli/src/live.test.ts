// Живые рецепты: аддон Godot (live/af_core.gd) считает позу как ядро — все клипы демо-проектов и клип со всеми
// видами слоёв и констрейнов (ключи, позы, IK с пределами, взгляд, копия, пол), кость в кость.
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { test } from "node:test";
import { GODOT, NODE_COMMANDS } from "./node.ts";

test("live.verify: поза в Godot совпадает с ядром во всех клипах", { skip: !existsSync(GODOT) && "нет Godot" }, async () => {
  const r = (await NODE_COMMANDS["live.verify"].run("", {})) as { ok: boolean; projects: string[]; godot: string[] };
  assert.ok(r.projects.includes("worker-synthetic"), "нет синтетического клипа");
  const clips = r.godot.filter((l) => / (ok|BAD) rot=/.test(l));
  assert.ok(clips.length >= 15, `сверено клипов: ${clips.length}\n${r.godot.join("\n")}`);
  assert.ok(r.ok, r.godot.join("\n"));
});
