// Тесты ядра. Каждый проверяет конкретное число, которое сломается при ошибке в формуле, — тест должен уметь падать.
import assert from "node:assert/strict";
import { test } from "node:test";
import { evalKeys } from "./curves.ts";
import { bakeClip, buildRig, chainAxes, poseAt } from "./evaluate.ts";
import { DEG, Quat, qmul, qinv, qrot } from "./math.ts";
import type { Project, Skeleton } from "./project.ts";
import { RECIPES, withDefaults } from "./recipes.ts";

const close = (a: number, b: number, eps = 1e-6, msg = "") => assert.ok(Math.abs(a - b) <= eps, `${msg} ${a} ≠ ${b}`);

test("кривые: step держит значение, linear — середина, smooth — плоские края", () => {
  const keys = [{ t: 0, v: 0 }, { t: 1, v: 10 }];
  close(evalKeys([{ t: 0, v: 0, interp: "step" }, { t: 1, v: 10 }], 0.99, false, 1), 0);
  close(evalKeys([{ t: 0, v: 0, interp: "linear" }, { t: 1, v: 10 }], 0.25, false, 1), 2.5);
  close(evalKeys(keys, 0.5, false, 1), 5); // smoothstep в середине
  close(evalKeys(keys, 0.25, false, 1), 10 * (3 * 0.0625 - 2 * 0.015625)); // 3s²−2s³
});

test("кривые: полка и пик не дают перелёта", () => {
  const keys = [{ t: 0, v: 0 }, { t: 1, v: 25 }, { t: 2, v: 25 }, { t: 3, v: 0 }];
  let max = -Infinity;
  for (let t = 0; t <= 3; t += 0.01) max = Math.max(max, evalKeys(keys, t, false, 3));
  close(max, 25, 1e-9, "максимум на полке");
  // монотонный участок: касательная в середине — обычный Catmull-Rom (зажим не срабатывает)
  const mono = [{ t: 0, v: 0 }, { t: 1, v: 10 }, { t: 2, v: 20 }];
  // резкий скачок после пологого участка: без зажима сплайн уходит ниже 0 на пологом отрезке
  const jump = [{ t: 0, v: 0 }, { t: 1, v: 0.1 }, { t: 2, v: 100 }];
  for (let t = 0; t <= 1; t += 0.01) { const v = evalKeys(jump, t, false, 2); assert.ok(v >= -1e-9 && v <= 0.1 + 1e-9, `t=${t} v=${v}`); }
  close(evalKeys(mono, 1.5, false, 2), 16.25, 1e-9); // m0 = 10, m1 = 0 (край): 15 + 0.125·10
});

test("волна: амплитуда кончика, рост к кончику и задержка по телу", () => {
  const w = RECIPES.wave;
  const p = withDefaults(w, { period: 2, tipAmp: 10, growth: 2, bodyDelay: 90 });
  // кончик (i = n−1) в момент четверти периода, с учётом задержки 90°: sin(π/2 − π/2) = 0
  close(w.evaluate(p, 3, 4, 0.5).lateral!, 0);
  // кончик через полпериода после той же точки: sin(π − π/2) = 1 → полная амплитуда
  close(w.evaluate(p, 3, 4, 1.0).lateral!, 10);
  // первая кость: A = 10·(1/4)² = 0.625, без задержки, t = 0.5 → sin(π/2) = 1
  close(w.evaluate(p, 0, 4, 0.5).lateral!, 0.625);
});

test("волна: голова опережает тело на headLead", () => {
  const w = RECIPES.wave;
  const p = withDefaults(w, { period: 1, headAmp: 5, headLead: 90 });
  close(w.evaluate(p, 0, 5, 0).lateral!, 5); // sin(0 + 90°) = 1
});

// Цепочка из 3 костей вдоль −X, у костей нарочно повёрнутые локальные оси — рецепт не должен от них зависеть.
const roll: Quat = [Math.sin(Math.PI / 4), 0, 0, Math.cos(Math.PI / 4)]; // 90° вокруг X
const skel: Skeleton = {
  nodes: [
    { name: "root", parent: null, restT: [0, 0, 0], restR: [0, 0, 0, 1], restS: [1, 1, 1], isJoint: true },
    { name: "a", parent: "root", restT: [0, 0, 0], restR: roll, restS: [1, 1, 1], isJoint: true },
    { name: "b", parent: "a", restT: [-1, 0, 0], restR: [0, 0, 0, 1], restS: [1, 1, 1], isJoint: true },
    { name: "c", parent: "b", restT: [-1, 0, 0], restR: [0, 0, 0, 1], restS: [1, 1, 1], isJoint: true },
  ],
};
const project = (layers: any[], loop = true): Project => ({
  version: 1, name: "t", model: "", up: [0, 1, 0], chains: { body: ["a", "b", "c"] },
  clips: [{ name: "c", duration: 1, fps: 10, loop, layers }],
});

test("lateral-поворот идёт вокруг мирового «верха», даже если оси кости повёрнуты", () => {
  const pr = project([{ id: "k", type: "keys", tracks: [{ bone: "a", axis: "lateral", keys: [{ t: 0, v: 30 }] }] }]);
  const rig = buildRig(skel);
  const q = poseAt(pr, rig, pr.clips[0], 0).get("a")!;
  // мировой поворот кости = R_rest_world_parent * q; дельта относительно rest-мира должна быть 30° вокруг Y
  const worldDelta = qmul(q, qinv(roll)); // родитель root — единичный
  const v = qrot(worldDelta, [1, 0, 0]);
  close(v[1], 0, 1e-6, "ось Y не должна сдвигаться");
  close(Math.atan2(-v[2], v[0]) / DEG, 30, 1e-4, "угол вокруг Y");
});

test("запекание цикла: последний кадр совпадает с первым", () => {
  const pr = project([{ id: "wave", type: "recipe", recipe: "wave", target: { chain: "body" }, params: { period: 0.5, bodyDelay: 60 } }]);
  const b = bakeClip(pr, buildRig(skel), pr.clips[0]);
  assert.equal(b.times.length, 11);
  for (const qs of b.rotations.values()) qs[0].forEach((x, k) => close(x, qs[10][k], 1e-9));
});

test("изгиб: сумма углов по цепочке равна angle, пульсация масштабирует", () => {
  const c = RECIPES.curl;
  const p = withDefaults(c, { angle: 60, growth: 2, pulse: 0 });
  let sum = 0;
  for (let i = 0; i < 5; i++) sum += c.evaluate(p, i, 5, 0).vertical!;
  close(sum, 60, 1e-9);
  const pp = withDefaults(c, { angle: 60, growth: 0, pulse: 0.5, period: 4 });
  close(c.evaluate(pp, 0, 3, 1).vertical!, 20 * 1.5, 1e-9); // t = T/4 → sin = 1
});

test("вертикальная цепочка: оси не вырождаются", () => {
  const up: Skeleton = {
    nodes: [
      { name: "r", parent: null, restT: [0, 0, 0], restR: [0, 0, 0, 1], restS: [1, 1, 1], isJoint: true },
      { name: "s0", parent: "r", restT: [0, 0, 0], restR: [0, 0, 0, 1], restS: [1, 1, 1], isJoint: true },
      { name: "s1", parent: "s0", restT: [0, 1, 0], restR: [0, 0, 0, 1], restS: [1, 1, 1], isJoint: true },
    ],
  };
  const pr: Project = { version: 1, name: "t", model: "", up: [0, 1, 0], chains: { c: ["s0", "s1"] }, clips: [] };
  const ax = chainAxes(buildRig(up), pr, ["s0", "s1"]);
  for (const v of Object.values(ax)) assert.ok(v.every(Number.isFinite) && Math.abs(Math.hypot(...v) - 1) < 1e-9, `ось ${v}`);
});

import { ease, samplePreset, shakeAt } from "./tweens.ts";

test("твины: easing в ключевых точках", () => {
  close(ease("outQuad", 0.5), 0.75);
  close(ease("outExpo", 0.1), 0.5);
  close(ease("inOutSine", 0.5), 0.5);
  close(ease("outBack", 0.5), 1 + 2.70158 * -0.125 + 1.70158 * 0.25);
  close(ease({ hermite: [0, 1] }, 0.5), 0.375); // h01(0.5) = 0.5, h11(0.5)·b = (0.125 − 0.25)·1
  close(ease("outBounce", 1), 1);
});

test("твины: сегменты держат значение в паузе, цикл заворачивает время", () => {
  const p = { name: "p", help: "", target: "ui" as const, duration: 1, loop: true, provenance: [],
    tracks: [{ prop: "x", segments: [{ t0: 0, t1: 0.2, from: 0, to: 10 }, { t0: 0.6, t1: 0.8, from: 8, to: 4 }] }] };
  close(samplePreset(p, 0.1).x, 5);
  close(samplePreset(p, 0.4).x, 10); // пауза
  close(samplePreset(p, 0.7).x, 6);
  close(samplePreset(p, 1.1).x, 5); // цикл
});

