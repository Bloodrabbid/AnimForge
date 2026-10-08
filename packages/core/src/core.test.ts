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

import { posePartsAt, worldPose } from "./evaluate.ts";

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
  close(at("pelvis", t).roll! + at("chest", t).roll! + at("head", t).roll!, -6, 1e-9);
  close(at("pelvis", t).roll! + at("chest", t).roll!, -0.49 * 32, 1e-9, "плечи в мире");
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
