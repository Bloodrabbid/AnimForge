// Догоняющее движение (clip.follow): грудь догоняет таз через пружину, голова и руки — грудь.
import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { bodyFrame, buildRig, posePartsAt, qinv, qmul, runCommand, vdot, worldPose, type Clip } from "../../core/src/index.ts";
import { ROOT, loadCtx } from "./node.ts";

const ctxP = loadCtx(join(ROOT, "projects/worker-demo"));
// мировое рыскание кости от покоя, ° (вектор поворота на вертикаль тела)
async function yawCurve(clip: Clip, bone: string, n = 96) {
  const { project, skeleton } = await ctxP;
  const rig = buildRig(skeleton), up = bodyFrame(project).up, i = rig.index.get(bone)!;
  return Array.from({ length: n }, (_, k) => {
    const q = qmul(worldPose(rig, posePartsAt(project, rig, clip, (k / n) * clip.duration)).R[i], qinv(rig.worldR[i]));
    const s = Math.hypot(q[0], q[1], q[2]), a = 2 * Math.atan2(s, q[3]);
    return s < 1e-12 ? 0 : (((vdot([q[0] / s, q[1] / s, q[2] / s], up) * a) * 180) / Math.PI);
  });
}
// на сколько отсчётов b отстаёт от a (максимум взаимной корреляции по циклу)
const lagOf = (a: number[], b: number[]) => {
  const n = a.length, ma = a.reduce((x, y) => x + y) / n, mb = b.reduce((x, y) => x + y) / n;
  let best = 0, bv = -Infinity;
  for (let d = 0; d < n / 2; d++) {
    let c = 0;
    for (let k = 0; k < n; k++) c += (a[k] - ma) * (b[(k + d) % n] - mb);
    if (c > bv) (bv = c), (best = d);
  }
  return best;
};

// двигается только таз (рыщет и кренится), грудь без своего движения — без follow её мировой поворот = тазовому
const pelvisOnly: Clip = {
  name: "p", duration: 0.96, fps: 30, loop: true,
  layers: [{ id: "p", type: "recipe", recipe: "waddle-walk", target: { chain: "pelvis" }, params: { role: "pelvis", period: 0.96, pelvisYaw: 20, pelvisRoll: 8, bob: 0 } }],
};

test("clip.follow: грудь отстаёт от таза на пружине, голова — от груди; loosen 0 — как без него", async () => {
  const n = 96, dt = pelvisOnly.duration / n;
  const fol: Clip = { ...pelvisOnly, follow: { lag: 0.1, bounce: 0.2, loosen: 1 } };
  const pel = await yawCurve(pelvisOnly, "pelvis", n);
  const ch0 = await yawCurve(pelvisOnly, "chest", n), ch1 = await yawCurve(fol, "chest", n), hd1 = await yawCurve(fol, "head", n);
  assert.ok(lagOf(pel, ch0) === 0, "без follow грудь — вместе с тазом");
  const l1 = lagOf(pel, ch1) * dt, l2 = lagOf(ch1, hd1) * dt;
  // критически близкая пружина ω = 2/lag: запаздывание первой гармоники — около lag
  assert.ok(l1 > 0.05 && l1 < 0.2, `грудь отстаёт на ${l1.toFixed(3)} с`);
  // голова догоняет уже запоздавшую грудь — с той же пружиной отстаёт от неё примерно так же
  assert.ok(l2 > 0.6 * l1 && l2 < 1.6 * l1, `голова отстаёт от груди на ${l2.toFixed(3)} с (грудь от таза — ${l1.toFixed(3)})`);
  // и не размахивается сильнее груди: пружина почти без перелёта сглаживает, а не раскачивает
  const amp0 = (c: number[]) => Math.max(...c) - Math.min(...c);
  assert.ok(amp0(hd1) < amp0(ch1) * 1.02, `голова ${amp0(hd1).toFixed(1)}°, грудь ${amp0(ch1).toFixed(1)}°`);
  // перелёт: bounce 1 — размах груди больше, чем при bounce 0
  const amp = (c: number[]) => Math.max(...c) - Math.min(...c);
  const b0 = await yawCurve({ ...fol, follow: { lag: 0.1, bounce: 0, loosen: 1 } }, "chest", n), b1 = await yawCurve({ ...fol, follow: { lag: 0.1, bounce: 1, loosen: 1 } }, "chest", n);
  assert.ok(amp(b1) > amp(b0) * 1.1, `перелёт: ${amp(b0).toFixed(1)}° → ${amp(b1).toFixed(1)}°`);
  const off = await yawCurve({ ...pelvisOnly, follow: { loosen: 0 } }, "chest", n);
  off.forEach((v, k) => assert.ok(Math.abs(v - ch0[k]) < 1e-6));
});

test("clip.follow: команда, пределы и сброс", async () => {
  const ctx = structuredClone(await ctxP);
  runCommand(ctx, "clip.follow", { clip: "walk", lag: 0.1 });
  assert.deepEqual(ctx.project.clips.find((c) => c.name === "walk")!.follow, { lag: 0.1 });
  assert.throws(() => runCommand(ctx, "clip.follow", { clip: "walk", bounce: 2 }));
  runCommand(ctx, "clip.follow", { clip: "walk" });
  assert.equal(ctx.project.clips.find((c) => c.name === "walk")!.follow, undefined);
});