test("тряска: огибающая нарастает, держит и гаснет к нулю", () => {
  const sh = { amp: 2, freq: 3, attack: 0.5, sustain: 0.5, decay: 1, roll: 1, seed: 1 };
  close(shakeAt(sh, 0).x, 0);
  close(shakeAt(sh, 2.0001).x, 0);
  const n = (t: number) => { const w = 2 * Math.PI * 3 * t; return 0.5 * Math.sin(w + 1) + 0.3 * Math.sin(2.17 * w + 1.7) + 0.2 * Math.sin(3.71 * w + 2.3); };
  close(shakeAt(sh, 0.7).x, 2 * n(0.7)); // удержание: env = 1
  close(shakeAt(sh, 1.5).x, 2 * 0.25 * n(1.5)); // середина затухания: (1−0.5)² = 0.25
});

test("шаг циркулем: цикл замкнут, ноги в противофазе, жёсткая пружина догоняет позу", () => {
  const c = RECIPES["compass-step"];
  const p = withDefaults(c, { period: 1.2, springHz: 1.6, damping: 0.47 });
  const v = (q: any, t: number) => c.evaluate(q, 0, 2, t).vertical!;
  close(v(p, 0.37), v(p, 0.37 + 1.2), 1e-9, "период");
  const r = withDefaults(c, { role: "leg_right", period: 1.2 });
  close(v(r, 0.2), v(p, 0.8), 1e-9, "правая = левая через полпериода");
  assert.deepEqual(c.evaluate(p, 1, 2, 0.3), {}, "вторая кость ноги неподвижна");
  // пружина 7 Гц критическая: к концу полупериода нога почти на reach, к концу цикла — почти на −support
  const s = withDefaults(c, { springHz: 7, damping: 1, period: 2, openTime: 0.1 });
  close(v(s, 0.999), 90, 0.5, "мах");
  close(v(s, 1.999), -36, 0.5, "опора");
  // опорная нога уходит назад по рампе, а не скачком: жёсткая пружина отстаёт от рампы на 2ζ/ω
  const ramp = withDefaults(c, { springHz: 7, damping: 1, period: 4, openTime: 1 });
  close(v(ramp, 2.5), -36 * (0.5 - 2 / (2 * Math.PI * 7)), 0.3, "рампа опоры");
  // перелёт ступенчатого отклика = exp(−πζ/√(1−ζ²)) — проверяет, что ζ в формуле именно ζ
  const z = 0.3, step = withDefaults(c, { springHz: 3, damping: z, period: 8, openTime: 0.001 });
  let peak = -Infinity;
  for (let t = 0; t < 1; t += 0.001) peak = Math.max(peak, v(step, t));
  close(peak, 90 + 126 * Math.exp((-Math.PI * z) / Math.sqrt(1 - z * z)), 1.5, "перелёт");
  // мягкая пружина с ζ < 1 перелетает цель: где-то в цикле мах больше reach
  let max = -Infinity;
  for (let t = 0; t < 1.2; t += 0.005) max = Math.max(max, v(withDefaults(c, { period: 1.2, springHz: 3, damping: 0.3 }), t));
  assert.ok(max > 90, `перелёт ${max}`);
});

import { posePartsAt, suggestAlign, worldPose } from "./evaluate.ts";

// Нога: таз → бедро → голень → ступня, вертикально вниз; у бедра локальные оси повёрнуты на 90° вокруг X.
const legSkel: Skeleton = {
  nodes: [
    { name: "root", parent: null, restT: [0, 1, 0], restR: [0, 0, 0, 1], restS: [1, 1, 1], isJoint: true },
    { name: "thigh", parent: "root", restT: [0, 0, 0], restR: roll, restS: [1, 1, 1], isJoint: true },
    { name: "shin", parent: "thigh", restT: [0, 0, 0.5], restR: [0, 0, 0, 1], restS: [1, 1, 1], isJoint: true },
    { name: "foot", parent: "shin", restT: [0, 0, 0.5], restR: [0, 0, 0, 1], restS: [1, 1, 1], isJoint: true },
  ],
};
const legProject = (layers: any[], ground?: any): Project => ({
  version: 1, name: "t", model: "", up: [0, 1, 0], chains: { leg: ["thigh", "shin", "foot"] },
  clips: [{ name: "c", duration: 1, fps: 10, loop: true, layers, ...(ground ? { ground } : {}) }],
});

test("сдвиг и масштаб: в осях тела, независимо от осей кости", () => {
  const rig = buildRig(legSkel);
  close(rig.worldT[3][1], 0, 1e-9, "ступня у пола");
  const pr = legProject([{ id: "k", type: "keys", tracks: [
    { bone: "shin", axis: "move_up", keys: [{ t: 0, v: 0.2 }] },
    { bone: "thigh", axis: "scale_up", keys: [{ t: 0, v: 0.5 }] },
  ] }]);
  const pose = posePartsAt(pr, rig, pr.clips[0], 0);
  // shin: родитель thigh повёрнут на 90° вокруг X, мировой up (0,1,0) в его осях — это (0,0,−1)
  const p = pose.pos.get("shin")!;
  close(p[0], 0); close(p[1], 0); close(p[2], 0.5 - 0.2, 1e-9, "z");
  // масштаб «вверх» у thigh попадает на его локальную Z (она смотрит вдоль мирового Y)
  assert.deepEqual(pose.scl.get("thigh")!.map((x) => +x.toFixed(9)), [1, 1, 1.5]);
  // мировая высота ступни: бедро растянуто в 1.5 раза, голень поднята на 0.2
  const w = worldPose(rig, pose);
  close(w.T[3][1], 1 - 1.5 * (0.5 - 0.2) - 1.5 * 0.5, 1e-9, "ступня");
});

test("постановка на пол: contact прижимает, floor только не даёт провалиться", () => {
  const rig = buildRig(legSkel);
  const bend = [{ id: "k", type: "keys", tracks: [{ bone: "thigh", axis: "vertical", keys: [{ t: 0, v: 60 }] }] }];
  const footY = (pr: Project) => worldPose(rig, posePartsAt(pr, rig, pr.clips[0], 0)).T[3][1];
  close(footY(legProject(bend)), 1 - Math.cos(60 * DEG), 1e-9, "без пола нога висит");
  close(footY(legProject(bend, { bones: ["foot"], mode: "contact" })), 0, 1e-9, "contact");
  close(footY(legProject(bend, { bones: ["foot"], mode: "floor" })), 1 - Math.cos(60 * DEG), 1e-9, "floor не тянет вниз");
  const down = [{ id: "k", type: "keys", tracks: [{ bone: "root", axis: "move_up", keys: [{ t: 0, v: -0.3 }] }] }];
  close(footY(legProject(down, { bones: ["foot"], mode: "floor" })), 0, 1e-9, "floor выталкивает из пола");
});

test("покачивание: вынужденные колебания маятника совпадают с формулой", () => {
  // родитель p качается по синусу вокруг Z; ухо e0→e1 растёт из точки его вращения вдоль X (линейных ускорений нет)
  const sk: Skeleton = { nodes: [
    { name: "p", parent: null, restT: [0, 0, 0], restR: [0, 0, 0, 1], restS: [1, 1, 1], isJoint: true },
    { name: "e0", parent: "p", restT: [0, 0, 0], restR: [0, 0, 0, 1], restS: [1, 1, 1], isJoint: true },
    { name: "e1", parent: "e0", restT: [0.3, 0, 0], restR: [0, 0, 0, 1], restS: [1, 1, 1], isJoint: true },
  ] };
  const T = 0.5, A = 10, hz = 1.6, z = 0.31, inert = 0.5;
  const pr: Project = { version: 1, name: "t", model: "", up: [0, 1, 0], chains: { p: ["p"], ear: ["e0", "e1"] },
    clips: [{ name: "c", duration: T * 2, fps: 30, loop: true, layers: [
      { id: "sway", type: "recipe", recipe: "wave", target: { chain: "p" }, params: { plane: "lateral", period: T, tipAmp: A, growth: 1 } },
      { id: "j", type: "recipe", recipe: "jiggle", target: { chain: "ear" }, params: { hz, damping: z, inert } },
    ] }] };
  const rig = buildRig(sk);
  // e0 получает 1/3 общего отклонения (веса 1/2 и 1 из 1.5)
  let amp = 0;
  for (let t = 0; t < T; t += 0.002) {
    const q = posePartsAt(pr, rig, pr.clips[0], t).rot.get("e0")!;
    amp = Math.max(amp, (2 * Math.asin(Math.min(1, Math.hypot(q[0], q[1], q[2])))) / DEG * 3);
  }
  const w = (2 * Math.PI) / T, w0 = 2 * Math.PI * hz;
  const expect = ((1 - inert) * A * w * w) / Math.hypot(w0 * w0 - w * w, 2 * z * w0 * w);
  close(amp, expect, expect * 0.03, "амплитуда");
  // толчки вверх-вниз: основание ходит по синусу B·sin(ωt) — момент (d × a)/L, длина L = 0.3
  const B = 0.02, keys = Array.from({ length: 65 }, (_, k) => ({ t: (k * 2 * T) / 64, v: B * Math.sin((2 * Math.PI * k * 2) / 64) }));
  const bob: Project = { ...pr, clips: [{ ...pr.clips[0], layers: [
    { id: "k", type: "keys", tracks: [{ bone: "p", axis: "move_up", keys }] }, pr.clips[0].layers[1]] }] };
  let amp2 = 0;
  for (let t = 0; t < T; t += 0.002) {
    const q = posePartsAt(bob, rig, bob.clips[0], t).rot.get("e0")!;
    amp2 = Math.max(amp2, (2 * Math.asin(Math.min(1, Math.hypot(q[0], q[1], q[2])))) / DEG * 3);
  }
  const expect2 = (((1 - inert) * B * w * w) / 0.3 / Math.hypot(w0 * w0 - w * w, 2 * z * w0 * w)) / DEG;
  close(amp2, expect2, expect2 * 0.05, "амплитуда от толчков");
  // без движения родителя покачивания нет
  const still = { ...pr, clips: [{ ...pr.clips[0], layers: [pr.clips[0].layers[1]] }] };
  assert.equal(posePartsAt(still, rig, still.clips[0], 0.3).rot.get("e0"), undefined);
});

