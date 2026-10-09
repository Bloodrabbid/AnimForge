// Рецепты аддона Godot (live/af_recipes.gd) совпадают с ядром: evaluate, events и length по всем рецептам и пресетам.
import assert from "node:assert/strict";
import { test } from "node:test";
import { RECIPES } from "../../core/src/index.ts";
import { GODOT, NODE_COMMANDS } from "./node.ts";
import { existsSync } from "node:fs";

test("recipes.verify: AFRecipes в Godot считает как ядро, все рецепты", { skip: !existsSync(GODOT) && "нет Godot" }, async () => {
  const r = (await NODE_COMMANDS["recipes.verify"].run("", {})) as { ok: boolean; recipes: Record<string, number>; godot: string[] };
  assert.deepEqual(Object.keys(r.recipes).sort(), Object.keys(RECIPES).sort(), r.godot.join("\n"));
  assert.ok(r.ok, r.godot.join("\n"));
});
