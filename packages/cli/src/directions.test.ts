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

test("фиксация опорной стопы: скольжение уходит, скорость шага остаётся, таз опускается не больше 1 % роста (у походки с верной фазой ног — неверную чинит legPhase)", async () => {
  const dir = join(tmp, "lock");
  cpSync(join(ROOT, "projects/worker-demo"), dir, { recursive: true });
  let ctx = await loadCtx(dir);
  const rig = buildRig(ctx.skeleton);
  const before = new Map(["walk_april", "walk_geralt"].map((n) => [n, gaitSlide(ctx.project, rig, ctx.project.clips.find((c) => c.name === n)!)!]));
  for (const n of before.keys()) await call(dir, "clip.ground", { clip: n, bones: "foot_l,foot_r", mode: "floor", ik: true, flat: true, lock: true });
  ctx = await loadCtx(dir);
  const f = bodyFrame(ctx.project);
  for (const [n, g0] of before) {
    const c = ctx.project.clips.find((x) => x.name === n)!;
    const g = gaitSlide(ctx.project, rig, c)!;
    assert.ok(g.mean < 0.006, `${n}: стопа проезжает ${(g.mean * 100).toFixed(1)} % роста (было ${(g0.mean * 100).toFixed(1)})`);
    assert.ok(Math.abs(g.speed - g0.speed) < 0.15 * g0.speed, `${n}: скорость ${g.speed.toFixed(2)}, была ${g0.speed.toFixed(2)}`);
    // таз: не ниже 1 % роста относительно клипа без фиксации
    const root = rig.index.get(ctx.project.chains.pelvis[0])!;
    const free = { ...c, ground: { ...c.ground!, lock: false } };
    const H = Math.max(...ctx.skeleton.nodes.map((_, i) => vdot(rig.worldT[i], f.up))) - Math.min(...ctx.skeleton.nodes.map((nd, i) => (nd.isJoint ? vdot(rig.worldT[i], f.up) : Infinity)));
    for (let k = 0; k < 12; k++) {
      const t = (c.duration * k) / 12;
      const dz = vdot(worldPose(rig, posePartsAt(ctx.project, rig, free, t)).T[root], f.up) - vdot(worldPose(rig, posePartsAt(ctx.project, rig, c, t)).T[root], f.up);
      assert.ok(dz < 0.0101 * H + 1e-6, `${n}: таз ниже на ${((dz / H) * 100).toFixed(2)} % роста`);
    }
  }
});