test("ходьба вразвалку: подскок — доля высоты таза, низ шага в момент опоры", () => {
  const c = RECIPES["waddle-walk"];
  const p = withDefaults(c, { role: "pelvis", period: 0.48, bob: 0.25 });
  let lo = Infinity, hi = -Infinity, tlo = 0;
  for (let t = 0; t < 0.24; t += 0.0005) { const v = c.evaluate(p, 0, 1, t, { height: 0.5 }).move_up!; if (v < lo) { lo = v; tlo = t; } hi = Math.max(hi, v); }
  close(hi - lo, 0.125, 0.004, "размах = 0.25 · 0.5");
  close(hi, 0, 0.004, "вершина — без сдвига");
  close(tlo, 0.12, 0.012, "низ — когда нога впереди (четверть цикла)");
});

test("моргание: закрыто держится на minY, потом перелёт и возврат к 1", () => {
  const c = RECIPES.blink;
  const p = withDefaults(c, {});
  const y = (t: number) => c.evaluate(p, 0, 1, t).scale_up!;
  close(y(0.1), 0.3); close(c.evaluate(p, 0, 1, 0.1).scale_side!, 1.2);
  close(y(0.067 + 0.083 + 0.05), 1.17, 1e-9, "перелёт");
  close(y(0.2 + 0.05), 1.17 - 0.17 * 0.5, 1e-9, "середина успокоения (smoothstep = 0.5)");
  close(y(1), 1); close(y(1.8 + 0.1), 0.3, 1e-9, "следующий цикл");
});

test("ходьба вразвалку: углы груди и головы — относительно родителя, в мире совпадают с замером", () => {
  const c = RECIPES["waddle-walk"];
  const at = (role: string, t: number) => c.evaluate(withDefaults(c, { role }), 0, 1, t, { height: 0.5 });
  const t = 0.479 / 4; // sin = 1
  // мировое рыскание головы = таз + грудь + голова = headYaw·sin(ωt + π) = −6
  close(at("pelvis", t).yaw! + at("chest", t).yaw! + at("head", t).yaw!, -6, 1e-9);
  close(at("pelvis", t).yaw! + at("chest", t).yaw!, -0.49 * 32, 1e-9, "плечи в мире");
});

test("IK ступни: при опускании тела колено сгибается вперёд, ступня ровно на полу под тазом", () => {
  const rig = buildRig(legSkel);
  const down = [{ id: "k", type: "keys", tracks: [{ bone: "root", axis: "move_up", keys: [{ t: 0, v: -0.3 }] }] }];
  const pr = legProject(down, { bones: ["foot"], mode: "floor", ik: true });
  const w = worldPose(rig, posePartsAt(pr, rig, pr.clips[0], 0));
  close(w.T[3][1], 0, 1e-9, "ступня на полу");
  close(w.T[0][1], 0.7, 1e-9, "тело опустилось (floor не вытолкнул обратно)");
  close(w.T[3][2], 0, 1e-9, "ступня под тазом");
  assert.ok(w.T[2][2] > 0.1, `колено вперёд, z=${w.T[2][2]}`);
  // высота колена: треугольник 0.5/0.5/0.7 → половина основания 0.35, высота √(0.25 − 0.1225)
  close(w.T[2][2], Math.sqrt(0.25 - 0.35 * 0.35), 1e-9, "вынос колена");
  // уже согнутая нога сохраняет плоскость сгиба: тянем бедро вбок, сгиб остаётся в той же плоскости
  const bent = [{ id: "k", type: "keys", tracks: [
    { bone: "root", axis: "move_up", keys: [{ t: 0, v: -0.2 }] },
    { bone: "shin", axis: "vertical", keys: [{ t: 0, v: 20 }] }] }];
  const pb = legProject(bent, { bones: ["foot"], mode: "floor", ik: true });
  const wb = worldPose(rig, posePartsAt(pb, rig, pb.clips[0], 0));
  close(wb.T[3][1], 0, 1e-9, "согнутая нога тоже встаёт на пол");
  close(wb.T[2][0], 0, 1e-9, "колено в той же плоскости");
  // нога в переносе (ступня над полом) IK не трогает
  const lift = [{ id: "k", type: "keys", tracks: [{ bone: "thigh", axis: "vertical", keys: [{ t: 0, v: 40 }] }] }];
  const pl = legProject(lift, { bones: ["foot"], mode: "floor", ik: true });
  close(worldPose(rig, posePartsAt(pl, rig, pl.clips[0], 0)).T[3][1], 1 - Math.cos(40 * DEG), 1e-9, "перенос");
});

import { readdirSync, readFileSync } from "node:fs";
import { samplePreset as sampleTween } from "./tweens.ts";

test("библиотека: параметры пресетов есть в рецептах и в пределах, у всех есть происхождение", () => {
  const dir = new URL("../../../library/presets/", import.meta.url);
  const problems: string[] = [];
  for (const f of readdirSync(dir).filter((f) => f.endsWith(".json"))) {
    const lib = JSON.parse(readFileSync(new URL(f, dir), "utf8"));
    const def = RECIPES[lib.recipe];
    if (!def) { problems.push(`${f}: нет рецепта ${lib.recipe}`); continue; }
    for (const p of lib.presets) {
      if (!p.provenance?.length) problems.push(`${p.name}: нет provenance`);
      for (const [k, v] of Object.entries(p.params)) {
        const spec = def.params[k];
        if (!spec) problems.push(`${p.name}: у ${lib.recipe} нет параметра ${k}`);
        else if (spec.type === "number" && ((spec.min != null && (v as number) < spec.min) || (spec.max != null && (v as number) > spec.max))) problems.push(`${p.name}: ${k}=${v} вне ${spec.min}…${spec.max}`);
        else if (spec.type === "enum" && !spec.options!.includes(v as string)) problems.push(`${p.name}: ${k}=${v} не из ${spec.options}`);
      }
    }
  }
  const tdir = new URL("../../../library/tweens/", import.meta.url);
  const names = new Set<string>();
  for (const f of readdirSync(tdir).filter((f) => f.endsWith(".json"))) {
    for (const p of JSON.parse(readFileSync(new URL(f, tdir), "utf8")).presets) {
      if (names.has(p.name)) problems.push(`твин ${p.name} повторяется`);
      names.add(p.name);
      if (!p.provenance?.length) problems.push(`твин ${p.name}: нет provenance`);
      for (let t = 0; t <= p.duration; t += p.duration / 20) for (const v of Object.values(sampleTween(p, t))) if (!Number.isFinite(v)) problems.push(`твин ${p.name}: не число при t=${t}`);
    }
  }
  assert.deepEqual(problems, []);
});

import { QUAD as QUADT, periodic, strikePlan, strikePos, swingEase } from "./recipes.ts";
import { clipEvents } from "./evaluate.ts";

test("взмах: пик скорости в доле a, края без скорости", () => {
  const a = 0.3, h = 1e-5;
  const v = (u: number) => (swingEase(u + h, a) - swingEase(u - h, a)) / (2 * h);
  close(swingEase(a, a), a, 1e-12);
  close(v(a), 2, 1e-3, "пик = 2 (площадь треугольника = 1)");
  assert.ok(v(a - 0.05) < v(a) && v(a + 0.05) < v(a));
  close(v(1e-4), 0, 1e-3); close(v(1 - 1e-4), 0, 1e-3);
});

