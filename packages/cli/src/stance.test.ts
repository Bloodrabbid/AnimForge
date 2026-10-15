// Доля опоры (clip.gait stance): какую часть цикла стопа идёт назад относительно бедра (стоит на земле). Мерим по
// самой анимации — без плана, по которому её перекраивали.
import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { bodyFrame, buildRig, posePartsAt, runCommand, vdot, vsub, worldPose, type Clip } from "../../core/src/index.ts";
import { ROOT, loadCtx } from "./node.ts";

const duty = (ctx: Awaited<ReturnType<typeof loadCtx>>, clip: Clip, foot: string, period: number) => {
  const rig = buildRig(ctx.skeleton);
  const f = bodyFrame(ctx.project), pi = rig.index.get(ctx.project.chains.leg_l![0])!, fi = rig.index.get(foot)!;
  const N = 240, xs: number[] = [];
  for (let k = 0; k <= N; k++) {
    const w = worldPose(rig, posePartsAt(ctx.project, rig, clip, (period * k) / N));
    xs.push(vdot(vsub(w.T[fi], w.T[pi]), f.forward));
  }
  let back = 0;
  for (let k = 0; k < N; k++) if (xs[k + 1] < xs[k]) back++;
  return back / N;
};

test("доля опоры: 0.7 и 0.35 у ходьбы рабочего — столько цикла стопа и идёт назад", async () => {
  const ctx = await loadCtx(join(ROOT, "projects/worker-demo"));
  const clip = ctx.project.clips.find((c) => c.name === "walk_geralt")!;
  delete clip.ground;
  const foot = ctx.project.chains.leg_l!.at(-1)!;
  const leg = clip.layers.find((l) => l.type === "recipe" && l.target.chain === "leg_l");
  const period = leg && leg.type === "recipe" && Number(leg.params.period) > 0 ? Number(leg.params.period) : clip.duration;
  const d0 = duty(ctx, clip, foot, period);
  for (const d of [0.7, 0.35]) {
    runCommand(ctx, "clip.gait", { clip: clip.name, gait: { stance: d } });
    const got = duty(ctx, ctx.project.clips.find((c) => c.name === clip.name)!, foot, period);
    assert.ok(Math.abs(got - d) < 0.03, `stance ${d}: стопа идёт назад ${got.toFixed(3)} цикла (без стиля ${d0.toFixed(3)})`);
  }
  // без стиля — как было
  runCommand(ctx, "clip.gait", { clip: clip.name });
  assert.ok(Math.abs(duty(ctx, ctx.project.clips.find((c) => c.name === clip.name)!, foot, period) - d0) < 1e-9);
});

test("доля опоры вне 0.2…0.85 — ошибка", async () => {
  const ctx = await loadCtx(join(ROOT, "projects/worker-demo"));
  assert.throws(() => runCommand(ctx, "clip.gait", { clip: "walk_geralt", gait: { stance: 0.95 } }), /stance/);
});
