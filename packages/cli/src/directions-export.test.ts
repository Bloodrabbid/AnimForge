// Восемь направлений одним архивом (export.directions): файлы на месте, BlendSpace2D — точки по сторонам, как ввод
// джойстика; в Godot в вершинах поза — клип направления, между ними — смесь.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { blendPos, blendSpace2D } from "./blendspace.ts";
import { GODOT, NODE_COMMANDS, ROOT } from "./node.ts";

test("BlendSpace2D: вперёд — (0, 1), влево — (−1, 0), вправо — (1, 0), стойка — центр", () => {
  assert.deepEqual(blendPos(0), [0, 1]);
  assert.deepEqual(blendPos(90), [-1, 0]);
  assert.deepEqual(blendPos(-90), [1, 0]);
  assert.deepEqual(blendPos(180), [0, -1]);
  const t = blendSpace2D([{ anim: "w_fwd", angle: 0 }, { anim: "w_left", angle: 90 }, { anim: "idle" }]);
  assert.match(t, /blend_point_0\/pos = Vector2\(0, 1\)/);
  assert.match(t, /blend_point_1\/pos = Vector2\(-1, 0\)/);
  assert.match(t, /blend_point_2\/pos = Vector2\(0, 0\)/);
  assert.match(t, /animation = &"idle"/);
  assert.match(t, /sync = true/);
});

test("export.directions: zip с 8 направлениями, стойкой, общим файлом и .tres; сверка в Godot", { skip: !existsSync(GODOT) && "нет Godot" }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "af-8dir-"));
  cpSync(join(ROOT, "projects/worker-demo"), dir, { recursive: true });
  const r = (await NODE_COMMANDS["export.directions"].run(dir, { clip: "walk_geralt", idle: "hammer", verify: true })) as { out: string; godot: string };
  const list = execFileSync("unzip", ["-Z1", r.out], { encoding: "utf8" }).trim().split("\n").sort();
  for (const d of ["fwd", "fwd_l", "left", "back_l", "back", "back_r", "right", "fwd_r"]) assert.ok(list.includes(`walk_geralt_${d}.glb`), `нет ${d}`);
  for (const f of ["hammer.glb", "walk_geralt_8dir.glb", "walk_geralt_blendspace.tres", "README.txt"]) assert.ok(list.includes(f), `нет ${f}`);
  assert.match(r.godot, /BLEND_OK/);
});