test("удар: контакт через hitLag после пика скорости руки, серия через interval, всё ускоряется tempo", () => {
  const c = RECIPES["melee-strike"];
  const p = withDefaults(c, { hits: 3, firstHit: 0.6, interval: 0.4, strike: 0.2, follow: 0.2, hitLag: 0.05, tempo: 2 });
  const pl = strikePlan(p);
  assert.deepEqual(pl.hits.map((x) => +x.toFixed(9)), [0.3, 0.5, 0.7]);
  // скорость руки максимальна за hitLag/tempo до каждого контакта
  // пик скорости руки — до каждого контакта, в пределах hitLag + 0.06
  const arm = (t: number) => -c.evaluate(p, 0, 2, t).pitch!; // −pitch: рука вперёд-вверх
  const sp = (t: number) => Math.abs(arm(t + 1e-5) - arm(t - 1e-5));
  for (const hit of pl.hits) {
    let best = hit - 0.1;
    for (let t = hit - 0.1; t < hit + 0.05; t += 0.0005) if (sp(t) > sp(best)) best = t;
    assert.ok(best < hit && best > hit - 0.025 - 0.06, `пик ${best} у удара ${hit}`);
  }
  // взмахи чередуются: в концах взмахов рука в замахе и в доводке
  close(strikePos(p, pl.s0).pos, 1, 1e-9); close(strikePos(p, pl.s0 + pl.swing).pos, -1, 1e-9); close(strikePos(p, pl.s0 + 2 * pl.swing).pos, 1, 1e-9);
  // в контакте локоть прямее, чем в замахе
  assert.ok(Math.abs(c.evaluate(p, 1, 2, pl.hits[0] - 0.025).pitch!) < Math.abs(c.evaluate(p, 1, 2, pl.s0).pitch!));
  assert.ok(c.evaluate(p, 1, 2, pl.s0).pitch! < 0, "локоть сгибается вперёд (−pitch), а не назад");
  // одиночный удар: в конце взмаха рука в доводке, на полпути возврата — половина, после — покой
  const one = withDefaults(c, { hits: 1, followAngle: 30, recover: 0.4 });
  const p1 = strikePlan(one);
  const a1 = (t: number) => -c.evaluate(one, 0, 2, t).pitch!;
  close(a1(p1.end), 30, 1e-9); close(a1(p1.end + 0.2), 15, 1e-9); close(a1(p1.end + 0.4), 0, 1e-9);
  const ev = c.events!(p);
  assert.deepEqual(ev.filter((e) => e.name === "hit").map((e) => e.t), [0.3, 0.5, 0.7]);
  close(ev.find((e) => e.name === "whoosh")!.t, 0.3 - 0.115 / 2, 1e-4);
  close(ev.find((e) => e.name === "window_close")!.t, pl.end + (0.4 + 0.9) / 2, 1e-4);
});

test("заряд: в удержании рука в замахе и таз пружинит, удары в hit1/hit2 после удержания", () => {
  const c = RECIPES["charge-release"];
  const p = withDefaults(c, {});
  close(-c.evaluate(p, 0, 2, 2.0).pitch!, 140, 1e-9, "держит замах");
  const pel = (t: number) => c.evaluate({ ...p, role: "pelvis" }, 0, 1, t, { height: 1 }).move_up!;
  close(pel(1.7), -0.15, 1e-9, "присед в начале удержания");
  close(pel(1.7 + 0.4), -0.15 - 0.058, 1e-9, "середина пружинки");
  assert.deepEqual(c.events!(p).filter((e) => e.name === "hit").map((e) => e.t), [2.9, 3.55]);
  // пик угловой скорости руки — незадолго до первого удара (контакт после пика)
  const sp = (t: number) => Math.abs(c.evaluate(p, 0, 2, t + 1e-5).pitch! - c.evaluate(p, 0, 2, t - 1e-5).pitch!);
  let best = 0;
  for (let t = 2.5; t < 3.2; t += 0.001) if (sp(t) > sp(best)) best = t;
  close(best, 2.9 - 0.053, 0.002, "пик скорости руки ровно за hitLag до удара");
});

test("события клипа: повторы от ролей одного удара убраны, вне клипа — отброшены", () => {
  const layer = (id: string, role: string) => ({ id, type: "recipe" as const, recipe: "melee-strike", target: { chain: "x" }, params: { role, tail: 5 } });
  const ev = clipEvents({ name: "c", duration: 2, fps: 30, loop: false, layers: [layer("a", "arm"), layer("b", "core")] });
  assert.equal(ev.filter((e) => e.name === "hit").length, 1);
  assert.equal(ev.some((e) => e.name === "window_close"), false, "окно закрывается за пределами клипа");
});

import { detectForward, detectRig } from "./rig.ts";
import { vsub, type Vec3 } from "./math.ts";

// Гуманоид 1.8 м, лицом к +Z, левая сторона — +X. Имена — по соглашению, геометрия одна.
const HUMAN: [string, string | null, Vec3][] = [
  ["hips", null, [0, 1.0, 0]], ["spine", "hips", [0, 1.15, 0]], ["spine1", "spine", [0, 1.3, 0]], ["chest", "spine1", [0, 1.42, 0]],
  ["neck", "chest", [0, 1.55, 0]], ["head", "neck", [0, 1.65, 0]], ["headtop", "head", [0, 1.85, 0]],
  ["eye_l", "head", [0.03, 1.72, 0.08]], ["eye_r", "head", [-0.03, 1.72, 0.08]],
  ["clav_l", "chest", [0.05, 1.5, 0]], ["uarm_l", "clav_l", [0.18, 1.5, 0]], ["farm_l", "uarm_l", [0.45, 1.5, 0]], ["hand_l", "farm_l", [0.7, 1.5, 0]], ["finger_l", "hand_l", [0.8, 1.5, 0]],
  ["clav_r", "chest", [-0.05, 1.5, 0]], ["uarm_r", "clav_r", [-0.18, 1.5, 0]], ["farm_r", "uarm_r", [-0.45, 1.5, 0]], ["hand_r", "farm_r", [-0.7, 1.5, 0]], ["finger_r", "hand_r", [-0.8, 1.5, 0]],
  ["thigh_l", "hips", [0.1, 0.95, 0]], ["shin_l", "thigh_l", [0.1, 0.5, 0]], ["foot_l", "shin_l", [0.1, 0.08, 0]], ["toe_l", "foot_l", [0.1, 0.0, 0.15]],
  ["thigh_r", "hips", [-0.1, 0.95, 0]], ["shin_r", "thigh_r", [-0.1, 0.5, 0]], ["foot_r", "shin_r", [-0.1, 0.08, 0]], ["toe_r", "foot_r", [-0.1, 0.0, 0.15]],
];
const CONV: Record<string, Record<string, string>> = {
  mixamo: { hips: "mixamorig:Hips", spine: "mixamorig:Spine", spine1: "mixamorig:Spine1", chest: "mixamorig:Spine2", neck: "mixamorig:Neck", head: "mixamorig:Head", headtop: "mixamorig:HeadTop_End",
    eye_l: "mixamorig:LeftEye", eye_r: "mixamorig:RightEye", clav_l: "mixamorig:LeftShoulder", uarm_l: "mixamorig:LeftArm", farm_l: "mixamorig:LeftForeArm", hand_l: "mixamorig:LeftHand", finger_l: "mixamorig:LeftHandIndex1",
    clav_r: "mixamorig:RightShoulder", uarm_r: "mixamorig:RightArm", farm_r: "mixamorig:RightForeArm", hand_r: "mixamorig:RightHand", finger_r: "mixamorig:RightHandIndex1",
    thigh_l: "mixamorig:LeftUpLeg", shin_l: "mixamorig:LeftLeg", foot_l: "mixamorig:LeftFoot", toe_l: "mixamorig:LeftToeBase", thigh_r: "mixamorig:RightUpLeg", shin_r: "mixamorig:RightLeg", foot_r: "mixamorig:RightFoot", toe_r: "mixamorig:RightToeBase" },
  unreal: { hips: "pelvis", spine: "spine_01", spine1: "spine_02", chest: "spine_03", neck: "neck_01", head: "head", headtop: "head_end", eye_l: "FACIAL_L_Eye", eye_r: "FACIAL_R_Eye",
    clav_l: "clavicle_l", uarm_l: "upperarm_l", farm_l: "lowerarm_l", hand_l: "hand_l", finger_l: "index_01_l", clav_r: "clavicle_r", uarm_r: "upperarm_r", farm_r: "lowerarm_r", hand_r: "hand_r", finger_r: "index_01_r",
    thigh_l: "thigh_l", shin_l: "calf_l", foot_l: "foot_l", toe_l: "ball_l", thigh_r: "thigh_r", shin_r: "calf_r", foot_r: "foot_r", toe_r: "ball_r" },
  max: { hips: "Bip01 Pelvis", spine: "Bip01 Spine", spine1: "Bip01 Spine1", chest: "Bip01 Spine2", neck: "Bip01 Neck", head: "Bip01 Head", headtop: "Bip01 HeadNub", eye_l: "Bip01 L Eye", eye_r: "Bip01 R Eye",
    clav_l: "Bip01 L Clavicle", uarm_l: "Bip01 L UpperArm", farm_l: "Bip01 L Forearm", hand_l: "Bip01 L Hand", finger_l: "Bip01 L Finger0", clav_r: "Bip01 R Clavicle", uarm_r: "Bip01 R UpperArm", farm_r: "Bip01 R Forearm", hand_r: "Bip01 R Hand", finger_r: "Bip01 R Finger0",
    thigh_l: "Bip01 L Thigh", shin_l: "Bip01 L Calf", foot_l: "Bip01 L Foot", toe_l: "Bip01 L Toe0", thigh_r: "Bip01 R Thigh", shin_r: "Bip01 R Calf", foot_r: "Bip01 R Foot", toe_r: "Bip01 R Toe0" },
  rigify: { hips: "DEF-pelvis", spine: "DEF-spine", spine1: "DEF-spine.001", chest: "DEF-spine.003", neck: "DEF-neck", head: "DEF-head", headtop: "DEF-head.end", eye_l: "DEF-eye.L", eye_r: "DEF-eye.R",
    clav_l: "DEF-shoulder.L", uarm_l: "DEF-upper_arm.L", farm_l: "DEF-forearm.L", hand_l: "DEF-hand.L", finger_l: "DEF-f_index.01.L", clav_r: "DEF-shoulder.R", uarm_r: "DEF-upper_arm.R", farm_r: "DEF-forearm.R", hand_r: "DEF-hand.R", finger_r: "DEF-f_index.01.R",
    thigh_l: "DEF-thigh.L", shin_l: "DEF-shin.L", foot_l: "DEF-foot.L", toe_l: "DEF-toe.L", thigh_r: "DEF-thigh.R", shin_r: "DEF-shin.R", foot_r: "DEF-foot.R", toe_r: "DEF-toe.R" },
};
function humanSkel(names: Record<string, string> | null): Skeleton {
  const pos = new Map(HUMAN.map(([n, , p]) => [n, p]));
  const nm = (n: string) => (names ? names[n] : `bone${HUMAN.findIndex((h) => h[0] === n)}`);
  return { nodes: [{ name: "Armature", parent: null, restT: [0, 0, 0], restR: [0, 0, 0, 1], restS: [1, 1, 1], isJoint: false },
    ...HUMAN.map(([n, par, p]) => ({ name: nm(n), parent: par ? nm(par) : "Armature", restT: (par ? vsub(p, pos.get(par)!) : p) as Vec3, restR: [0, 0, 0, 1] as Quat, restS: [1, 1, 1] as Vec3, isJoint: true }))] };
}

