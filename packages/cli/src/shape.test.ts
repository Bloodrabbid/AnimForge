// Правка кривых слоя (layer.shape): сдвиг фазы, размах вокруг среднего, задержка по цепочке.
import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { buildRig, posePartsAt, runCommand, type Clip, type Quat } from "../../core/src/index.ts";
import { ROOT, loadCtx } from "./node.ts";

const ctxP = loadCtx(join(ROOT, "projects/worker-demo"));
// угол между поворотами (°)
const ang = (a: Quat, b: Quat) => (2 * Math.acos(Math.min(1, Math.abs(a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3]))) * 180) / Math.PI;
const per = 0.6;
const wave = (shape?: object): Clip => ({
  name: "w", duration: 1.2, fps: 30, loop: true,
  layers: [{ id: "w", type: "recipe", recipe: "wave", target: { chain: "ear_l" }, params: { period: per, tipAmp: 25, growth: 0, bodyDelay: 0 }, ...(shape ? { shape } : {}) }],
});

test("layer.shape late и step: кривая и каждая следующая кость цепочки сдвинуты на долю периода", async () => {
  const { project, skeleton } = await ctxP;
  const rig = buildRig(skeleton);
  const [b0, b1] = project.chains.ear_l;
  const base = wave(), sh = wave({ late: 0.2, step: 0.1 });
  for (const t of [0.13, 0.5, 0.91]) {
    const a = posePartsAt(project, rig, sh, t).rot;
    assert.ok(ang(a.get(b0)!, posePartsAt(project, rig, base, t - 0.2 * per).rot.get(b0)!) < 1e-4, `первая кость t=${t}`);
    assert.ok(ang(a.get(b1)!, posePartsAt(project, rig, base, t - 0.3 * per).rot.get(b1)!) < 1e-4, `вторая кость t=${t}`);
    // и сдвиг действительно что-то меняет
    assert.ok(ang(a.get(b0)!, posePartsAt(project, rig, base, t).rot.get(b0)!) > 1);
  }
});

test("layer.shape amount: 0 — кость стоит в среднем положении, 2 — отклонение от среднего вдвое", async () => {
  const { project, skeleton } = await ctxP;
  const rig = buildRig(skeleton);
  const b = project.chains.ear_l[0];
  const rest = posePartsAt(project, rig, wave({ amount: 0 }), 0).rot.get(b)!;
  for (const t of [0.07, 0.33, 0.8]) {
    assert.ok(ang(posePartsAt(project, rig, wave({ amount: 0 }), t).rot.get(b)!, rest) < 1e-4, `amount 0 двигается при t=${t}`);
    const d1 = ang(posePartsAt(project, rig, wave(), t).rot.get(b)!, rest);
    const d2 = ang(posePartsAt(project, rig, wave({ amount: 2 }), t).rot.get(b)!, rest);
    assert.ok(d1 > 2 && Math.abs(d2 - 2 * d1) < 0.05 * d1, `t=${t}: ${d1.toFixed(2)}° → ${d2.toFixed(2)}°`);
  }
});

test("layer.shape: команда по цепочке, пределы, сброс", async () => {
  const ctx = structuredClone(await ctxP);
  ctx.project.clips = [wave()];
  const r = runCommand(ctx, "layer.shape", { clip: "w", chain: "ear_l", late: 0.1, amount: 1.5 }) as { layers: { shape: object }[] };
  assert.deepEqual(r.layers[0].shape, { late: 0.1, amount: 1.5 });
  assert.throws(() => runCommand(ctx, "layer.shape", { clip: "w", chain: "ear_l", amount: 5 }));
  runCommand(ctx, "layer.shape", { clip: "w", layer: "w", amount: 1, late: 0 });
  assert.equal((ctx.project.clips[0].layers[0] as { shape?: object }).shape, undefined);
});