test("стиль походки: скорость, подскок, руки, таз ниже, сутулость — вокруг своего среднего, на любом цикле", async () => {
  const dir = join(tmp, "gait");
  cpSync(join(ROOT, "projects/worker-demo"), dir, { recursive: true });
  const ctx0 = await loadCtx(dir);
  const rig = buildRig(ctx0.skeleton);
  const f = bodyFrame(ctx0.project);
  const H = Math.max(...ctx0.skeleton.nodes.map((_, i) => vdot(rig.worldT[i], f.up))) - Math.min(...ctx0.skeleton.nodes.map((n, i) => (n.isJoint ? vdot(rig.worldT[i], f.up) : Infinity)));
  const pel = rig.index.get(ctx0.project.chains.pelvis[0])!, arm = rig.index.get(ctx0.project.chains.arm_l[0])!, chest = rig.index.get(ctx0.project.chains.chest[0])!, head = rig.index.get(ctx0.project.chains.head[0])!;
  const walk = ctx0.project.clips.find((c) => c.name === "walk_april")!;
  const speed0 = naturalSpeed(ctx0.project, rig, walk);
  // скорость ×1.3: клип короче в 1.3^0.6, идёт быстрее примерно в 1.3 раза
  await call(dir, "clip.gait", { clip: "walk_april", gait: { speed: 1.3 } });
  const fast = (await loadCtx(dir)).project.clips.find((c) => c.name === "walk_april")!;
  assert.ok(Math.abs(fast.duration - walk.duration / 1.3 ** 0.6) < 1e-3, `длина ${fast.duration}`);
  const r = naturalSpeed(ctx0.project, rig, fast) / speed0;
  assert.ok(r > 1.15 && r < 1.45, `скорость ×${r.toFixed(2)} вместо ×1.3`);
  // без пола — чтобы мерить сам стиль, а не постановку на пол
  const free = { ...walk, ground: undefined };
  const series = (c: typeof walk, fn: (w: ReturnType<typeof worldPose>) => number) => Array.from({ length: 24 }, (_, k) => fn(worldPose(rig, posePartsAt(ctx0.project, rig, c, (c.duration * k) / 24))));
  const span = (a: number[]) => Math.max(...a) - Math.min(...a);
  const mean = (a: number[]) => a.reduce((x, y) => x + y, 0) / a.length;
  const hgt = (w: ReturnType<typeof worldPose>) => vdot(w.T[pel], f.up);
  const b0 = span(series(free, hgt));
  assert.ok(b0 > 0.005 * H, "у ходьбы нет подскока — мерить нечего");
  assert.ok(span(series({ ...free, gait: { bounce: 0 } }, hgt)) < 0.1 * b0, "подскок ×0 — таз должен стоять");
  const b2 = span(series({ ...free, gait: { bounce: 2 } }, hgt));
  assert.ok(Math.abs(b2 / b0 - 2) < 0.2, `подскок ×2 дал ×${(b2 / b0).toFixed(2)}`);
  // вокруг среднего, а не вокруг покоя: подскок ×0 — таз на своей средней высоте за цикл
  assert.ok(Math.abs(mean(series({ ...free, gait: { bounce: 0 } }, hgt)) - mean(series(free, hgt))) < 0.001 * H, "подскок ×0 увёл таз со средней высоты");
  // таз ниже на долю роста — в среднем за цикл
  const dz = mean(series(free, hgt)) - mean(series({ ...free, gait: { lower: 0.03 } }, hgt));
  assert.ok(Math.abs(dz - 0.03 * H) < 0.002 * H, `таз ниже на ${((dz / H) * 100).toFixed(2)} % роста`);
  // руки ×0: плечо стоит на месте весь цикл
  const armDir = (w: ReturnType<typeof worldPose>) => vdot(qrot(w.R[arm], qrot([-rig.worldR[arm][0], -rig.worldR[arm][1], -rig.worldR[arm][2], rig.worldR[arm][3]], f.up)), f.forward);
  assert.ok(span(series(free, armDir)) > 0.1, "руки и так не машут");
  assert.ok(span(series({ ...free, gait: { arms: 0 } }, armDir)) < 0.02, "руки ×0 — машут");
  // рука с постоянным отводом вперёд (ключ +25°): ×0 — остаётся отведённой, мах уходит
  const held = { ...free, layers: [...free.layers, { id: "hold", type: "keys" as const, tracks: [{ bone: ctx0.project.chains.arm_l[0], axis: "pitch" as const, keys: [{ t: 0, v: -25 }, { t: free.duration, v: -25 }] }] }] };
  assert.ok(Math.abs(mean(series({ ...held, gait: { arms: 0 } }, armDir)) - mean(series(held, armDir))) < 0.03, "руки ×0 вернули руку в покой, а не в среднее");
  // сутулость: грудь вперёд, голова смотрит как прежде
  const pitch = (i: number) => (w: ReturnType<typeof worldPose>) => vdot(qrot(w.R[i], qrot([-rig.worldR[i][0], -rig.worldR[i][1], -rig.worldR[i][2], rig.worldR[i][3]], f.forward)), f.up);
  const hunch = { ...free, gait: { posture: 15 } };
  assert.ok(mean(series(hunch, pitch(chest))) < mean(series(free, pitch(chest))) - 0.15, "грудь не наклонилась вперёд");
  assert.ok(Math.abs(mean(series(hunch, pitch(head))) - mean(series(free, pitch(head)))) < 0.02, "голова не вернулась");
});
