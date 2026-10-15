// Слои поз: вес, выключение, соло; вставка зеркальной позы и зеркальный позинг.
import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { DEG, bodyFrame, buildRig, effectorOf, posePartsAt, qaxis, qrot, runCommand, vadd, vdot, vnorm, vscale, vsub, worldPose, type Clip, type Quat, type Vec3 } from "../../core/src/index.ts";
import { ROOT, loadCtx } from "./node.ts";

const ctxP = loadCtx(join(ROOT, "projects/worker-demo"));
const ang = (a: Quat, b: Quat) => (2 * Math.acos(Math.min(1, Math.abs(a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3]))) * 180) / Math.PI;
const base = (): Clip => ({ name: "c", duration: 1, fps: 30, loop: true, layers: [{ id: "w", type: "recipe", recipe: "waddle-walk", target: { chain: "arm_l" }, params: { role: "arm_l" } }] });
const pose = (extra = {}) => ({ id: "pose", type: "pose" as const, keys: [{ t: 0, rot: { arm_r_0: [0.3, 0, 0, 0.954] as Quat } }], ...extra });

test("слой позы: вес — доля угла, muted — молчит, solo — молчат остальные слои поз", async () => {
  const { project, skeleton } = await ctxP;
  const rig = buildRig(skeleton);
  const r = (c: Clip) => posePartsAt(project, rig, c, 0.4).rot.get("arm_r_0") ?? rig.skel.nodes[rig.index.get("arm_r_0")!].restR;
  const none = r(base()), full = r({ ...base(), layers: [...base().layers, pose()] }), half = r({ ...base(), layers: [...base().layers, pose({ weight: 0.5 })] });
  const a = ang(none, full);
  assert.ok(a > 20 && Math.abs(ang(none, half) - a / 2) < 0.01, `вес 0.5: ${ang(none, half).toFixed(2)}° из ${a.toFixed(2)}°`);
  assert.ok(ang(none, r({ ...base(), layers: [...base().layers, pose({ muted: true })] })) < 1e-6, "muted");
  const other = { id: "p2", type: "pose" as const, keys: [{ t: 0, rot: { arm_l_0: [0, 0, 0.3, 0.954] as Quat } }] };
  const solo = { ...base(), layers: [...base().layers, pose(), { ...other, solo: true }] };
  assert.ok(ang(none, r(solo)) < 1e-6, "при соло другого слоя поз этот молчит");
  // рецепт не слой позы — соло его не глушит; а muted у рецепта — глушит
  const l0 = posePartsAt(project, rig, base(), 0.4).rot.get("arm_l_0")!;
  assert.ok(ang(l0, posePartsAt(project, rig, { ...base(), layers: [{ ...base().layers[0], muted: true }] }, 0.4).rot.get("arm_l_0") ?? [0, 0, 0, 1]) > 1);
});

test("pose.mirror и зеркальный позинг: рука другой стороны — отражение через плоскость тела", async () => {
  const ctx = structuredClone(await ctxP);
  const rig = buildRig(ctx.skeleton), side = bodyFrame(ctx.project).side;
  ctx.project.clips = [{ name: "c", duration: 1, fps: 30, loop: true, layers: [] }];
  const w = () => worldPose(rig, posePartsAt(ctx.project, rig, ctx.project.clips[0], 0.5)).T;
  const at = (T: Vec3[], b: string) => T[rig.index.get(b)!];
  const c0 = vdot(rig.worldT[rig.index.get("pelvis")!], side);
  const refl = (p: Vec3): Vec3 => vsub(p, vscale(side, 2 * (vdot(p, side) - c0)));
  // кисть-варежку левой руки — вперёд и вверх, с зеркалом
  // цель достижима: кончик руки-варежки, повёрнутый вокруг плеча вперёд-вверх на 50°
  const T0 = w(), sh = at(T0, "arm_l_0");
  const tip0 = vsub(effectorOf(rig, rig.index.get("arm_l_1")!, true, 0.12)(worldPose(rig, posePartsAt(ctx.project, rig, ctx.project.clips[0], 0.5))), sh);
  const P = vadd(sh, qrot(qaxis(side, -50 * DEG), tip0));
  runCommand(ctx, "pose.reach", { clip: "c", t: 0.5, bone: "arm_l_1", target: P.join(","), length: 2, end: true, endLength: 0.12, mirror: true });
  const T = w();
  // с зеркалом сгибаются только парные кости (плечо, предплечье), грудь на оси — нет
  const end = (b: string) => effectorOf(rig, rig.index.get(b)!, true, 0.12)(worldPose(rig, posePartsAt(ctx.project, rig, ctx.project.clips[0], 0.5)));
  assert.ok(Math.hypot(...vsub(end("arm_l_1"), P)) < 0.02, `левая — в ${Math.hypot(...vsub(end("arm_l_1"), P)).toFixed(3)} м от цели`);
  assert.ok(Math.hypot(...vsub(at(T, "arm_r_1"), refl(at(T, "arm_l_1")))) < 0.01, "правая — отражение левой");
  // вставка зеркальной позы: ключ правой половины → другая сторона в другом кадре
  runCommand(ctx, "pose.clear", { clip: "c" });
  runCommand(ctx, "pose.reach", { clip: "c", t: 0.5, bone: "arm_l_1", target: P.join(","), length: 1 });
  runCommand(ctx, "pose.mirror", { clip: "c", t: 0.5 });
  const T2 = w();
  assert.ok(Math.hypot(...vsub(at(T2, "arm_r_1"), refl(at(T2, "arm_l_1")))) < 0.01, "pose.mirror: руки симметричны");
});
