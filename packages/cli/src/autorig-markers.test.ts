// Авториг по ручным точкам на сетке Xbot (Mixamo; в git его нет — без него пропуск): точки — с его собственных
// суставов, дальше всё строится по пропорциям. Суставы ложатся рядом с настоящими, скелет узнаётся как двуногий,
// пальцы — пять на кисти, и поза кисти «кулак» на них работает.
import assert from "node:assert/strict";
import { cpSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { NodeIO } from "@gltf-transform/core";
import { buildRig, fingersOf, readSkeleton } from "../../core/src/index.ts";
import { BLENDER, NODE_COMMANDS, ROOT, loadCtx } from "./node.ts";

const XBOT = join(ROOT, "out/retarget/xbot");
const skip = (!existsSync(join(XBOT, "animforge.json")) && "нет Xbot в out/") || (!existsSync(BLENDER) && "нет Blender");

test("авториг по точкам: суставы Xbot в пределах 4 % роста, пальцы, rig.detect", { skip }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "af-mk-"));
  cpSync(XBOT, dir, { recursive: true });
  rmSync(join(dir, ".autosave"), { recursive: true, force: true });
  const truth = buildRig(readSkeleton(await new NodeIO().read(join(dir, "assets/model.glb"))));
  const at = (n: string) => truth.worldT[truth.skel.nodes.findIndex((x) => x.name === `mixamorig:${n}`)];
  const mid = (a: number[], b: number[]) => a.map((v, k) => (v + b[k]) / 2);
  const markers = { chin: at("Head"), groin: mid(at("LeftUpLeg"), at("RightUpLeg")), wrist_l: at("LeftHand"), wrist_r: at("RightHand"), elbow_l: at("LeftForeArm"), elbow_r: at("RightForeArm"), knee_l: at("LeftLeg"), knee_r: at("RightLeg") };
  await NODE_COMMANDS["model.autorig"].run(dir, { file: join(dir, "assets/model.glb"), out: "assets/model.glb", markers, forward: [0, 0, 1] });
  const ctx = await loadCtx(dir);
  const rig = buildRig(ctx.skeleton);
  const ys = truth.skel.nodes.flatMap((n, i) => (n.isJoint ? [truth.worldT[i][1]] : []));
  const H = Math.max(...ys) - Math.min(...ys);
  for (const n of ["Hips", "Spine2", "Neck", "Head", "LeftArm", "RightArm", "LeftFoot", "RightToeBase", "LeftHandIndex1", "RightHandThumb1", "LeftHandPinky3"]) {
    const j = rig.skel.nodes.findIndex((x) => x.name === n);
    assert.ok(j >= 0, `нет кости ${n}`);
    const d = Math.hypot(...[0, 1, 2].map((k) => rig.worldT[j][k] - at(n)[k])) / H;
    assert.ok(d < 0.04, `${n}: ${(d * 100).toFixed(1)} % роста от настоящего`);
  }
  const det = (await NODE_COMMANDS["rig.detect"].run(dir, {})) as { body: string };
  assert.equal(det.body, "biped");
  const after = await loadCtx(dir);
  for (const s of ["l", "r"] as const) {
    const h = fingersOf(after.project, buildRig(after.skeleton), s);
    assert.equal(h?.fingers.length, 5, `пальцев у кисти ${s}: ${h?.fingers.length}`);
    assert.ok(h!.fingers.some((f) => f.name === "thumb"));
  }
  // кисть сжимается в кулак на новых пальцах
  const { runCommand } = await import("../../core/src/index.ts");
  runCommand(after, "clip.add", { name: "fist", duration: 1 });
  const r = runCommand(after, "hand.pose", { clip: "fist", t: 0, side: "l", pose: "fist" }) as { bones: Record<string, number> };
  assert.ok(r.bones.l >= 10, `кулак согнул ${r.bones.l} костей`);
});