test("распознавание скелета: Mixamo, Unreal, 3ds Max Biped, Rigify и скелет без имён дают одни и те же части тела", () => {
  const want = { pelvis: ["hips"], chest: ["chest"], head: ["head"], arm_l: ["uarm_l", "farm_l"], arm_r: ["uarm_r", "farm_r"], leg_l: ["thigh_l", "shin_l"], leg_r: ["thigh_r", "shin_r"] };
  for (const [conv, names] of [...Object.entries(CONV), ["без имён", null] as const]) {
    const sk = humanSkel(names as any);
    const det = detectRig(sk, { up: [0, 1, 0] });
    const nm = (n: string) => (names ? (names as any)[n] : `bone${HUMAN.findIndex((h) => h[0] === n)}`);
    for (const [chain, bones] of Object.entries(want)) assert.deepEqual((det.chains as any)[chain], bones.map(nm), `${conv}: ${chain} (${det.method[chain as "head"]})`);
    assert.deepEqual([det.feet.l, det.feet.r], [nm("foot_l"), nm("foot_r")], `${conv}: ступни`);
    assert.deepEqual(det.notes, [], conv);
    const methods = new Set(Object.keys(want).map((c) => det.method[c as "head"]));
    assert.deepEqual([...methods], [names ? "names" : "geometry"], `${conv}: способ`);
  }
});

test("куда смотрит персонаж: по меткам сторон и по носкам, в том числе у развёрнутой модели", () => {
  const turn = (sk: Skeleton): Skeleton => ({ nodes: sk.nodes.map((n) => (n.parent === null ? { ...n, restR: [0, 1, 0, 0] as Quat } : n)) }); // 180° вокруг Y
  for (const names of [CONV.mixamo, null]) {
    const sk = humanSkel(names);
    const f = detectForward(sk);
    assert.deepEqual(f.forward.map((x) => +x.toFixed(6) + 0), [0, 0, 1], `${f.by}`);
    assert.equal(f.by, names ? "names" : "toes");
    // сдвинутая вбок модель: стороны считаются от центра скелета
    const shifted: Skeleton = { nodes: sk.nodes.map((n) => (n.parent === null ? { ...n, restT: [5, 0, 0] as Vec3 } : n)) };
    assert.deepEqual(detectRig(shifted, { up: [0, 1, 0] }).notes, [], "сдвиг на 5 м по X");
    const back = detectForward(turn(sk)).forward.map((x) => +x.toFixed(6) + 0);
    assert.deepEqual(back, [0, 0, -1], "развёрнутая на 180°");
    // распознавание с найденным forward у развёрнутой модели всё ещё видит левую ногу слева
    const det = detectRig(turn(sk), { up: [0, 1, 0], forward: [0, 0, -1] });
    const nm = (n: string) => (names ? (names as any)[n] : `bone${HUMAN.findIndex((h) => h[0] === n)}`);
    assert.deepEqual(det.chains.leg_l, [nm("thigh_l"), nm("shin_l")]);
    assert.deepEqual(det.notes, []);
  }
});

test("оси тела и выравнивание позы: рука из T-позы опускается, потом мах вперёд работает у любого рига", () => {
  // левая рука в T-позе вдоль +X (локальная +Y → +X) и нарочно закручена вокруг себя на 37°
  const tw = 37 * DEG / 2, tpose = qmul([0, 0, -Math.SQRT1_2, Math.SQRT1_2], [0, Math.sin(tw), 0, Math.cos(tw)]);
  const sk: Skeleton = { nodes: [
    { name: "chest", parent: null, restT: [0, 1.4, 0], restR: [0, 0, 0, 1], restS: [1, 1, 1], isJoint: true },
    { name: "ua", parent: "chest", restT: [0.2, 0, 0], restR: tpose, restS: [1, 1, 1], isJoint: true },
    { name: "fa", parent: "ua", restT: [0, 0.3, 0], restR: [0, 0, 0, 1], restS: [1, 1, 1], isJoint: true },
    { name: "hand", parent: "fa", restT: [0, 0.25, 0], restR: [0, 0, 0, 1], restS: [1, 1, 1], isJoint: true },
  ] };
  const rig = buildRig(sk);
  close(rig.worldT[3][0], 0.2 + 0.55, 1e-9, "T-поза: кисть вбок");
  const pr = (layers: any[], align?: any): Project => ({ version: 1, name: "t", model: "", up: [0, 1, 0], chains: { arm_l: ["ua", "fa"] }, ...(align ? { align } : {}),
    clips: [{ name: "c", duration: 1, fps: 10, loop: true, layers }] });
  const hand = (p: Project) => worldPose(rig, posePartsAt(p, rig, p.clips[0], 0)).T[3];
  const down = hand(pr([], { arm_l: { to: "down" } }));
  close(down[0], 0.2, 1e-9); close(down[1], 1.4 - 0.55, 1e-9, "опущена вниз");
  const ab = hand(pr([], { arm_l: { to: "down", abduct: 30 } }));
  close(ab[0], 0.2 + 0.55 * Math.sin(30 * DEG), 1e-9, "A-поза: отведена наружу");
  // мах −pitch 40° после выравнивания: кисть уходит вперёд (+Z) и вверх
  const sw = hand(pr([{ id: "k", type: "keys", tracks: [{ bone: "ua", axis: "pitch", keys: [{ t: 0, v: -40 }] }] }], { arm_l: { to: "down" } }));
  close(sw[2], 0.55 * Math.sin(40 * DEG), 1e-9, "вперёд"); close(sw[0], 0.2, 1e-9, "в своей плоскости");
  // +bank отводит руку наружу (влево у левой), как и задумано для бокового маха
  const bk = hand(pr([{ id: "k", type: "keys", tracks: [{ bone: "ua", axis: "bank", keys: [{ t: 0, v: 30 }] }] }], { arm_l: { to: "down" } }));
  close(Math.abs(bk[0] - 0.2), 0.55 * Math.sin(30 * DEG), 1e-9, "боковой мах"); close(bk[2], 0, 1e-9);
  // rig.detect: T-позу (90° от «вниз») опускает, а висящую руку не трогает
  const sg = suggestAlign(rig, pr([]));
  close(sg.angles.arm_l, 90, 0.1); assert.deepEqual(sg.align, { arm_l: { to: "down", abduct: 8 } });
  const hung = buildRig({ nodes: sk.nodes.map((n) => n.name === "ua" ? { ...n, restR: [0, 0, 1, 0] as Quat } : n) });
  close(suggestAlign(hung, pr([])).angles.arm_l, 0, 0.1); assert.deepEqual(suggestAlign(hung, pr([])).align, {});
});

