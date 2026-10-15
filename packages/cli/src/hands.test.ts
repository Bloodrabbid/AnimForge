// Позы кисти (hand.pose) на Mixamo Xbot (out/retarget/xbot, не в git) и сложение клипов по частям тела.
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { bodyFrame, buildRig, fingersOf, posePartsAt, runCommand, vdot, vsub, worldPose, type Clip } from "../../core/src/index.ts";
import { ROOT, loadCtx } from "./node.ts";

const xbot = join(ROOT, "out/retarget/xbot");
const skip = !existsSync(join(xbot, "animforge.json")) && "нет out/retarget/xbot";

test("hand.pose на Xbot: пальцы в кулак — к ладони (в T-позе ладонь вниз), обе кисти зеркально, open — как было", { skip }, async () => {
  const ctx = structuredClone(await loadCtx(xbot));
  ctx.project.align = undefined; // T-поза как есть: ладони вниз
  const rig = buildRig(ctx.skeleton), f = bodyFrame(ctx.project);
  ctx.project.clips = [{ name: "c", duration: 1, fps: 30, loop: true, layers: [] }];
  const rest = worldPose(rig, posePartsAt(ctx.project, rig, ctx.project.clips[0], 0)).T;
  runCommand(ctx, "hand.pose", { clip: "c", side: "both", pose: "fist" });
  const w = worldPose(rig, posePartsAt(ctx.project, rig, ctx.project.clips[0], 0)).T;
  const tipOf = (b: string) => { const i = rig.index.get(b)!; const k = rig.parent.findIndex((p) => p === i); return k >= 0 ? k : i; };
  const tips: Record<string, number[]> = {};
  for (const s of ["l", "r"] as const) {
    const h = fingersOf(ctx.project, rig, s)!;
    assert.equal(h.fingers.length, 5);
    const W = w[rig.index.get(h.hand)!];
    for (const fg of h.fingers.filter((x) => x.name !== "thumb")) {
      const k = tipOf(fg.bones[fg.bones.length - 1]);
      const below = vdot(vsub(W, w[k]), f.up), d0 = Math.hypot(...vsub(rest[k], W)), d1 = Math.hypot(...vsub(w[k], W));
      assert.ok(below > 0.01, `${s} ${fg.name}: кончик на ${below.toFixed(3)} м ниже кисти`);
      assert.ok(d1 < 0.6 * d0, `${s} ${fg.name}: ${d0.toFixed(3)} → ${d1.toFixed(3)} м`);
      (tips[fg.name] ??= []).push(vdot(vsub(w[k], W), f.side));
    }
  }
  // зеркально: вбок кончики левой и правой — в разные стороны на одно и то же
  for (const [n, [l, r]] of Object.entries(tips)) assert.ok(Math.abs(l + r) < 0.01, `${n}: ${l.toFixed(3)} / ${r.toFixed(3)}`);
  runCommand(ctx, "hand.pose", { clip: "c", side: "both", pose: "open" });
  const o = worldPose(rig, posePartsAt(ctx.project, rig, ctx.project.clips[0], 0)).T;
  o.forEach((p, i) => assert.ok(Math.hypot(...vsub(p, rest[i])) < 1e-9));
});

test("clip.compose: руки и грудь — из удара, ноги и таз — свои", async () => {
  const ctx = structuredClone(await loadCtx(join(ROOT, "projects/worker-demo")));
  const rig = buildRig(ctx.skeleton);
  const walk = ctx.project.clips.find((c) => c.name === "walk")!;
  ctx.project.clips.push({ ...structuredClone(walk), name: "mix" });
  runCommand(ctx, "clip.compose", { clip: "mix", from: "hammer", chains: "arm_r,chest" });
  const mix = ctx.project.clips.find((c) => c.name === "mix")! as Clip, hammer = ctx.project.clips.find((c) => c.name === "hammer")!;
  for (const t of [0.2, 0.5, 0.9]) {
    const a = posePartsAt(ctx.project, rig, mix, t).rot, h = posePartsAt(ctx.project, rig, hammer, t).rot, wk = posePartsAt(ctx.project, rig, walk, t).rot;
    const same = (x: number[] | undefined, y: number[] | undefined) => !!x && !!y && Math.abs(Math.abs(x[0] * y[0] + x[1] * y[1] + x[2] * y[2] + x[3] * y[3]) - 1) < 1e-9;
    assert.ok(same(a.get("leg_l_0"), wk.get("leg_l_0")), `нога — от ходьбы t=${t}`);
    assert.ok(same(a.get("arm_r_0"), h.get("arm_r_0")), `рука — от удара t=${t}`);
    assert.ok(same(a.get("arm_l_0"), wk.get("arm_l_0")), `левая рука — от ходьбы t=${t}`);
  }
  assert.throws(() => runCommand(ctx, "clip.compose", { clip: "mix", from: "hammer", chains: "tail" }));
});
