// Экспорт на стандартные скелеты и FBX: имена Mixamo / Unreal по цепочкам и сверка FBX в Godot по суставам.
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { buildRig, standardNames } from "../../core/src/index.ts";
import { BLENDER, GODOT, NODE_COMMANDS, ROOT, loadCtx } from "./node.ts";

const worker = join(ROOT, "projects/worker-demo");

test("standardNames: рабочий получает имена Mixamo и Unreal по цепочкам, стопа — ребёнок голени", async () => {
  const ctx = await loadCtx(worker);
  const rig = buildRig(ctx.skeleton);
  const mx = standardNames(ctx.project, rig, "mixamo");
  const ue = standardNames(ctx.project, rig, "unreal");
  const want: [string, string, string][] = [
    ["pelvis", "mixamorig:Hips", "pelvis"], ["chest", "mixamorig:Spine", "spine_01"], ["head", "mixamorig:Head", "head"],
    ["arm_l_0", "mixamorig:LeftArm", "upperarm_l"], ["arm_r_1", "mixamorig:RightForeArm", "lowerarm_r"],
    ["leg_l_0", "mixamorig:LeftUpLeg", "thigh_l"], ["leg_r_1", "mixamorig:RightLeg", "calf_r"], ["foot_l", "mixamorig:LeftFoot", "foot_l"],
  ];
  for (const [bone, m, u] of want) {
    assert.equal(mx.get(bone), m, `${bone} → ${mx.get(bone)}`);
    assert.equal(ue.get(bone), u, `${bone} → ${ue.get(bone)}`);
  }
  // уши вне стандартных цепочек — со своими именами; имена в скелете после переименования уникальны
  assert.ok(!mx.has("ear_l_0"));
  for (const map of [mx, ue]) {
    const names = ctx.skeleton.nodes.map((n) => map.get(n.name) ?? n.name);
    assert.equal(new Set(names).size, names.length, "повтор имён");
  }
});

test("standardNames: позвоночник из нескольких костей — Spine, Spine1 / spine_01, spine_02", async () => {
  const ctx = await loadCtx(join(ROOT, "projects/biped-demo"));
  const rig = buildRig(ctx.skeleton);
  const mx = standardNames(ctx.project, rig, "mixamo");
  const ue = standardNames(ctx.project, rig, "unreal");
  assert.deepEqual([mx.get("spine_0"), mx.get("spine_1")], ["mixamorig:Spine", "mixamorig:Spine1"]);
  assert.deepEqual([ue.get("spine_0"), ue.get("spine_1")], ["spine_01", "spine_02"]);
});

for (const [names, units] of [["unreal", "unreal"], ["mixamo", "unity"]] as const)
  test(`FBX (${names}, ${units}): все клипы тейками, суставы в Godot там же, где у ядра`, { skip: (!existsSync(GODOT) || !existsSync(BLENDER)) && "нет Godot или Blender" }, async () => {
    const dir = mkdtempSync(join(tmpdir(), "af-fbx-test-"));
    try {
      const r = (await NODE_COMMANDS.verify.run(worker, { out: join(dir, "worker.fbx"), names, units })) as { ok: boolean; godot: string[] };
      const ctx = await loadCtx(worker);
      const clips = r.godot.filter((l) => l.startsWith("CLIP"));
      assert.equal(clips.length, ctx.project.clips.length, r.godot.join("\n"));
      assert.ok(r.ok, r.godot.join("\n"));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