test("масштаб корня (FBX в сантиметрах) входит в rest-мир: IK и пол работают в тех же метрах, что и экспорт", () => {
  const sk: Skeleton = { nodes: [
    { name: "Armature", parent: null, restT: [0, 0, 0], restR: [0, 0, 0, 1], restS: [0.01, 0.01, 0.01], isJoint: false },
    { name: "hips", parent: "Armature", restT: [0, 100, 0], restR: [0, 0, 0, 1], restS: [1, 1, 1], isJoint: true },
    { name: "knee", parent: "hips", restT: [0, -50, 0], restR: [0, 0, 0, 1], restS: [1, 1, 1], isJoint: true },
  ] };
  const rig = buildRig(sk);
  close(rig.worldT[1][1], 1, 1e-9, "таз на метре"); close(rig.worldT[2][1], 0.5, 1e-9, "колено");
  const w = worldPose(rig, posePartsAt({ version: 1, name: "t", model: "", up: [0, 1, 0], chains: {}, clips: [] }, rig, { name: "c", duration: 1, fps: 10, loop: true, layers: [] }, 0));
  close(w.T[2][1], rig.worldT[2][1], 1e-9, "rest и FK согласны");
  // сдвиг таза на 0.1 м в мире = 10 локальных сантиметров
  const mv = worldPose(rig, posePartsAt({ version: 1, name: "t", model: "", up: [0, 1, 0], chains: {}, clips: [] }, rig, { name: "c", duration: 1, fps: 10, loop: true,
    layers: [{ id: "k", type: "keys", tracks: [{ bone: "hips", axis: "move_up", keys: [{ t: 0, v: 0.1 }] }] }] } as any, 0));
  close(mv.T[1][1], 1.1, 1e-9, "move_up в метрах");
});

// ── четвероногие ──
import { detectQuadruped } from "./rig.ts";

/** Безымянное четвероногое (кости b0, b1…), смотрит на +X: таз → 3 позвонка → шея → голова, хвост, 4 лапы по 3 кости. */
function quadSkel(hindFirst = false): Skeleton {
  const pts: [string, string | null, Vec3][] = [
    ["hip", null, [-0.5, 0.6, 0]], ["sp1", "hip", [-0.15, 0.62, 0]], ["sp2", "sp1", [0.2, 0.62, 0]], ["chest", "sp2", [0.5, 0.62, 0]],
    ["neck", "chest", [0.7, 0.8, 0]], ["head", "neck", [0.85, 0.95, 0]], ["nose", "head", [1.05, 0.9, 0]],
    ["tail1", "hip", [-0.75, 0.62, 0]], ["tail2", "tail1", [-1.0, 0.55, 0]],
  ];
  // у правых лап z < 0: смотрит на +X, вверх +Y → влево = up × forward = −Z… проверяем: Y × X = −Z, значит левые при z < 0
  const L = [["fl", 0.5, -0.12, "chest"], ["fr", 0.5, 0.12, "chest"], ["hl", -0.5, -0.12, "hip"], ["hr", -0.5, 0.12, "hip"]] as const;
  for (const [tag, x, z, at] of hindFirst ? [L[2], L[3], L[0], L[1]] : L) {
    pts.push([`${tag}0`, at, [x, 0.55, z]], [`${tag}1`, `${tag}0`, [x + 0.02, 0.3, z]], [`${tag}2`, `${tag}1`, [x, 0.05, z]], [`${tag}3`, `${tag}2`, [x + 0.08, 0.0, z]]);
  }
  const pos = new Map(pts.map(([n, , p]) => [n, p]));
  const nm = (n: string) => `b${pts.findIndex((h) => h[0] === n)}`;
  return { nodes: pts.map(([n, par, p]) => ({ name: nm(n), parent: par ? nm(par) : null, restT: (par ? vsub(p, pos.get(par)!) : p) as Vec3, restR: [0, 0, 0, 1] as Quat, restS: [1, 1, 1] as Vec3, isJoint: true })) };
}
const qn = (sk: Skeleton, n: string) => sk.nodes[["hip", "sp1", "sp2", "chest", "neck", "head", "nose", "tail1", "tail2"].indexOf(n)]?.name;

test("четвероногое без имён: лапы, перед-зад по голове, стороны, спина, шея, хвост; двуногое — не четвероногое", () => {
  const sk = quadSkel();
  const d = detectQuadruped(sk)!;
  assert.ok(d, "узнано");
  d.forward.forEach((v, k) => close(v, [1, 0, 0][k], 1e-6, "вперёд к голове"));
  const leg = (tag: string) => [0, 1, 2, 3].map((k) => sk.nodes[9 + ["fl", "fr", "hl", "hr"].indexOf(tag) * 4 + k].name);
  assert.deepEqual(d.chains.arm_l, leg("fl")); assert.deepEqual(d.chains.arm_r, leg("fr"));
  assert.deepEqual(d.chains.leg_l, leg("hl")); assert.deepEqual(d.chains.leg_r, leg("hr"));
  assert.deepEqual(d.chains.pelvis, [qn(sk, "hip")]); assert.deepEqual(d.chains.chest, [qn(sk, "chest")]);
  assert.deepEqual(d.chains.spine, ["sp1", "sp2", "chest"].map((n) => qn(sk, n)));
  assert.deepEqual(d.chains.neck, [qn(sk, "neck")]); assert.deepEqual(d.chains.head, [qn(sk, "head")]);
  assert.deepEqual(d.chains.tail, ["tail1", "tail2"].map((n) => qn(sk, n)));
  // развёрнутое на 180° (голова к −X): перед и зад, лево и право меняются местами
  const flip: Skeleton = { nodes: sk.nodes.map((n) => (n.parent ? n : { ...n, restR: [0, 1, 0, 0] as Quat })) };
  const f = detectQuadruped(flip)!;
  close(f.forward[0], -1, 1e-6); assert.deepEqual(f.chains.arm_l, leg("fl"), "лево — по телу, а не по миру");
  // задние лапы записаны в файле раньше передних — перед всё равно там, где голова
  const hf = quadSkel(true), byName = (sk2: Skeleton, i: number) => sk2.nodes[i].name;
  assert.deepEqual(detectQuadruped(hf)!.chains.arm_l, [0, 1, 2, 3].map((k) => byName(hf, 17 + k)), "передняя левая");
  // человек: две стопы — не четвероногое; и с костями-помощниками на полу (корень движения, цели IK) тоже
  const hs = humanSkel(null);
  assert.equal(detectQuadruped(hs), null);
  const hips = hs.nodes.find((n) => n.parent === "Armature")!;
  const help = (nm: string, z: number) => ({ name: nm, parent: hips.name, restT: vsub([0, 0, z], hips.restT) as Vec3, restR: [0, 0, 0, 1] as Quat, restS: [1, 1, 1] as Vec3, isJoint: true });
  assert.equal(detectQuadruped({ nodes: [...hs.nodes, help("helper_a", 0.5), help("helper_b", -0.5)] }), null, "помощники на полу — не лапы");
});

