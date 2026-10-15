// 8 направлений из прямой ходьбы (clip.directions): тело идёт под нужным углом, взгляд остаётся вперёд, таз — к ходу.
import assert from "node:assert/strict";
import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { DEG, bodyFrame, buildRig, gaitHeading, gaitSlide, naturalSpeed, posePartsAt, qrot, vdot, worldPose } from "../../core/src/index.ts";
import { ROOT, call, loadCtx } from "./node.ts";

const tmp = mkdtempSync(join(tmpdir(), "af-dirs-"));
after(() => rmSync(tmp, { recursive: true, force: true }));

test("8 направлений: тело идёт точно под углом, со своей скоростью; плечи и взгляд — вперёд, таз — к ходу", async () => {
  const dir = join(tmp, "w");
  cpSync(join(ROOT, "projects/worker-demo"), dir, { recursive: true });
  await call(dir, "clip.directions", { clip: "walk_april" });
  const ctx = await loadCtx(dir);
  const rig = buildRig(ctx.skeleton);
  const f = bodyFrame(ctx.project);
  const H = Math.max(...ctx.skeleton.nodes.map((_, i) => vdot(rig.worldT[i], f.up))) - Math.min(...ctx.skeleton.nodes.map((n, i) => (n.isJoint ? vdot(rig.worldT[i], f.up) : Infinity)));
  const want: Record<string, number> = { fwd: 0, fwd_l: 45, left: 90, back_l: 135, back: 180, back_r: -135, right: -90, fwd_r: -45 };
  // рыскание кости в мире (вокруг up), среднее за цикл
  const yaw = (clip: (typeof ctx.project.clips)[number], bone: string) => {
    const i = rig.index.get(bone)!;
    let s = 0;
    const n = 24;
    for (let k = 0; k < n; k++) {
      const w = worldPose(rig, posePartsAt(ctx.project, rig, clip, (clip.duration * k) / n));
      // куда смотрит «вперёд» тела, привязанный к кости
      const fw = qrot(w.R[i], qrot([-rig.worldR[i][0], -rig.worldR[i][1], -rig.worldR[i][2], rig.worldR[i][3]], f.forward));
      s += Math.atan2(vdot(fw, f.side), vdot(fw, f.forward)) / DEG;
    }
    return s / n;
  };
  const head = ctx.project.chains.head[0], pelvis = ctx.project.chains.pelvis[0];
  for (const [suffix, angle] of Object.entries(want)) {
    const c = ctx.project.clips.find((x) => x.name === `walk_april_${suffix}`)!;
    assert.ok(c, suffix);
    const h = gaitHeading(ctx.project, rig, c);
    const err = Math.abs((((h - angle + 540) % 360) + 360) % 360 - 180);
    assert.ok(err < 2, `${suffix}: идёт под ${h.toFixed(1)}°, а надо ${angle}°`);
    assert.ok(naturalSpeed(ctx.project, rig, c) > 0.15 * H, `${suffix}: топчется на месте`);
    // назад — прямая ходьба наоборот во времени: иначе подскок и сгиб колена не в свои моменты, и стопа едет (9.7 %)
    const slide = gaitSlide(ctx.project, rig, c)!.mean;
    assert.ok(slide < 0.05, `${suffix}: стопа проезжает ${(slide * 100).toFixed(1)} % роста за шаг`);
    // таз — к ходу, взгляд держится вперёд: голова повёрнута меньше половины таза (Witcher: таз 61°, голова 16°)
    const yp = yaw(c, pelvis), yh = yaw(c, head);
    if (suffix === "left") assert.ok(yp > 30, `таз не довернулся к ходу: ${yp.toFixed(1)}°`);
    if (suffix === "right") assert.ok(yp < -30, `таз не довернулся к ходу: ${yp.toFixed(1)}°`);
    if (Math.abs(yp) > 10) assert.ok(Math.abs(yh) < 0.5 * Math.abs(yp) && yh * yp >= 0, `${suffix}: голова ${yh.toFixed(1)}° при тазе ${yp.toFixed(1)}°`);
  }
});
