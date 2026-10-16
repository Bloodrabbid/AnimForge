// Микродвижения (clip.micro): то же зерно — та же поза, другое — другая; у цикла шва нет (частоты — целое число волн
// за клип); размах — порядка amount; кости, которые ведёт IK, шум не трогает; без аргументов — снимается.
import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { buildRig, posePartsAt, qinv, qmul, runCommand, type Clip, type Quat } from "../../core/src/index.ts";
import { ROOT, loadCtx } from "./node.ts";

const ang = (a: Quat, b: Quat) => { const d = qmul(qinv(a), b); return (2 * Math.acos(Math.min(1, Math.abs(d[3]))) * 180) / Math.PI; };

test("микродвижения: зерно, шов цикла, размах, IK, снятие", async () => {
  const ctx = await loadCtx(join(ROOT, "projects/worker-demo"));
  delete ctx.project.limits;
  const rig = buildRig(ctx.skeleton);
  const walk = ctx.project.clips.find((c) => c.name === "walk")!;
  const head = ctx.project.chains.head![0];
  const rot = (c: Clip, t: number) => posePartsAt(ctx.project, rig, c, t).rot.get(head) ?? ([0, 0, 0, 1] as Quat);
  const m = (micro: Clip["micro"]): Clip => ({ ...walk, micro });
  // то же зерно — та же поза; другое — другая
  assert.ok(ang(rot(m({ seed: 7 }), 0.4), rot(m({ seed: 7 }), 0.4)) < 1e-5, "то же зерно — та же поза");
  assert.ok(ang(rot(m({ seed: 7, amount: 3 }), 0.4), rot(m({ seed: 8, amount: 3 }), 0.4)) > 0.3, "другое зерно — другие движения");
  // размах головы: amount 3° — отклонение от клипа без шума в пределах (0.3…2)·amount
  let max = 0;
  for (let k = 0; k < 40; k++) { const t = (walk.duration * k) / 40; max = Math.max(max, ang(rot(walk, t), rot(m({ amount: 3, seed: 3 }), t))); }
  assert.ok(max > 0.9 && max < 6, `размах головы ${max.toFixed(2)}° при amount 3`);
  // шов цикла: за миг до конца — как в начале (у разового клипа с теми же частотами — нет)
  const eps = 1e-4, c = m({ amount: 5, speed: 0.9, seed: 11 });
  assert.ok(ang(rot(c, walk.duration - eps), rot(c, eps)) < 0.05, `шов ${ang(rot(c, walk.duration - eps), rot(c, eps)).toFixed(3)}°`);
  // IK ведёт руку — шум её не трогает
  const tip = ctx.project.chains.arm_r!.at(-1)!;
  // IK с весом 0 руку не двигает, но цепочка — его: шум на ней пропущен, рука как без шума
  const ik: Clip = { ...walk, constraints: [{ id: "ik", type: "ik", tip, end: true, length: 2, weight: 0, target: { pos: [-0.3, 0.8, 0.3] } }] };
  const arm = (cl: Clip) => posePartsAt(ctx.project, rig, cl, 0.3).rot.get(ctx.project.chains.arm_r![0]) ?? ([0, 0, 0, 1] as Quat);
  assert.ok(ang(arm(ik), arm({ ...ik, micro: { amount: 5 } })) < 1e-6, "кости IK — без шума");
  // команда: проверка аргументов и снятие
  runCommand(ctx, "clip.micro", { clip: "walk", amount: 2, seed: 5 });
  assert.deepEqual(walk.micro, { amount: 2, seed: 5 });
  assert.throws(() => runCommand(ctx, "clip.micro", { clip: "walk", seed: 1.5 }), /целое/);
  runCommand(ctx, "clip.micro", { clip: "walk" });
  assert.equal(walk.micro, undefined);
});