test("quadruped-gait: лапа выносится к своей фазе, вынос быстрый (опора ≈ 70 % цикла), корпус не уносит бедро", () => {
  const def = RECIPES["quadruped-gait"];
  const P = (o: Record<string, unknown>) => withDefaults(def, o);
  const p = P({ role: "leg_hl", body: 0 });
  // в свою фазу бедро дальше всего впереди: −pitch = таблица[0] = 17.1
  const at = (pp: any, s: number, i = 0, n = 4) => -def.evaluate(pp, i, n, s * pp.period).pitch!;
  close(at(p, p.offsetHL), 17.1, 1e-9, "фаза задней левой");
  let best = -1e9, arg = 0;
  for (let k = 0; k < 400; k++) { const v = at(p, k / 400); if (v > best) { best = v; arg = k / 400; } }
  // пик бедра — раньше выноса лапы (лапу дотягивает колено): в таблице он на отсчёте 18 из 20
  const tab = QUADT.walk.hind[0], kmax = tab.indexOf(Math.max(...tab));
  close(((arg - p.offsetHL - kmax / 20) % 1 + 1.5) % 1 - 0.5, 0, 0.03, "пик бедра сдвинут на фазу лапы");
  // передняя: доля цикла, когда плечо идёт назад (опора) — около 0.7, а не 0.5, как у синуса
  const f = P({ role: "leg_fl", body: 0 });
  let back = 0;
  for (let k = 0; k < 400; k++) if (at(f, (k + 1) / 400) < at(f, k / 400)) back++;
  assert.ok(back / 400 > 0.64 && back / 400 < 0.8, `опора ${back / 400}`);
  // корпус качнули носом вверх — бедро от вертикали мира не меняется: таз + бедро = таблица
  const full = P({ role: "leg_hl", gait: "run" }), pel = P({ role: "pelvis", gait: "run" });
  for (const s of [0.1, 0.37, 0.8]) {
    const sum = def.evaluate(pel, 0, 1, s * pel.period).pitch! + def.evaluate(full, 0, 4, s * full.period).pitch!;
    close(-sum, periodic(QUADT.run.hind[0], s - full.offsetHL), 1e-9, "бедро в мире");
  }
  // корпус в галопе качается заметно (±11°), а в шаге почти нет
  const amp = (g: string) => Math.max(...[...Array(50).keys()].map((k) => Math.abs(def.evaluate(P({ role: "pelvis", gait: g }), 0, 1, (k / 50) * P({ gait: g }).period).pitch!)));
  assert.ok(amp("run") > 9 && amp("walk") < 2, `корпус: галоп ${amp("run")}, шаг ${amp("walk")}`);
  // в шаге корпус кивает дважды за цикл (2-я гармоника): через полцикла — тот же наклон, в галопе — обратный
  const corr = (g: string) => [...Array(40).keys()].reduce((a, k) => { const pp = P({ role: "pelvis", gait: g }); const v = (u: number) => def.evaluate(pp, 0, 1, u * pp.period).pitch!; return a + v(k / 40) * v(k / 40 + 0.5); }, 0);
  assert.ok(corr("walk") > 0 && corr("run") < 0, `кивки: шаг ${corr("walk")}, галоп ${corr("run")}`);
  // у длинной цепочки (лопатка + 4 кости) лопатку не трогаем
  assert.deepEqual(def.evaluate(P({ role: "leg_fl" }), 0, 5, 0.1), {});
  close(at(P({ role: "leg_fl", body: 0 }), 0, 1, 5), 36.8, 1e-9, "плечо — вторая кость");
  // подскок — доля высоты таза
  const b = (h: number) => def.evaluate(P({ role: "pelvis", gait: "run" }), 0, 1, 0.13, { height: h }).move_up!;
  close(b(2), 2 * b(1), 1e-12); assert.ok(Math.abs(b(1)) > 0.01);
});

// ── многоногие ──
import { detectMultiLeg } from "./rig.ts";
import { legProfile, multilegPhase } from "./recipes.ts";

/** Шестиногое без смысловых имён у ног, смотрит на +X: грудь, голова с двумя усиками, брюшко; ноги «колено вверх». */
function hexSkel(compact = false): Skeleton {
  const pts: [string, string | null, Vec3][] = [
    ["thorax", null, [0, 0.2, 0]], ["head", "thorax", [0.25, 0.22, 0]], ["ant_a", "head", [0.45, 0.35, -0.1]], ["ant_b", "head", [0.45, 0.35, 0.1]],
    ["abd1", "thorax", [-0.2, 0.22, 0]], ["abd2", "abd1", [-0.45, 0.25, 0]],
  ];
  // смотрит на +X, вверх +Y: влево = Y × X = −Z
  // compact — как у паука: основания ног кучно (вдоль 0.08, поперёк 0.16), а тело вытянуто
  const q = compact ? 0.04 : 0.15, wz = compact ? 0.08 : 0.05;
  for (const [tag, x, z] of [["a", q, -1], ["b", q, 1], ["c", 0, -1], ["d", 0, 1], ["e", -q, -1], ["f", -q, 1]] as const) {
    pts.push([`${tag}0`, "thorax", [x, 0.2, wz * z]], [`${tag}1`, `${tag}0`, [x, 0.32, 0.17 * z]], [`${tag}2`, `${tag}1`, [x, 0.02, 0.35 * z]], [`${tag}3`, `${tag}2`, [x, 0, 0.38 * z]]);
  }
  const pos = new Map(pts.map(([n, , p]) => [n, p]));
  return { nodes: pts.map(([n, par, p]) => ({ name: n === "head" || n === "thorax" || n.startsWith("abd") || n.startsWith("ant") ? n : `x${n}`, parent: par ? (par === "thorax" || par === "head" || par.startsWith("abd") ? par : `x${par}`) : null, restT: (par ? vsub(p, pos.get(par)!) : p) as Vec3, restR: [0, 0, 0, 1] as Quat, restS: [1, 1, 1] as Vec3, isJoint: true })) };
}

test("многоногое: шесть ног по парам спереди назад, стороны по телу, голова и брюшко; четвероногое и человек — не многоногие", () => {
  const sk = hexSkel();
  const d = detectMultiLeg(sk)!;
  assert.ok(d); assert.equal(d.legCount, 6);
  d.forward.forEach((v, k) => close(v, [1, 0, 0][k], 1e-6, "вперёд"));
  const leg = (tag: string) => [0, 1, 2, 3].map((k) => `x${tag}${k}`);
  assert.deepEqual(d.chains["leg_l0" as never], leg("a")); assert.deepEqual(d.chains["leg_r0" as never], leg("b"));
  assert.deepEqual(d.chains["leg_l1" as never], leg("c")); assert.deepEqual(d.chains["leg_r2" as never], leg("f"));
  assert.deepEqual(d.chains.head, ["head"]); assert.deepEqual(d.chains.tail, ["abd1", "abd2"]);
  assert.equal(detectMultiLeg(quadSkel()), null); assert.equal(detectMultiLeg(humanSkel(null)), null);
  // развёрнутое на 180°: перёд к −X, левая передняя — та же нога
  const flip: Skeleton = { nodes: sk.nodes.map((n) => (n.parent ? n : { ...n, restR: [0, 1, 0, 0] as Quat })) };
  const f = detectMultiLeg(flip)!;
  close(f.forward[0], -1, 1e-6, "развёрнутое"); assert.deepEqual(f.chains["leg_l0" as never], leg("a"));
  // компактное, как паук: ось — по телу, а не по основаниям ног
  const c = detectMultiLeg(hexSkel(true))!;
  close(Math.abs(c.forward[0]), 1, 1e-3, "ось вдоль тела"); assert.deepEqual(c.chains["leg_l0" as never], leg("a"));
});

test("multileg-gait: трипод при lag 0.5; опора — доля duty; стопа в опоре уходит назад, в переносе поднимается", () => {
  const p = withDefaults(RECIPES["multileg-gait"], { lag: 0.5, side: 0.5, duty: 0.5 });
  const ph = (s: "l" | "r", k: number) => multilegPhase(p, s, k, 0.13);
  close(ph("l", 0), ph("r", 1)); close(ph("l", 0), ph("l", 2)); close(ph("r", 0), ph("l", 1));
  close(((ph("l", 0) - ph("r", 0)) % 1 + 1) % 1, 0.5, 1e-9, "треноги в противофазе");
  // волна: при lag 0.2 задняя пара шагает раньше передней
  const w = withDefaults(RECIPES["multileg-gait"], { lag: 0.2 });
  close(((multilegPhase(w, "l", 2, 0) - multilegPhase(w, "l", 0, 0)) % 1 + 1) % 1, 0.4, 1e-9, "задняя опережает");
  // профиль: опора ровно duty, края непрерывны, подъём только в переносе
  let st = 0;
  for (let k = 0; k < 1000; k++) if (legProfile(k / 1000, 0.7).lift === 0) st++;
  close(st / 1000, 0.7, 0.002);
  close(legProfile(0.7 - 1e-9, 0.7).protract, legProfile(0.7, 0.7).protract, 1e-6); close(legProfile(1 - 1e-9, 0.7).protract, legProfile(0, 0.7).protract, 1e-6);
  // сквозь ядро: левая средняя нога шестиногого
  const sk = hexSkel(), rig = buildRig(sk), d = detectMultiLeg(sk)!;
  const project: Project = { version: 1, name: "h", model: "", up: [0, 1, 0], forward: d.forward, chains: d.chains as Record<string, string[]>,
    clips: [{ name: "w", duration: 1, fps: 30, loop: true, layers: [{ id: "g", type: "recipe", recipe: "multileg-gait", target: { chain: "leg_l1" }, params: { role: "leg_l1", period: 1, duty: 0.6, lag: 0, side: 0.5 } } as any] }] };
  const paw = (t: number) => worldPose(rig, posePartsAt(project, rig, project.clips[0], t)).T[rig.index.get("xc3")!];
  assert.ok(paw(0.05)[0] > paw(0.55)[0] + 0.05, `в опоре стопа уходит назад: ${paw(0.05)[0]} → ${paw(0.55)[0]}`);
  assert.ok(paw(0.8)[1] > paw(0.3)[1] + 0.03, `в переносе стопа выше: ${paw(0.8)[1]} против ${paw(0.3)[1]}`);
  assert.ok(Math.abs(paw(0.3)[1] - paw(0.1)[1]) < 0.02, "в опоре высота почти постоянна");
});

