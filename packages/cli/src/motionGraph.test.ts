// График движения на настоящих моделях: размах конечностей по кривым ядра (motionGraph) — тот, что рисует редактор.
import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { bodyFrame, buildRig, motionGraph, posePartsAt, worldPose } from "../../core/src/index.ts";
import { ROOT, loadCtx } from "./node.ts";

test("график ходьбы рабочего: стопы ходят вперёд-назад одинаково, таз почти не прыгает, колено гнётся, опора отмечена", async () => {
  const ctx = await loadCtx(join(ROOT, "projects/worker-demo"));
  const rig = buildRig(ctx.skeleton);
  const clip = ctx.project.clips.find((c) => c.name === "walk")!;
  const g = motionGraph(ctx.project, rig, clip);
  const L = g.limbs.find((l) => l.chain === "leg_l")!, R = g.limbs.find((l) => l.chain === "leg_r")!;
  const pelvis = g.limbs.find((l) => l.chain === "pelvis")!;
  assert.equal(L.tip, "foot_l", "конец ноги — стопа под голенью");
  assert.equal(L.kind, "foot");
  assert.equal(pelvis.tip, "pelvis", "у таза меряется сам таз");
  // шаг: стопа уходит вперёд-назад на десятки сантиметров, у обеих ног — одинаково (симметричная походка)
  assert.ok(L.amp.forward > 20, `размах стопы вперёд-назад ${L.amp.forward} см`);
  assert.ok(Math.abs(L.amp.forward - R.amp.forward) < 0.1 * L.amp.forward, `левая ${L.amp.forward} ≠ правая ${R.amp.forward}`);
  // вперёд-назад — главное движение стопы при ходьбе: больше, чем вбок и вверх
  assert.ok(L.amp.forward > L.amp.side && L.amp.forward > L.amp.up, `вперёд ${L.amp.forward}, вбок ${L.amp.side}, вверх ${L.amp.up}`);
  // таз подпрыгивает, но много меньше шага
  assert.ok(pelvis.amp.up < L.amp.forward / 3, `таз вверх-вниз ${pelvis.amp.up} см при шаге ${L.amp.forward}`);
  assert.ok(pelvis.amp.up > 0.5, "таз в ходьбе всё же качается");
  // колено гнётся (перенос) и подъём стопы над полом — тот же размах, что её вертикаль
  assert.equal(L.bendKind, "bend");
  assert.equal(L.joint, "leg_l_1");
  assert.ok(L.amp.bend > 20, `сгиб колена ${L.amp.bend}°`);
  assert.ok(Math.abs(L.amp.lift! - L.amp.up) < 1e-9);
  assert.ok(Math.min(...L.lift!) > -0.01 && Math.min(...L.lift!) < 0.02, `стопа в опоре у пола: ${Math.min(...L.lift!)}`);
  // опора: у каждой стопы есть, и каждая стоит на полу заметную долю клипа, но не всё время
  for (const l of [L, R]) {
    const on = l.stance!.reduce((a, [t0, t1]) => a + t1 - t0, 0) / clip.duration;
    assert.ok(on > 0.3 && on < 0.9, `${l.chain}: на полу ${on} клипа`);
  }
  // большую часть цикла опора одиночная, двойная — только на смене шага (у рабочего 35 кадров из 57 против 19;
  // если считать опорой любую стопу у пола, а не вровень с нижней, двойная разрастается до 25 и одиночная — до 0.51)
  const inside = (iv: [number, number][], t: number) => iv.some(([a, b]) => t >= a && t < b);
  const frames = g.times.slice(0, -1);
  const single = frames.filter((t) => inside(L.stance!, t) !== inside(R.stance!, t)).length;
  assert.ok(single / frames.length > 0.55, `одиночная опора ${single} кадров из ${frames.length}`);
});

test("график: кривые совпадают с позой ядра в кадре, смещения — от среднего, размах — пик-пик в см", async () => {
  const ctx = await loadCtx(join(ROOT, "projects/worker-demo"));
  const rig = buildRig(ctx.skeleton);
  const clip = ctx.project.clips.find((c) => c.name === "walk1")!;
  const g = motionGraph(ctx.project, rig, clip, 40);
  assert.equal(g.times.length, 41);
  const k = 13;
  const w = worldPose(rig, posePartsAt(ctx.project, rig, clip, g.times[k]));
  const foot = g.limbs.find((l) => l.chain === "leg_r")!;
  const P = w.T[rig.index.get("foot_r")!];
  for (let a = 0; a < 3; a++) assert.ok(Math.abs(foot.pos[k][a] - P[a]) < 1e-12);
  const f = bodyFrame(ctx.project);
  const ups = foot.pos.map((p) => p[0] * f.up[0] + p[1] * f.up[1] + p[2] * f.up[2]);
  const mean = ups.reduce((s, x) => s + x, 0) / ups.length;
  assert.ok(Math.abs(foot.up[k] - (ups[k] - mean)) < 1e-12, "вертикаль — смещение от среднего за клип");
  assert.ok(Math.abs(foot.amp.up - (Math.max(...ups) - Math.min(...ups)) * 100) < 1e-9, "размах — в сантиметрах");
  // сгиб колена в кадре — угол между бедром и голенью → стопой
  const T = (b: string) => w.T[rig.index.get(b)!];
  const u = T("leg_r_1").map((x, i) => x - T("leg_r_0")[i]), v = P.map((x, i) => x - T("leg_r_1")[i]);
  const ang = (Math.acos((u[0] * v[0] + u[1] * v[1] + u[2] * v[2]) / (Math.hypot(...u) * Math.hypot(...v))) * 180) / Math.PI;
  assert.ok(Math.abs(foot.bend[k] - ang) < 1e-9, `сгиб ${foot.bend[k]} ≠ ${ang}`);
});

test("график четвероногого: лапа — кость пола, у всех четырёх ног шаг вперёд-назад", async () => {
  const ctx = await loadCtx(join(ROOT, "projects/quadruped-demo"));
  const rig = buildRig(ctx.skeleton);
  const g = motionGraph(ctx.project, rig, ctx.project.clips.find((c) => c.name === "walk")!);
  const legs = g.limbs.filter((l) => l.kind === "foot");
  assert.deepEqual(legs.map((l) => l.tip).sort(), ["leg_bl_2", "leg_br_2", "leg_fl_2", "leg_fr_2"]);
  for (const l of legs) assert.ok(l.amp.forward > 30 && l.amp.forward > 3 * l.amp.side, `${l.chain}: вперёд ${l.amp.forward}, вбок ${l.amp.side}`);
});