// ── крылья ──
import { detectWings } from "./rig.ts";
import { flapProfile } from "./recipes.ts";

test("крылья: размах больше 1.6 роста — крылья на всю длину, человек в T-позе — не крылатый", () => {
  // человек: руки в стороны, размах ≈ рост
  const hs = humanSkel(null), det = detectRig(hs, { up: [0, 1, 0] });
  assert.equal(detectWings(hs, [0, 1, 0], det), null, "T-поза — не крылья");
  // тот же скелет, но кисти отнесены втрое дальше в стороны: размах больше 1.6 роста
  const big: Skeleton = { nodes: hs.nodes.map((n) => { const i = HUMAN.findIndex((h) => `bone${HUMAN.indexOf(h)}` === n.name); const nm = i >= 0 ? HUMAN[i][0] : ""; return /^(farm|hand|finger)_/.test(nm) ? { ...n, restT: [n.restT[0] * 4, n.restT[1], n.restT[2]] as Vec3 } : n; }) };
  const w = detectWings(big, [0, 1, 0], detectRig(big, { up: [0, 1, 0] }));
  assert.ok(w, "крылатое");
  const nm = (n: string) => `bone${HUMAN.findIndex((h) => h[0] === n)}`;
  assert.equal(w!.wing_l[0], detectRig(big, { up: [0, 1, 0] }).chains.arm_l![0], "крыло от плеча");
  assert.equal(w!.wing_l[w!.wing_l.length - 1], nm("finger_l"), "до самого дальнего конца");
});

test("wing-flap: рабочий ход вниз — доля down; подъём поднимает оба крыла; кончик отстаёт", () => {
  close(flapProfile(0, 0.6), 1); close(flapProfile(0.6, 0.6), -1); close(flapProfile(0.3, 0.6), 0, 1e-9, "середина рабочего хода");
  let dn = 0;
  for (let k = 0; k < 1000; k++) if (flapProfile((k + 1) / 1000, 0.6) < flapProfile(k / 1000, 0.6)) dn++;
  close(dn / 1000, 0.6, 0.003, "доля хода вниз");
  // сквозь ядро: птица с крыльями вдоль ±Z (смотрит на +X); в верхней точке кончики выше плеч, внизу — ниже
  const nodes: Skeleton["nodes"] = [{ name: "body", parent: null, restT: [0, 1, 0], restR: [0, 0, 0, 1], restS: [1, 1, 1], isJoint: true }];
  for (const [s, z] of [["l", -1], ["r", 1]] as const) {
    nodes.push({ name: `w${s}0`, parent: "body", restT: [0, 0, 0.1 * z], restR: [0, 0, 0, 1], restS: [1, 1, 1], isJoint: true },
      { name: `w${s}1`, parent: `w${s}0`, restT: [0, 0, 0.4 * z], restR: [0, 0, 0, 1], restS: [1, 1, 1], isJoint: true },
      { name: `w${s}2`, parent: `w${s}1`, restT: [0, 0, 0.4 * z], restR: [0, 0, 0, 1], restS: [1, 1, 1], isJoint: true });
  }
  const sk: Skeleton = { nodes }, rig = buildRig(sk);
  const mk = (role: string, chain: string) => ({ id: role, type: "recipe", recipe: "wing-flap", target: { chain }, params: { role, period: 1, amp: 40, mean: 0, lag: 0.1 } }) as any;
  const project: Project = { version: 1, name: "b", model: "", up: [0, 1, 0], forward: [1, 0, 0], chains: { wing_l: ["wl0", "wl1", "wl2"], wing_r: ["wr0", "wr1", "wr2"] },
    clips: [{ name: "f", duration: 1, fps: 30, loop: true, layers: [mk("wing_l", "wing_l"), mk("wing_r", "wing_r")] }] };
  const tip = (s: string, t: number) => worldPose(rig, posePartsAt(project, rig, project.clips[0], t)).T[rig.index.get(`w${s}2`)!][1];
  for (const s of ["l", "r"]) {
    assert.ok(tip(s, 0.05) > 1.3, `${s}: вверху ${tip(s, 0.05)}`);
    assert.ok(tip(s, 0.6) < 0.7, `${s}: внизу ${tip(s, 0.6)}`);
  }
  // кончик отстаёт: в нижней точке плеча (u = down) кончик ещё идёт вниз
  const p = withDefaults(RECIPES["wing-flap"], { role: "wing_l", lag: 0.1 });
  const v = (i: number, t: number) => RECIPES["wing-flap"].evaluate(p, i, 3, t).vertical ?? 0;
  assert.ok(v(1, p.down * p.period + 0.01) < v(1, p.down * p.period - 0.01), "кончик ещё опускается");
});

// ── парение, удар щупальцем, появление ──
import { emergeCurve, strikeCurve } from "./recipes.ts";

test("tentacle-strike: замах назад, удар к моменту hit, удержание, возврат в ноль; хлыст — задержка на кость", () => {
  const d = RECIPES["tentacle-strike"], p = withDefaults(d, { windup: 0.8, windupT: 0.25, strikeT: 0.1, hold: 0.2, returnT: 0.6 });
  close(strikeCurve(p, 0.25), -0.8, 1e-9, "конец замаха"); close(strikeCurve(p, 0.35), 1, 1e-9, "удар"); close(strikeCurve(p, 0.5), 1, 1e-9, "удержание");
  close(strikeCurve(p, 1.2), 0, 1e-9, "вернулось"); close(strikeCurve(p, 0.25 - 1e-6), strikeCurve(p, 0.25 + 1e-6), 1e-4, "без скачка");
  assert.deepEqual(d.events!(p), [{ t: 0.35, name: "hit" }]);
  const w = withDefaults(d, { delay: 0.05 });
  const peak = (i: number) => { let b = -1, bt = 0; for (let k = 0; k < 2000; k++) { const v = d.evaluate(w, i, 6, k / 1000)[w.plane as "vertical"]!; if (v > b) { b = v; bt = k / 1000; } } return bt; };
  close(peak(4) - peak(0), 0.2, 0.002, "пик бежит по цепочке");
  assert.ok(Math.abs(d.evaluate(w, 5, 6, 0.6).vertical!) > Math.abs(d.evaluate(w, 0, 6, 0.4).vertical!), "к концу изгиб больше");
});

test("emerge: появление из глубины с перелётом и приседом; уход с замахом вверх", () => {
  const d = RECIPES.emerge;
  const up = withDefaults(d, { overshoot: 0.15, rise: 0.2, anticipation: 0.05, preT: 0.1 });
  close(emergeCurve(up, 0), 0); close(emergeCurve(up, 1), 1, 1e-9, "дошло");
  let mx = 0, mn = 0;
  for (let k = 0; k <= 1000; k++) { mx = Math.max(mx, emergeCurve(up, k / 1000)); mn = Math.min(mn, emergeCurve(up, k / 1000)); }
  close(mx, 1.15, 1e-3, "перелёт"); close(mn, -0.05, 1e-3, "присед");
  close(d.evaluate(withDefaults(d, {}), 0, 1, 0, { height: 2 }).move_up!, -2, 1e-9, "старт из глубины");
  const dn = withDefaults(d, { mode: "submerge", anticipation: 0.3, preT: 0.4 });
  close(emergeCurve(dn, 0), 1); close(emergeCurve(dn, 0.4), 1.3, 1e-9, "замах вверх"); close(emergeCurve(dn, 1), 0, 1e-9, "ушло");
  // без скачков: соседние отсчёты (шаг 0.001) отличаются меньше чем на 0.02
  for (const c of [up, dn]) for (let k = 0; k < 1000; k++) assert.ok(Math.abs(emergeCurve(c, (k + 1) / 1000) - emergeCurve(c, k / 1000)) < 0.02, `${c.mode}: скачок в ${k / 1000}`);
});

test("hover: подъём таза — доля его высоты, наклон вперёд постоянный, кивок вокруг него", () => {
  const d = RECIPES.hover, p = withDefaults(d, { role: "pelvis", bob: 0.12, lean: 15, pitch: 5 });
  const at = (t: number) => d.evaluate(p, 0, 1, t, { height: 1.65 });
  close(at(0.75 * p.period).move_up!, 0.12 * 1.65, 1e-9, "верх в пике 0.75");
  close(at(0.25 * p.period).move_up!, -0.12 * 1.65, 1e-9, "низ через полцикла");
  let s = 0; for (let k = 0; k < 100; k++) s += at((k / 100) * p.period).pitch!;
  close(s / 100, 15, 1e-6, "средний наклон");
});
