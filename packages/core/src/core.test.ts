// Тесты ядра. Каждый проверяет конкретное число, которое сломается при ошибке в формуле, — тест должен уметь падать.
import assert from "node:assert/strict";
import { test } from "node:test";
import { evalKeys } from "./curves.ts";
import { bakeClip, buildRig, chainAxes, poseAt } from "./evaluate.ts";
import { DEG, Quat, qmul, qinv, qrot } from "./math.ts";
import type { Project, Skeleton } from "./project.ts";
import { HUDDLE, RECIPES, withDefaults } from "./recipes.ts";
import { runCommand } from "./commands.ts";
import { emptyProject } from "./project.ts";

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

import { QUAD as QUADT, TOOL, glancePlan, periodic, strikePlan, strikePos, swingEase } from "./recipes.ts";
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

test("грудь — кость посередине тела: CC_Base_R_Breast (мягкая ткань со стороной) — не грудь", () => {
  const sk = humanSkel(CONV.unreal);
  sk.nodes.push({ name: "CC_Base_R_Breast", parent: "spine_03", restT: [-0.08, -0.1, 0.1], restR: [0, 0, 0, 1], restS: [1, 1, 1], isJoint: true });
  assert.deepEqual(detectRig(sk, { up: [0, 1, 0] }).chains.chest, ["spine_03"]);
});

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
import { detectFins, detectQuadruped } from "./rig.ts";

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
  close(d.evaluate(withDefaults(d, {}), 0, 1, 0, { height: 0, size: 3 }).move_up!, -3, 1e-9, "глубина — от роста существа, у основания высота 0");
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

test("тяжесть и корпус: поклон груди голема дважды за цикл, корпус кикиморы, нарастающий кивок ифрита", () => {
  const w = RECIPES["waddle-walk"];
  const g = withDefaults(w, { role: "chest", chestBow: 15, period: 1.8 });
  close(w.evaluate(g, 0, 1, 0).pitch!, 15, 1e-9); close(w.evaluate(g, 0, 1, 0.45).pitch!, -15, 1e-9, "через четверть цикла — обратно");
  close(w.evaluate(g, 0, 1, 0.9).pitch!, 15, 1e-9, "через полцикла — снова поклон");
  assert.equal(w.evaluate(withDefaults(w, { role: "chest" }), 0, 1, 0.3).pitch, undefined, "у Tools Up! поклона нет");
  const m = RECIPES["multileg-gait"], k = withDefaults(m, { role: "pelvis", pelvisYaw: 10, bob: 0.05, period: 1 });
  close(m.evaluate(k, 0, 1, 0.07).yaw!, 10, 1e-9, "пик рыскания таза");
  close(m.evaluate(k, 0, 1, 0, { height: 2 }).move_up!, 0.1, 1e-9); close(m.evaluate(k, 0, 1, 0.25, { height: 2 }).move_up!, -0.1, 1e-9, "подскок дважды за цикл");
  const c = withDefaults(m, { role: "chest", chestRoll: 17, pelvisYaw: 10, period: 1 });
  close(m.evaluate(c, 0, 1, 0.57).bank!, 17, 1e-9); close(m.evaluate(c, 0, 1, 0.07).yaw!, -6.7, 1e-9, "грудь против таза");
  const h = RECIPES.hover, hp = (role: string) => withDefaults(h, { role, pitch: 8, chestPitch: 37, headPitch: 48, lean: 0, period: 1 });
  for (const t of [0.1, 0.4, 0.7]) {
    const pel = h.evaluate(hp("pelvis"), 0, 1, t).pitch!, ch = h.evaluate(hp("chest"), 0, 1, t).pitch!, hd = h.evaluate(hp("head"), 0, 1, t).pitch!;
    close(pel + ch, 37 * Math.cos(2 * Math.PI * (t - 0.82)), 1e-9, "грудь в мире");
    close(pel + ch + hd, 48 * Math.cos(2 * Math.PI * (t - 0.67)), 1e-9, "голова в мире");
  }
});

test("recipe.add: пресет без параметров — ошибка, а не слой на умолчаниях под чужим именем", () => {
  const ctx = { project: project([]), skeleton: skel };
  assert.throws(() => runCommand(ctx, "recipe.add", { clip: "c", recipe: "wave", chain: "body", preset: "fish-fast" }), /preset\.apply/);
  runCommand(ctx, "recipe.add", { clip: "c", recipe: "wave", chain: "body", preset: "fish-fast", params: { period: 1.2 } });
  assert.equal((ctx.project.clips[0].layers[0] as any).params.period, 1.2);
});

test("layer.remove, layer.set, clip.remove: слои убираются и выключаются весом, поза меняется, клип удаляется", () => {
  const ctx = { project: project([]), skeleton: skel };
  runCommand(ctx, "recipe.add", { clip: "c", recipe: "wave", chain: "body", id: "w1", params: { tipAmp: 20 } });
  runCommand(ctx, "recipe.add", { clip: "c", recipe: "wave", chain: "body", id: "w2", params: { tipAmp: 20 } });
  const rig = buildRig(skel);
  const angle = () => {
    const q = poseAt(ctx.project, rig, ctx.project.clips[0], 0.2).get("c")!;
    return 2 * Math.acos(Math.min(1, Math.abs(qmul(q, qinv([0, 0, 0, 1]))[3]))) / DEG;
  };
  const both = angle();
  runCommand(ctx, "layer.set", { clip: "c", layer: "w2", weight: 0 });
  const one = angle();
  close(one * 2, both, 1e-6, "второй слой с весом 0 не добавляет поворот");
  runCommand(ctx, "layer.set", { clip: "c", layer: "w2", weight: 1 });
  assert.equal((ctx.project.clips[0].layers[1] as any).weight, undefined, "вес 1 — поле убрано");
  runCommand(ctx, "layer.remove", { clip: "c", layer: "w1,w2" });
  assert.equal(ctx.project.clips[0].layers.length, 0);
  assert.throws(() => runCommand(ctx, "layer.remove", { clip: "c", layer: "nope" }), /нет слоя/);
  runCommand(ctx, "clip.remove", { clip: "c" });
  assert.equal(ctx.project.clips.length, 0);
});

/** Черепаха без имён (кроме головы), смотрит на +X: корень, 2 передних ласта по 2 кости, задний блок с 2 ластами, голова. */
function turtleSkel(): Skeleton {
  const pts: [string, string | null, Vec3][] = [
    ["root", null, [0, 0.2, 0]], ["head", "root", [0.3, 0.25, 0]],
    ["fl0", "root", [0.1, 0.15, -0.15]], ["fl1", "fl0", [0.05, 0.08, -0.4]], ["fr0", "root", [0.1, 0.15, 0.15]], ["fr1", "fr0", [0.05, 0.08, 0.4]],
    ["back", "root", [-0.3, 0.12, 0]], ["hl", "back", [-0.4, 0.06, -0.2]], ["hr", "back", [-0.4, 0.06, 0.2]],
  ];
  const pos = new Map(pts.map(([n, , p]) => [n, p]));
  const nm = (n: string) => (n === "head" ? "head" : `j${pts.findIndex((h) => h[0] === n)}`);
  return { nodes: pts.map(([n, par, p]) => ({ name: nm(n), parent: par ? nm(par) : null, restT: (par ? vsub(p, pos.get(par)!) : p) as Vec3, restR: [0, 0, 0, 1] as Quat, restS: [1, 1, 1] as Vec3, isJoint: true })) };
}

test("ласты: пары веток в стороны — передняя wing_l/wing_r, задняя leg_l/leg_r, стороны по направлению к голове", () => {
  const sk = turtleSkel();
  const j = (n: string) => `j${["root", "head", "fl0", "fl1", "fr0", "fr1", "back", "hl", "hr"].indexOf(n)}`;
  const d = detectFins(sk)!;
  assert.ok(d, "ласты найдены");
  // смотрит на +X, верх +Y → влево = Y × X = −Z: левые ласты при z < 0
  assert.deepEqual(d.chains.wing_l, [j("fl0"), j("fl1")], "передний левый — оба звена");
  assert.deepEqual(d.chains.wing_r, [j("fr0"), j("fr1")]);
  assert.deepEqual(d.chains.leg_l, [j("hl")]);
  assert.deepEqual(d.chains.leg_r, [j("hr")]);
  assert.deepEqual(d.chains.pelvis, [j("root")]);
  assert.deepEqual(d.chains.head, ["head"]);
  assert.deepEqual(d.chains.tail, [j("back")]);
  close(d.forward[0], 1, 1e-6, "вперёд — к голове");
  // развёрнутая на −X: голова решает, где перёд, и стороны меняются (влево = Y × −X = +Z)
  const flip = turtleSkel();
  for (const n of flip.nodes) n.restT = [-n.restT[0], n.restT[1], n.restT[2]];
  const f = detectFins(flip)!;
  close(f.forward[0], -1, 1e-6, "развёрнутая смотрит на −X");
  assert.deepEqual(f.chains.wing_l, [j("fr0"), j("fr1")], "левый теперь при z > 0");
  // асимметричная «пара» — не ласты: сдвигаем один задний ласт вперёд
  const bad = turtleSkel();
  bad.nodes.find((n) => n.name === j("hr"))!.restT = [0.3, -0.06, 0.2];
  assert.equal(detectFins(bad)!.pairs, 1, "кривая пара отброшена, осталась передняя");
});

/** Безымянная птица после авторига: корень-таз, ноги вниз, крылья прямо из таза в стороны (±Z), голова вверх-вперёд; смотрит на +X. */
function birdSkel(legDown = true): Skeleton {
  const pts: [string, string | null, Vec3][] = [
    ["root", null, [0, 0.5, 0]], ["neck", "root", [0.1, 0.62, 0]], ["head", "neck", [0.2, 0.7, 0]],
    ["ll0", "root", [0, 0.4, -0.08]], ["ll1", "ll0", [0.02, 0.2, -0.08]], ["ll2", "ll1", [0.04, 0.0, -0.08]], ["ll3", "ll2", [0.12, 0.0, -0.08]],
    ["lr0", "root", [0, 0.4, 0.08]], ["lr1", "lr0", [0.02, 0.2, 0.08]], ["lr2", "lr1", [0.04, 0.0, 0.08]], ["lr3", "lr2", [0.12, 0.0, 0.08]],
    ["wl0", "root", [0, 0.55, -0.15]], ["wl1", "wl0", [0, 0.56, -0.5]], ["wl2", "wl1", [0, 0.56, -0.9]],
    ["wr0", "root", [0, 0.55, 0.15]], ["wr1", "wr0", [0, 0.56, 0.5]], ["wr2", "wr1", [0, 0.56, 0.9]],
  ];
  // «ласты» вместо ног: те же ветки, но уходят назад, почти горизонтально
  if (!legDown) for (const p of pts) if (/^l[lr]\d/.test(p[0])) { const k = Number(p[0][2]); p[2] = [-0.15 * (k + 1), 0.45 - 0.03 * k, p[2][2] * (1 + k)]; }
  const pos = new Map(pts.map(([n, , p]) => [n, p]));
  const nm = (n: string) => `j${pts.findIndex((h) => h[0] === n)}`;
  return { nodes: pts.map(([n, par, p]) => ({ name: nm(n), parent: par ? nm(par) : null, restT: (par ? vsub(p, pos.get(par)!) : p) as Vec3, restR: [0, 0, 0, 1] as Quat, restS: [1, 1, 1] as Vec3, isJoint: true })) };
}

test("геометрия без имён: крылья из таза находятся как руки → крылья; ветки вбок-назад — не ноги", () => {
  const sk = birdSkel(), project = { up: [0, 1, 0] as Vec3, forward: [1, 0, 0] as Vec3 };
  const det = detectRig(sk, project);
  assert.ok(det.chains.leg_l && det.chains.leg_r, "ноги вниз — ноги");
  assert.ok(det.chains.arm_l && det.chains.arm_r, `крылья из таза — руки: ${det.notes}`);
  const w = detectWings(sk, [0, 1, 0], det);
  assert.ok(w, "размах больше 1.6 роста — крылатое");
  const fins = detectRig(birdSkel(false), project);
  assert.equal(fins.chains.leg_l, undefined, "ветки назад-вбок — не ноги");
  assert.ok(fins.notes.some((n) => n.includes("вбок")), "в заметках — почему");
});

// ── веса кожи ──
import { boneWeight, setBoneWeight } from "./weights.ts";

test("веса: правка кости делит остаток между остальными пропорционально, сумма 1; новая кость — в лёгкий слот; остаток без соседей — родителю", () => {
  const sum = (w: number[]) => w.reduce((a, b) => a + b, 0);
  // 0.6 у кости 1, 0.3 у 2, 0.1 у 3 → кость 1 до 0.2: 2 и 3 делят 0.8 как 3:1
  let i = [1, 2, 3, 0], w = [0.6, 0.3, 0.1, 0];
  setBoneWeight(i, w, 1, 0.2, 9);
  close(boneWeight(i, w, 1), 0.2); close(boneWeight(i, w, 2), 0.6); close(boneWeight(i, w, 3), 0.2); close(sum(w), 1);
  // новой кости 7 нет в слотах — занимает самый лёгкий (пустой) слот
  i = [1, 2, 3, 0]; w = [0.5, 0.3, 0.2, 0];
  setBoneWeight(i, w, 7, 0.5, 9);
  close(boneWeight(i, w, 7), 0.5); close(boneWeight(i, w, 1), 0.25); close(sum(w), 1);
  // вершина целиком на кости 4: убираем вес — остаток уходит родителю 9, а не теряется
  i = [4, 0, 0, 0]; w = [1, 0, 0, 0];
  setBoneWeight(i, w, 4, 0.3, 9);
  close(boneWeight(i, w, 4), 0.3); close(boneWeight(i, w, 9), 0.7); close(sum(w), 1);
  // дубли одной кости в двух слотах сводятся
  i = [5, 5, 2, 0]; w = [0.3, 0.3, 0.4, 0];
  setBoneWeight(i, w, 5, 0.6, 9);
  close(boneWeight(i, w, 5), 0.6); close(sum(w), 1);
});

// ── ограничения ──
import { boneAngles } from "./limits.ts";
import { motionAt } from "./evaluate.ts";

test("ограничения: углы кости по осям совпадают с каналами; обрезка по одной оси не трогает другие; кость отмечена", () => {
  const rig = buildRig(skel);
  const key = (bone: string, axis: string, v: number) => ({ bone, axis, keys: [{ t: 0, v }] });
  const ang = (pr: Project, bone: string) => {
    const m = motionAt(pr, rig, pr.clips[0], 0);
    return { a: boneAngles(rig, pr, bone, m.rot.get(bone)!, m.base.get(bone)), limited: m.limited };
  };
  // у кости a поворот в rest (roll): каналы всё равно читаются как поставлены
  for (const [axis, v] of [["lateral", 30], ["vertical", -25], ["roll", 40]] as const) {
    const pr = project([{ id: "k", type: "keys", tracks: [key("a", axis, v)] }]);
    close(ang(pr, "a").a[axis]!, v, 1e-6, `${axis}`);
  }
  // изгиб вбок 50 при пределе ±20 → 20; изгиб по vertical 10 остаётся 10
  const pr = project([{ id: "k", type: "keys", tracks: [key("b", "lateral", 50), key("b", "vertical", 10)] }]);
  const free = ang(pr, "b").a;
  pr.limits = { b: { lateral: [-20, 20] } };
  const r = ang(pr, "b");
  close(r.a.lateral!, 20, 1e-3, "упёрлось в предел");
  close(r.a.vertical!, free.vertical!, 1e-6, "другая ось — как была до обрезки");
  assert.ok(r.limited.has("b"), "кость отмечена");
  // в пределах — поворот не меняется вовсе
  pr.limits = { b: { lateral: [-60, 60] } };
  assert.equal(ang(pr, "b").limited.size, 0);
  // корпус: наклон 40 при пределе pitch ±10
  const body = project([{ id: "k", type: "keys", tracks: [key("a", "pitch", 40)] }]);
  body.limits = { a: { pitch: [-10, 10] } };
  close(boneAngles(rig, body, "a", motionAt(body, rig, body.clips[0], 0).rot.get("a")!, undefined, true).pitch!, 10, 1e-3, "pitch");
});

test("ограничения меряются от выровненной позы покоя: опускание руки из T-позы — не движение, его не обрезает", () => {
  const rig = buildRig(skel);
  const tip = (pr: Project) => worldPose(rig, posePartsAt(pr, rig, pr.clips[0], 0)).T[rig.index.get("c")!];
  const pr = project([{ id: "k", type: "keys", tracks: [{ bone: "a", axis: "roll", keys: [{ t: 0, v: 1 }] }] }]);
  pr.align = { body: { to: "down" } };
  const free = tip(pr);
  pr.limits = { a: { lateral: [-5, 5], vertical: [-5, 5], roll: [-5, 5] } };
  const lim = tip(pr);
  for (let k = 0; k < 3; k++) close(lim[k], free[k], 1e-6, `кончик там же, ось ${k}`);
  assert.ok(free[1] < 0.5, `цепочка опущена вниз: ${free}`);
});

test("limit.fit охватывает размах клипа с запасом, limit.set сужает; limit.auto: колено гнётся только назад", () => {
  const ctx = { project: project([{ id: "w", type: "recipe", recipe: "wave", target: { chain: "body" }, params: { tipAmp: 30, growth: 0, period: 1 } }]), skeleton: skel };
  const r = runCommand(ctx, "limit.fit", { margin: 2 }) as any;
  const lat = ctx.project.limits!.c.lateral!;
  assert.ok(lat[0] <= -30 && lat[1] >= 30 && lat[1] <= 33, `размах ±30 с запасом 2: ${lat}`);
  assert.ok(r.bones >= 3);
  runCommand(ctx, "limit.set", { chain: "body", axis: "lateral", min: -5, max: 5 });
  const rig = buildRig(skel);
  let worst = 0;
  for (let k = 0; k < 10; k++) {
    const m = motionAt(ctx.project, rig, ctx.project.clips[0], k / 10);
    worst = Math.max(worst, Math.abs(boneAngles(rig, ctx.project, "c", m.rot.get("c")!).lateral!));
  }
  close(worst, 5, 1e-3, "волна не выходит за ±5");
  runCommand(ctx, "limit.clear", {});
  assert.equal(ctx.project.limits, undefined);

  // человек без имён: колено назад можно, вперёд — нет
  const hs = humanSkel(null), det = detectRig(hs, { up: [0, 1, 0] });
  const hp: Project = { version: 1, name: "h", model: "", up: [0, 1, 0], forward: [0, 0, 1], chains: det.chains as Record<string, string[]>, clips: [] };
  const hctx = { project: hp, skeleton: hs };
  runCommand(hctx, "limit.auto", {});
  const shin = det.chains.leg_l![1], hr = buildRig(hs);
  const foot = (v: number) => {
    hp.clips = [{ name: "c", duration: 1, fps: 10, loop: true, layers: [{ id: "k", type: "keys", tracks: [{ bone: shin, axis: "vertical", keys: [{ t: 0, v }] }] }] }];
    return worldPose(hr, posePartsAt(hp, hr, hp.clips[0], 0)).T[hr.index.get(det.feet.l!)!][2];
  };
  const rest = foot(0);
  const [lo, hi] = hp.limits![shin].vertical!;
  const bendWay = hi > 0 ? 60 : -60;
  assert.ok(foot(bendWay) < rest - 0.05, `разрешённый сгиб уводит стопу назад: ${foot(bendWay)} < ${rest}`);
  close(foot(-bendWay), rest, 1e-6, "сгиб вперёд обрезан в ноль");
  assert.ok(Math.abs(hi - lo) === 150);

  // локоть без кисти (рука-варежка): конец — продолжение плеча; разрешённый сгиб уводит предплечье вперёд
  const fa = det.chains.arm_l![1];
  const gone = new Set<string>([fa]);
  for (const n of hs.nodes) if (n.parent && gone.has(n.parent)) gone.add(n.name); // узлы идут от родителя к детям
  gone.delete(fa);
  const mitten: Skeleton = { nodes: hs.nodes.filter((n) => !gone.has(n.name)) };
  const mp: Project = { ...hp, limits: undefined, clips: [] };
  runCommand({ project: mp, skeleton: mitten }, "limit.auto", {});
  const fl = mp.limits![fa]!;
  assert.ok(fl, "локоть получил предел");
  const hax = (["lateral", "vertical"] as const).find((k) => fl[k] && Math.abs(fl[k]![1] - fl[k]![0]) === 145)!;
  assert.equal(hax, "lateral", "рука в T-позе гнётся вокруг вертикали");
  const el = fl[hax];
  const mr = buildRig(mitten), up = det.chains.arm_l![0];
  const handDir = (v: number) => {
    mp.clips = [{ name: "c", duration: 1, fps: 10, loop: true, layers: [{ id: "k", type: "keys", tracks: [{ bone: fa, axis: hax, keys: [{ t: 0, v }] }] }] }];
    const w = worldPose(mr, posePartsAt(mp, mr, mp.clips[0], 0));
    const i = mr.index.get(fa)!, p0 = mr.index.get(up)!;
    const along = vsub(mr.worldT[i], mr.worldT[p0]);
    return qrot(w.R[i], qrot(qinv(mr.worldR[i]), along))[2];
  };
  const allowed = el![1] > 0 ? 60 : -60;
  assert.ok(handDir(allowed) > 0.05, `разрешённый сгиб — вперёд: ${handDir(allowed)}`);
  assert.ok(Math.abs(handDir(-allowed)) < 1e-6, `сгиб назад обрезан: ${handDir(-allowed)}`);
});

// ── констрейны: взгляд и IK ──
import { targetAt } from "./evaluate.ts";
import { vnorm as vn, vdot as vd, vcross as vc } from "./math.ts";

const plain = () => humanSkel(Object.fromEntries(HUMAN.map((h) => [h[0], h[0]])));
const conProject = (constraints: any[], extra: Partial<Project> = {}): Project => ({
  version: 1, name: "c", model: "", up: [0, 1, 0], forward: [0, 0, 1],
  chains: { arm_l: ["uarm_l", "farm_l"], neck: ["neck"], head: ["head"] },
  clips: [{ name: "c", duration: 2, fps: 10, loop: false, layers: [], constraints }], ...extra,
});
const W = (pr: Project, t = 0) => {
  const sk = plain(), rig = buildRig(sk);
  const w = worldPose(rig, posePartsAt(pr, rig, pr.clips[0], t));
  return { at: (b: string) => w.T[rig.index.get(b)!], R: (b: string) => w.R[rig.index.get(b)!], rig, parts: posePartsAt(pr, rig, pr.clips[0], t) };
};
const dist = (a: Vec3, b: Vec3) => Math.hypot(...vsub(a, b));
const vadd3 = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];

test("IK: кисть встаёт в достижимую цель, к недостижимой рука вытягивается; вес — часть пути; pole задаёт сторону локтя", () => {
  const target: Vec3 = [0.4, 1.2, 0.25];
  const r = W(conProject([{ id: "ik", type: "ik", tip: "hand_l", target: { pos: target } }]));
  close(dist(r.at("hand_l"), target), 0, 1e-6, "кисть в цели");
  close(dist(r.at("uarm_l"), [0.18, 1.5, 0]), 0, 1e-9, "плечо на месте");
  close(dist(r.at("farm_l"), r.at("uarm_l")), 0.27, 1e-9, "длина плеча не меняется");
  // недостижимо: кисть на прямой плечо → цель, рука во всю длину
  const far: Vec3 = [2, 1.5, 1];
  const f = W(conProject([{ id: "ik", type: "ik", tip: "hand_l", target: { pos: far } }]));
  const dir = vn(vsub(far, f.at("uarm_l")));
  close(vd(vn(vsub(f.at("hand_l"), f.at("uarm_l"))), dir), 1, 1e-9, "рука смотрит на цель");
  close(dist(f.at("hand_l"), f.at("uarm_l")), 0.52, 1e-5, "вытянута");
  // вес 0.5: не там и не в цели
  const h = W(conProject([{ id: "ik", type: "ik", tip: "hand_l", target: { pos: target }, weight: 0.5 }]));
  const d0 = dist([0.7, 1.5, 0], target), dh = dist(h.at("hand_l"), target);
  assert.ok(dh > 0.02 && dh < d0 - 0.02, `полпути: ${dh} из ${d0}`);
  // pole: локоть уходит в сторону полюса (вверх или вниз)
  for (const py of [3, -3]) {
    const p = W(conProject([{ id: "ik", type: "ik", tip: "hand_l", target: { pos: [0.5, 1.5, 0.1] }, pole: [0.3, py, 0] }]));
    close(dist(p.at("hand_l"), [0.5, 1.5, 0.1]), 0, 1e-6, "кисть в цели и с полюсом");
    assert.ok(Math.sign(p.at("farm_l")[1] - 1.5) === Math.sign(py), `локоть к полюсу ${py}: ${p.at("farm_l")}`);
  }
  // выключенный — ничего не делает
  // рука без кисти (end): тянется конец предплечья — продолжение на длину плеча
  const e = W(conProject([{ id: "ik", type: "ik", tip: "farm_l", end: true, target: { pos: [0.5, 1.2, 0.3] } }]));
  const endPt = vadd3(e.at("farm_l"), qrot(qmul(e.R("farm_l"), qinv(e.rig.worldR[e.rig.index.get("farm_l")!])), [0.27, 0, 0]));
  close(dist(endPt, [0.5, 1.2, 0.3]), 0, 1e-6, "конец предплечья в цели");
  close(dist(e.at("uarm_l"), [0.18, 1.5, 0]), 0, 1e-9, "плечо не сдвинулось");
  const m = W(conProject([{ id: "ik", type: "ik", tip: "hand_l", target: { pos: target }, muted: true }, { id: "aim", type: "aim", bones: ["head"], target: { pos: [0, 2, 1] } }]));
  close(dist(m.at("hand_l"), [0.7, 1.5, 0]), 0, 1e-9);
});

test("взгляд: голова смотрит на цель, поворот делится между шеей и головой; ограничения обрезают; цель по ключам и кость-цель", () => {
  const look = (pr: Project, t = 0) => {
    const r = W(pr, t);
    const fwd = qrot(qmul(r.R("head"), qinv(r.rig.worldR[r.rig.index.get("head")!])), [0, 0, 1]);
    return { r, fwd };
  };
  const P: Vec3 = [1, 2, 1];
  const a = look(conProject([{ id: "aim", type: "aim", bones: ["neck", "head"], target: { pos: P } }]));
  close(vd(a.fwd, vn(vsub(P, a.r.at("head")))), 1, 1e-9, "голова на цель");
  const neckTurn = qrot(a.r.R("neck"), [0, 0, 1]);
  assert.ok(neckTurn[0] > 0.2, `шея тоже повернулась: ${neckTurn}`);
  // предел головы и шеи по yaw ±10: смотреть вбок на 90° нельзя
  const side: Vec3 = [5, 1.65, 0];
  const lim = conProject([{ id: "aim", type: "aim", bones: ["neck", "head"], target: { pos: side } }], { limits: { neck: { yaw: [-10, 10] }, head: { yaw: [-10, 10] } } });
  const l = look(lim);
  const yawDeg = Math.atan2(l.fwd[0], l.fwd[2]) / DEG;
  close(yawDeg, 20, 0.5, "шея 10 + голова 10");
  assert.ok(l.r.parts.limited?.has("head"));
  // цель по ключам: в t=1 — середина пути из слева-спереди в справа-спереди
  const k = conProject([{ id: "aim", type: "aim", bones: ["head"], target: { keys: [{ t: 0, pos: [-1, 1.65, 1], interp: "linear" }, { t: 2, pos: [1, 1.65, 1] }] } }]);
  const mid = look(k, 1);
  close(Math.atan2(mid.fwd[0], mid.fwd[2]), 0, 1e-6, "в середине — прямо");
  assert.ok(look(k, 0).fwd[0] < -0.5 && look(k, 2).fwd[0] > 0.5, "провожает цель");
  // кость-цель: смотрит на свою кисть, которую IK двигает раньше
  const hb = conProject([
    { id: "ik", type: "ik", tip: "hand_l", target: { pos: [0.3, 1.3, 0.35] } },
    { id: "aim", type: "aim", bones: ["head"], target: { bone: "hand_l" } },
  ]);
  const b = look(hb);
  close(vd(b.fwd, vn(vsub(b.r.at("hand_l"), b.r.at("head")))), 1, 1e-9, "смотрит на кисть после IK");
  close(dist(targetAt(b.r.rig, b.r.parts, hb.clips[0], { bone: "hand_l", offset: [0, 0.1, 0] }, 0)!, vsub(b.r.at("hand_l"), [0, -0.1, 0])), 0, 1e-9, "сдвиг цели");
  void vc;
});

test("команды констрейнов: ik.add по цепочке находит кисть, constraint.key делает цель движущейся, set и remove", () => {
  const ctx = { project: conProject([]), skeleton: plain() };
  const c = runCommand(ctx, "ik.add", { clip: "c", chain: "arm_l", target: "0.4,1.2,0.25" }) as any;
  assert.equal(c.tip, "hand_l");
  assert.equal(c.id, "ik_arm_l");
  runCommand(ctx, "constraint.key", { clip: "c", id: "ik_arm_l", t: 1, target: "0.5,1.0,0.3" });
  const tg = (ctx.project.clips[0].constraints![0] as any).target as import("./project.ts").ConstraintTarget;
  assert.deepEqual(tg.keys!.map((k) => k.t), [0, 1], "прежняя точка стала ключом в 0");
  assert.equal(tg.pos, undefined);
  runCommand(ctx, "constraint.set", { clip: "c", id: "ik_arm_l", weight: 0.3, muted: true });
  assert.equal(ctx.project.clips[0].constraints![0].weight, 0.3);
  assert.throws(() => runCommand(ctx, "ik.add", { clip: "c", tip: "spine", target: "0,0,0" }), /родителя и деда/);
  ctx.project.chains.arm_r = ["uarm_r", "farm_r"];
  const mit = { project: ctx.project, skeleton: { nodes: ctx.skeleton.nodes.filter((n) => !["hand_r", "finger_r"].includes(n.name)) } };
  const mc = runCommand(mit, "ik.add", { clip: "c", chain: "arm_r", target: "0,1,0" }) as any;
  assert.deepEqual([mc.tip, mc.end], ["farm_r", true], "варежка: тянется конец предплечья");
  runCommand(ctx, "constraint.remove", { clip: "c", id: "ik_arm_r" });
  const a = runCommand(ctx, "aim.add", { clip: "c", targetBone: "hand_r" }) as any;
  assert.deepEqual(a.bones, ["neck", "head"]);
  runCommand(ctx, "constraint.remove", { clip: "c", id: "ik_arm_l" });
  runCommand(ctx, "constraint.remove", { clip: "c", id: "aim" });
  assert.equal(ctx.project.clips[0].constraints, undefined);
});

test("копия поворота: кость повторяет движение источника, с множителем и зеркально; поверх своей анимации", () => {
  const key = (bone: string, axis: string, v: number) => ({ bone, axis, keys: [{ t: 0, v }] });
  const pr = (cons: any[], tracks: any[]) => conProject(cons, { clips: [{ name: "c", duration: 1, fps: 10, loop: false, layers: [{ id: "k", type: "keys", tracks }], constraints: cons }] } as any);
  const dirOf = (r: ReturnType<typeof W>, a: string, b: string) => vn(vsub(r.at(b), r.at(a)));
  // правое плечо поднято pitch 30: левое повторяет — то же мировое движение
  const src = W(pr([], [key("uarm_r", "yaw", 30)]));
  const same = W(pr([{ id: "c", type: "copy", bones: ["uarm_l"], source: ["uarm_r"] }], [key("uarm_r", "yaw", 30)]));
  const ref = W(pr([], [key("uarm_r", "yaw", 30), key("uarm_l", "yaw", 30)]));
  close(dist(same.at("hand_l"), ref.at("hand_l")), 0, 1e-9, "как свой ключ pitch 30");
  void src;
  // множитель −1 — в обратную сторону
  const inv = W(pr([{ id: "c", type: "copy", bones: ["uarm_l"], source: ["uarm_r"], weight: -1 }], [key("uarm_r", "yaw", 30)]));
  const refInv = W(pr([], [key("uarm_l", "yaw", -30)]));
  close(dist(inv.at("hand_l"), refInv.at("hand_l")), 0, 1e-9, "×−1");
  // зеркально: правая рука вбок-вверх (bank) — левая симметрично, а не в ту же сторону
  const mir = W(pr([{ id: "c", type: "copy", bones: ["uarm_l"], source: ["uarm_r"], mirror: true }], [key("uarm_r", "bank", 25)]));
  const r = dirOf(mir, "uarm_r", "hand_r"), l = dirOf(mir, "uarm_l", "hand_l");
  close(l[0], -r[0], 1e-9, "x зеркален");
  close(l[1], r[1], 1e-9, "y как у источника");
  close(l[2], r[2], 1e-9, "z как у источника");
  assert.ok(Math.abs(r[1]) > 0.1, "источник действительно повернулся");
  // поверх своей анимации: свой ключ yaw 20 + копия pitch 30
  const both = W(pr([{ id: "c", type: "copy", bones: ["uarm_l"], source: ["uarm_r"] }], [key("uarm_r", "yaw", 30), key("uarm_l", "bank", 20)]));
  const refBoth = W(pr([], [key("uarm_l", "bank", 20), key("uarm_l", "yaw", 30)]));
  close(dist(both.at("hand_l"), refBoth.at("hand_l")), 0, 1e-9, "своя анимация сохраняется");
  // выравнивание позы покоя не копируется: обе руки опущены из T-позы, копия без движения ничего не меняет
  const al = (cons: any[]) => W({ ...pr(cons, []), align: { arm_l: { to: "down" }, arm_r: { to: "down" } }, chains: { arm_l: ["uarm_l", "farm_l"], arm_r: ["uarm_r", "farm_r"], neck: ["neck"], head: ["head"] } } as Project);
  close(dist(al([{ id: "c", type: "copy", bones: ["uarm_l"], source: ["uarm_r"], mirror: true }]).at("hand_l"), al([]).at("hand_l")), 0, 1e-9, "опущенная рука на месте");
  // команда: цепочки попарно, себя повторять нельзя
  const ctx = { project: conProject([]), skeleton: plain() };
  ctx.project.chains.arm_r = ["uarm_r", "farm_r"];
  const c = runCommand(ctx, "copy.add", { clip: "c", chain: "arm_l", sourceChain: "arm_r", mirror: true }) as any;
  assert.deepEqual([c.bones, c.source, c.mirror], [["uarm_l", "farm_l"], ["uarm_r", "farm_r"], true]);
  assert.throws(() => runCommand(ctx, "copy.add", { clip: "c", bone: "head", source: "head" }), /сама себя/);
  assert.throws(() => runCommand(ctx, "constraint.key", { clip: "c", id: "copy_arm_l", t: 1, target: "0,0,0" }), /нет цели/);
});

test("IK длиннее двух костей: за далёкой целью тянется корпус; пределы учитываются при подборе позы, а не обрезают её", () => {
  const far: Vec3 = [0.85, 1.2, 0.3];
  const err = (cons: any, extra: Partial<Project> = {}) => {
    const pr = conProject([{ id: "ik", type: "ik", tip: "hand_l", target: { pos: far }, ...cons }], extra);
    const r = W(pr);
    return { e: dist(r.at("hand_l"), far), r, pr };
  };
  assert.ok(err({}).e > 0.1, "рука сама не дотягивается");
  const long = err({ length: 6 });
  close(long.e, 0, 1e-3, "с ключицей и позвоночником — дотянулась");
  assert.ok(dist(long.r.at("spine"), [0, 1.15, 0]) < 1e-9 && dist(long.r.at("chest"), [0, 1.42, 0]) > 1e-3, "грудь наклонилась, основание цепочки на месте");
  // прямой локоть (±5°): дотягивается за счёт корпуса, локоть в пределе
  const lim = { farm_l: { lateral: [-5, 5], vertical: [-5, 5] } } as Project["limits"];
  const straight = err({ length: 6 }, { limits: lim });
  close(straight.e, 0, 2e-3, "дотянулась с прямым локтем");
  const rig = straight.r.rig;
  const m = motionAt(straight.pr, rig, straight.pr.clips[0], 0);
  const a = boneAngles(rig, straight.pr, "farm_l", m.rot.get("farm_l")!, m.base.get("farm_l"));
  assert.ok(Math.abs(a.lateral!) <= 5 + 1e-6 && Math.abs(a.vertical!) <= 5 + 1e-6, `локоть в пределе: ${a.lateral}, ${a.vertical}`);
  // близкая цель (нужен сильный сгиб локтя) при длине 2 и пределах — CCD, а не обрезка формулы
  const near: Vec3 = [0.45, 1.5, 0.2];
  const lim2 = { farm_l: { lateral: [-150, 0], vertical: [-8, 8] } } as Project["limits"];
  const n2 = W(conProject([{ id: "ik", type: "ik", tip: "hand_l", target: { pos: near } }], { limits: lim2 }));
  const n2b = W(conProject([{ id: "ik", type: "ik", tip: "hand_l", target: { pos: near } }], { limits: { farm_l: { lateral: [0, 150], vertical: [-8, 8] } } }));
  // локоть гнётся только в одну сторону — какую ни разреши, рука находит позу с плечом и дотягивается
  close(dist(n2.at("hand_l"), near), 0, 2e-3, "локоть только вперёд");
  close(dist(n2b.at("hand_l"), near), 0, 2e-3, "локоть только назад");
});

test("позинг: pose.reach тянет кисть в точку и пишет ключ позы; за таз — тело целиком, закреплённая ступня стоит; ключи позы интерполируются", () => {
  const ctx = { project: conProject([]), skeleton: plain() };
  const P: Vec3 = [0.5, 1.3, 0.3];
  const r = runCommand(ctx, "pose.reach", { clip: "c", t: 0, bone: "hand_l", target: P.join(",") }) as any;
  assert.deepEqual(r.bones.sort(), ["farm_l", "uarm_l"]);
  close(dist(W(ctx.project).at("hand_l"), P), 0, 1e-4, "кисть там, куда тянули");
  // второй ключ в t=2 — рука снова в покое; в t=1 — посередине
  runCommand(ctx, "pose.reach", { clip: "c", t: 2, bone: "hand_l", target: "0.7,1.5,0" });
  close(dist(W(ctx.project, 2).at("hand_l"), [0.7, 1.5, 0]), 0, 1e-4, "второй ключ");
  const mid = W(ctx.project, 1).at("hand_l");
  assert.ok(dist(mid, P) > 0.05 && dist(mid, [0.7, 1.5, 0]) > 0.05, `посередине: ${mid}`);
  // новый ключ между старыми не дёргает позу: t=1 без перемещения цели — кисть там же
  runCommand(ctx, "pose.reach", { clip: "c", t: 1, bone: "hand_l", target: mid.join(",") });
  close(dist(W(ctx.project, 1).at("hand_l"), mid), 0, 1e-4, "ключ посередине с той же позой");
  // присесть: ступня закреплена IK, таз тянут вниз на 0.2
  ctx.project.chains.leg_l = ["thigh_l", "shin_l"];
  runCommand(ctx, "ik.add", { clip: "c", chain: "leg_l", target: "0.1,0.08,0", pole: "0.1,0.5,1" });
  runCommand(ctx, "pose.reach", { clip: "c", t: 0, bone: "hips", target: "0,0.8,0", length: 0 });
  const sq = W(ctx.project, 0);
  close(sq.at("hips")[1], 0.8, 1e-9, "таз опустился");
  close(dist(sq.at("foot_l"), [0.1, 0.08, 0]), 0, 1e-6, "ступня на месте");
  assert.ok(sq.at("shin_l")[2] > 0.05, "колено ушло вперёд");
  // конец кости (end): тянут конец предплечья-варежки — сгибается и оно само
  runCommand(ctx, "pose.reach", { clip: "c", t: 0, bone: "farm_l", target: "0.5,1.25,0.3", end: true });
  const e = W(ctx.project, 0);
  const endPt = vadd3(e.at("farm_l"), qrot(qmul(e.R("farm_l"), qinv(e.rig.worldR[e.rig.index.get("farm_l")!])), [0.27, 0, 0]));
  close(dist(endPt, [0.5, 1.25, 0.3]), 0, 1e-4, "конец предплечья там, куда тянули");
  runCommand(ctx, "pose.clear", { clip: "c" });
  assert.equal(ctx.project.clips[0].layers.length, 0);
});

test("главные ручки рецептов (простой режим) — настоящие числовые параметры, 3–5 штук", () => {
  for (const [name, def] of Object.entries(RECIPES)) {
    assert.ok(def.main && def.main.length >= 3 && def.main.length <= 5, `${name}: ${def.main}`);
    for (const k of def.main!) assert.equal(def.params[k]?.type, "number", `${name}.${k}`);
  }
});

test("clip.set fit: длина удара — до закрытия окна ввода (tail), не короче 0,3 с после открытия", () => {
  const p = { ...emptyProject("t", "m.glb"), chains: { arm: ["uarm_r", "farm_r"] } };
  const ctx = { project: p, skeleton: plain() };
  runCommand(ctx, "clip.add", { name: "hit", duration: 1, loop: false });
  runCommand(ctx, "recipe.add", { clip: "hit", recipe: "melee-strike", chain: "arm", params: { tail: 0.4 } });
  // события рецепта целиком (clipEvents обрезает их по длине клипа)
  const evOf = (tail: number) => RECIPES["melee-strike"].events!(withDefaults(RECIPES["melee-strike"], { tail }));
  const close = evOf(0.4).find((e) => e.name === "window_close")!.t;
  assert.equal((runCommand(ctx, "clip.set", { clip: "hit", fit: true }) as { duration: number }).duration, +close.toFixed(3));
  runCommand(ctx, "recipe.set", { clip: "hit", layer: "melee-strike", params: { tail: 0 } });
  const open = evOf(0).find((e) => e.name === "window_open")!.t;
  assert.equal((runCommand(ctx, "clip.set", { clip: "hit", fit: true }) as { duration: number }).duration, +(open + 0.3).toFixed(3));
});

test("tremble: петля без шва, частота Ghost Master, голова сильнее груди", () => {
  const def = RECIPES.tremble;
  const lib = JSON.parse(readFileSync(new URL("../../../library/presets/tremble.json", import.meta.url), "utf8"));
  const adult = lib.presets.find((p: any) => p.name === "gm-adult-tremble").params;
  const p = withDefaults(def, adult);
  const at = (role: string, t: number, n = 1) => Object.values(def.evaluate({ ...p, role }, 0, n, t))[0] as number;
  // шов: значение и скорость в начале и в конце периода совпадают
  const h = 1e-4;
  close(at("chest", p.period), at("chest", 0), 1e-9, "шов");
  close(at("chest", p.period - h), at("chest", -h), 1e-9, "скорость на шве");
  // частота: 0.93 с · 7.6 Гц → 7 колебаний, 14 пересечений нуля
  let zc = 0;
  const t0 = p.period / 7 / 4; // четверть колебания: края не на нуле
  for (let k = 1, prev = at("chest", t0); k <= 4000; k++) { const v = at("chest", t0 + (k / 4000) * p.period); if (Math.sign(v) !== Math.sign(prev)) zc++; prev = v; }
  assert.equal(zc, 14);
  const peak = (role: string) => { let m = 0; for (let k = 0; k < 4000; k++) m = Math.max(m, Math.abs(at(role, (k / 4000) * p.period))); return m; };
  close(peak("head") / peak("chest"), 1.5, 0.02, "голова ×1.5");
  close(peak("chest"), 3.2 * 1.15, 0.05, "грудь ±3.2 с неровностью");
  // цепочка из трёх костей делит амплитуду поровну
  close(at("chest", 0.05, 3) * 3, at("chest", 0.05), 1e-12, "доля кости");
  assert.equal(Object.keys(def.evaluate({ ...p, role: "tail" }, 0, 1, 0.1))[0], "yaw");
});

test("hit-react: пики Haven на своих местах, без перелёта, смерть остаётся лежать", () => {
  const def = RECIPES["hit-react"];
  const lib = JSON.parse(readFileSync(new URL("../../../library/presets/hit-react.json", import.meta.url), "utf8"));
  const pre = (name: string) => withDefaults(def, lib.presets.find((p: any) => p.name === name).params);
  const pelvisPitch = (p: Record<string, any>, t: number) => def.evaluate({ ...p, role: "pelvis" }, 0, 1, t, { height: 1 }).pitch as number;
  const light = pre("haven-hit-light"), dt = 1e-3;
  let vMax = 0, tV = 0, xMax = 0, tX = 0, xMin = 0;
  for (let t = 0; t <= light.duration; t += dt) {
    const x = -pelvisPitch(light, t), v = (-pelvisPitch(light, t + dt) - x) / dt;
    if (v > vMax) { vMax = v; tV = t; }
    if (x > xMax) { xMax = x; tX = t; }
    xMin = Math.min(xMin, x);
  }
  close(tV, 0.05, 2 * dt, "пик скорости");
  close(tX, 0.27, 2 * dt, "пик отклонения");
  close(xMax, 25, 1e-6, "наклон назад");
  assert.ok(xMin >= 0, "без замаха и без перелёта вперёд");
  close(pelvisPitch(light, 0.78), 0, 1e-12, "успокоилось к 0.78");
  assert.equal(def.evaluate({ ...light, role: "pelvis" }, 0, 1, 0.27, { height: 1 }).move_forward! < 0, true, "отлёт назад");
  // смерть: в конце — полное отклонение, оседание вниз, событие thud
  const death = pre("haven-death");
  close(pelvisPitch(death, death.duration), -60, 1e-9, "лежит");
  assert.ok((def.evaluate({ ...death, role: "pelvis" }, 0, 1, death.duration, { height: 1 }).move_up as number) < -0.099, "осело");
  assert.deepEqual(def.events!(death).map((e) => e.name), ["impact", "thud"]);
  // присед крупных: сперва против хода
  assert.ok(pelvisPitch(pre("haven-hit-crouch"), 0.12) > 0, "замах вперёд перед отлётом назад");
  // уклон вбок: крен и сдвиг вбок, тангажа нет; голова отстаёт от таза
  const dodge = def.evaluate({ ...pre("haven-dodge"), role: "pelvis" }, 0, 1, 0.33, { height: 1 });
  assert.ok(dodge.move_side! < 0 && dodge.pitch === undefined);
  const head = (t: number) => def.evaluate({ ...light, role: "head" }, 0, 1, t).pitch as number;
  close(head(0.27 + light.headLag), -light.headPitch, 1e-9, "голова пиком позже на headLag");
});

test("idle-glance: взгляды Haven — паузы, углы, пределы, двойной взгляд, петля без шва", () => {
  const def = RECIPES["idle-glance"];
  const lib = JSON.parse(readFileSync(new URL("../../../library/presets/idle-glance.json", import.meta.url), "utf8"));
  const pre = (name: string, seed: number) => withDefaults(def, { ...lib.presets.find((p: any) => p.name === name).params, seed });
  let doubles = 0, total = 0;
  for (let seed = 0; seed < 200; seed++) {
    const p = pre("haven-duo-glance", seed), { starts, segs } = glancePlan(p);
    assert.ok(starts.length >= 2, `seed ${seed}: в 40 с хотя бы два взгляда`);
    assert.ok(segs[segs.length - 1].b <= p.period, "последний взгляд вернулся до конца петли");
    assert.deepEqual(def.evaluate(p, 0, 1, 0), {}, "на шве — покой");
    // пауза от конца прошлого взгляда — 8…15 с (первый — половина)
    let prevEnd = 0;
    for (const [k, s0] of starts.entries()) {
      const gap = (s0 - prevEnd) / (k === 0 ? 0.5 : 1);
      assert.ok(gap >= 8 - 1e-9 && gap <= 15 + 1e-9, `пауза ${gap}`);
      const mine = segs.filter((g) => g.a >= s0 && (k + 1 >= starts.length || g.a < starts[k + 1]));
      prevEnd = mine[mine.length - 1].b;
      total++;
      if (mine.length === 5) doubles++;
      const hold = mine[1].from;
      assert.ok(Math.abs(hold[0]) >= 30 && Math.abs(hold[0]) <= 70, `вбок ${hold[0]}`);
      assert.ok(hold[1] >= 0 && hold[1] <= 20, `вниз ${hold[1]} ≤ предела 20`);
      close(mine[0].b - mine[0].a, 0.7, 1e-12, "переход 0.7");
    }
  }
  assert.ok(Math.abs(doubles / total - 0.6) < 0.08, `двойных ${doubles}/${total}`);
  // в одиночку: всегда двойной и в другую сторону
  for (let seed = 0; seed < 50; seed++) for (const [k] of glancePlan(pre("haven-solo-look", seed)).starts.entries()) {
    const segs = glancePlan(pre("haven-solo-look", seed)).segs.slice(k * 5, k * 5 + 5);
    assert.equal(segs.length, 5);
    assert.ok(Math.sign(segs[1].from[0]) === -Math.sign(segs[3].from[0]), "в одну сторону, затем в другую");
  }
  // переход: наклон 1 в начале и 0 в конце (lookAtTransitionCurve), значения — по кривой между точками
  const p = pre("haven-duo-glance", 3), g = glancePlan(p).segs[0], yaw = (t: number) => def.evaluate(p, 0, 1, t).yaw ?? 0, h = 1e-5;
  close((yaw(g.a + h) - yaw(g.a)) / h * (g.b - g.a) / g.to[0], 1, 1e-3, "наклон в начале");
  close((yaw(g.b - h) - yaw(g.b - 2 * h)) / h * (g.b - g.a) / g.to[0], 0, 1e-3, "наклон в конце");
  close(yaw(g.b + 0.01), g.to[0], 1e-12, "держит");
  close(yaw(g.b + 0.01 + p.period), g.to[0], 1e-12, "петля: второй круг — тот же взгляд");
});

test("waddle-walk headNod: голова кивает в мире раз за шаг с амплитудой Haven, поклон груди вычтен", () => {
  const def = RECIPES["waddle-walk"];
  const lib = JSON.parse(readFileSync(new URL("../../../library/presets/waddle-walk.json", import.meta.url), "utf8"));
  const p = withDefaults(def, { ...lib.presets.find((x: any) => x.name === "haven-chirulida-walk").params, chestBow: 8 });
  const world = (t: number) => ((def.evaluate({ ...p, role: "head" }, 0, 1, t).pitch ?? 0) as number) + ((def.evaluate({ ...p, role: "chest" }, 0, 1, t).pitch ?? 0) as number);
  let max = 0, zc = 0, prev = world(p.period / 8);
  for (let k = 1; k <= 1000; k++) { const v = world(p.period / 8 + (k / 1000) * p.period); max = Math.max(max, Math.abs(v)); if (Math.sign(v) !== Math.sign(prev)) zc++; prev = v; }
  close(max, 9.7, 1e-3, "±9.7° в мире");
  assert.equal(zc, 4, "два кивка за цикл — раз за шаг");
  assert.equal(def.evaluate({ ...withDefaults(def, {}), role: "head" }, 0, 1, 0.1).pitch, undefined, "без headNod голова не кивает");
});

test("startle: времена Ghost Master — пик вздрога 0.27 с и возврат, присед прыжка до 0.39 с, обморок лежит", () => {
  const def = RECIPES.startle;
  const at = (kind: string, role: string, t: number, extra: Record<string, unknown> = {}, i = 0) => def.evaluate(withDefaults(def, { kind, role, ...extra }), i, 2, t, { height: 1 });
  const series = (kind: string, ch: string, role = "pelvis", extra = {}) => { const p = withDefaults(def, { kind, ...extra }), L = def.length!(p), out: [number, number][] = []; for (let t = 0; t <= L + 1e-9; t += 0.005) out.push([t, (at(kind, role, t, extra) as any)[ch] ?? 0]); return out; };
  const argmin = (s: [number, number][]) => s.reduce((a, b) => (b[1] < a[1] ? b : a));
  const argmax = (s: [number, number][]) => s.reduce((a, b) => (b[1] > a[1] ? b : a));
  // вздрог: таз ниже всего с 0.27 с (дальше держит), к концу — в покое
  const fl = series("flinch", "move_up");
  close(argmin(fl)[0], 0.27, 0.006, "пик вздрога");
  close(fl[fl.length - 1][1], 0, 1e-9, "полный возврат");
  // темп 0.63 — пик позже: 0.27 / 0.63 ≈ 0.43 (re2)
  close(argmin(series("flinch", "move_up", "pelvis", { speed: 0.63 }))[0], 0.43, 0.006, "re2");
  // прыжок: присед к 0.39, подскок к 0.63; голова в приседе против хода — 0.7 главного
  const jp = series("jump", "move_up");
  close(argmin(jp.filter(([t]) => t < 0.6))[0], 0.39, 0.006, "присед");
  close(argmax(jp)[0], 0.63, 0.006, "пик вытяжки");
  const head = series("jump", "pitch", "head");
  close(-argmax(head)[1] / argmin(head)[1], 0.7, 0.01, "замах головы 0.7");
  // руки над головой в пике
  assert.ok((at("jump", "arm_l", 0.63, {}, 0).pitch as number) < -150);
  // сжаться: остаётся — конец/пик 0.95
  const cw = series("cower", "move_up");
  close(cw[cw.length - 1][1] / argmin(cw)[1], 0.95, 0.01, "остался сжавшимся");
  // обморок: лежит, таз на высоте lie; удар об пол — событие thud
  const p = withDefaults(def, { kind: "faint", lie: 0.3 });
  close(at("faint", "pelvis", def.length!(p), { lie: 0.3 }).move_up as number, -0.7, 1e-9, "таз лёжа");
  assert.ok((at("faint", "pelvis", def.length!(p)).pitch as number) < -70, "плашмя назад");
  assert.deepEqual(def.events!(p), [{ t: 1.08, name: "thud" }]);
  // кисть и третьи кости не трогаем
  assert.deepEqual(at("jump", "arm_l", 0.63, {}, 2), {});
  assert.deepEqual(at("jump", "pelvis", 0.63, {}, 1), {}, "у таза — только первая кость");
});

test("huddle: петли Ghost Master — covhead 1.67 с из двух покачиваний по 0.82, колени 2.03 с; таз сидя на sit высоты", () => {
  const def = RECIPES.huddle;
  const at = (pr: Record<string, unknown>, role: string, t: number, i = 0) => def.evaluate(withDefaults(def, { ...pr, role }), i, 2, t, { height: 1 });
  close(def.length!(withDefaults(def, { kind: "covhead", period: 0.835 })), 1.67, 1e-9, "covhead");
  close(def.length!(withDefaults(def, { kind: "hugknees", period: 1.015 })), 2.03, 1e-9, "chfri");
  // покачивание: пик таза вперёд на четверти периода, грудь — вдвое меньше, петля замкнута
  const pr = { kind: "covhead", period: 0.82, rock: 8 };
  const base = { pelvis: HUDDLE.covhead.pelvis.pitch, chest: HUDDLE.covhead.chest.pitch };
  close((at(pr, "pelvis", 0.205).pitch as number) - base.pelvis, 8, 1e-9, "таз +rock на T/4");
  close((at(pr, "pelvis", 0.615).pitch as number) - base.pelvis, -8, 1e-9, "таз −rock на 3T/4");
  close((at(pr, "chest", 0.205).pitch as number) - base.chest, 4, 1e-9, "грудь — половина");
  close(at(pr, "pelvis", 1.64).pitch as number, at(pr, "pelvis", 0).pitch as number, 1e-9, "петля");
  close(at({ ...pr, sit: 0.25 }, "pelvis", 0).move_up as number, -0.75, 1e-9, "таз сидя");
  assert.equal(at(pr, "chest", 0).move_up, undefined, "опускается только таз");
  // голова не качается сама — её несёт грудь; колени у груди у hugknees, руки над головой у covhead
  assert.equal(at(pr, "head", 0.205).pitch, at(pr, "head", 0).pitch);
  assert.ok((at({ kind: "hugknees" }, "leg_l", 0).pitch as number) < -100, "бедро к груди");
  assert.ok((at(pr, "arm_r", 0).pitch as number) < -140, "руки к голове");
  assert.ok((at(pr, "leg_r", 0, 1).pitch as number) > 100, "колено согнуто");
  assert.deepEqual(at(pr, "arm_l", 0, 2), {});
  assert.deepEqual(at(pr, "chest", 0, 1), {});
});

test("scare-pose: выход в позу к rise без возврата, грудь перелетает в overshoot раз, замах — у корпуса, не у рук", () => {
  const def = RECIPES["scare-pose"];
  const p = withDefaults(def, { rise: 0.97, anticipation: 0.9, preT: 0.3, keep: 0.73, overshoot: 2.7, duration: 2.4 });
  const at = (role: string, t: number, i = 0) => def.evaluate({ ...p, role }, i, 2, t, { height: 1 });
  const L = def.length!(p), peakT = 0.3 + 0.97;
  close(L, 2.4, 1e-9);
  close(at("pelvis", peakT).pitch as number, p.lean, 1e-9, "пик позы в rise после замаха");
  close((at("pelvis", L).pitch as number) / p.lean, 0.73, 1e-9, "в конце 0.73 пика — без возврата");
  close(at("pelvis", 0.3).pitch as number, -0.9 * p.lean, 1e-9, "замах против хода 0.9");
  close((at("chest", peakT).pitch as number) / (at("chest", L).pitch as number), 2.7, 1e-9, "грудь в пике ×2.7 конечной");
  close(at("arm_l", 0.3).pitch as number, 0, 1e-12, "руки без замаха");
  close(at("arm_l", peakT, 1).pitch as number, p.elbow, 1e-9, "локоть в пике");
  assert.deepEqual(def.events!(p), [{ t: 1.27, name: "manifest" }]);
});

test("zero-g-float: педалирование Breathedge — колено сгибается с бедром назад, вторая нога 0.45 и сдвинута, отмашка резкая", () => {
  const def = RECIPES["zero-g-float"];
  const p = withDefaults(def, {});
  const at = (role: string, i: number, t: number) => (def.evaluate({ ...p, role }, i, 3, t, { height: 1 }).pitch ?? 0) as number;
  const N = 400, ts = Array.from({ length: N }, (_, k) => (k / N) * p.period);
  const range = (f: (t: number) => number) => { const v = ts.map(f); return Math.max(...v) - Math.min(...v); };
  close(range((t) => at("leg_l", 0, t)), 14.7 + 11.8, 0.3, "бедро Л пик-пик по curve20");
  close(range((t) => at("leg_r", 0, t)) / range((t) => at("leg_l", 0, t)), 0.45, 1e-3, "вторая нога 0.45");
  // колено сгибается, когда бедро уходит назад: в момент самого заднего бедра колено согнуто сильнее среднего
  const back = ts.reduce((a, t) => (at("leg_l", 0, t) > at("leg_l", 0, a) ? t : a), 0);
  assert.ok(at("leg_l", 1, back) > p.knee + 20, `колено ${at("leg_l", 1, back)}`);
  // сдвиг второй ноги — 167°: её самое заднее бедро позже на 0.464 цикла
  const backR = ts.reduce((a, t) => (at("leg_r", 0, t) > at("leg_r", 0, a) ? t : a), 0);
  close(((backR - back) / p.period + 1) % 1, 167 / 360, 0.01, "сдвиг 167°");
  // шов петли
  close(at("leg_l", 1, p.period), at("leg_l", 1, 0), 1e-9, "шов");
  // отмашка левой руки: за 0.15 цикла проходит больше 70 % хода, гребок правой — меньше половины
  const swing = (role: string) => { const f = (t: number) => at(role, 1, t); const r = range(f); let best = 0; for (const t of ts) best = Math.max(best, Math.abs(f(t + 0.15 * p.period) - f(t))); return best / r; };
  assert.ok(swing("arm_l") > 0.7 && swing("arm_r") < 0.6, `отмашка ${swing("arm_l")}, гребок ${swing("arm_r")}`);
  assert.deepEqual(def.events!(p), [{ t: 1.8135, name: "breath" }]);
});

test("power-down: провал за 0.27 с (10→90 % около 0.17), висит с покачиванием, full включается обратно", () => {
  const def = RECIPES["power-down"];
  const body = (mode: string, t: number) => def.evaluate(withDefaults(def, { mode, role: "body" }), 0, 1, t, { height: 1, size: 1.5 });
  const lvl = (t: number) => -(body("in", t).move_up as number) / (0.2 * 1.5);
  let t10 = 0, t90 = 0;
  for (let t = 0; t <= 0.27; t += 0.001) { if (!t10 && lvl(t) >= 0.1) t10 = t; if (!t90 && lvl(t) >= 0.9) t90 = t; }
  close(t90 - t10, 0.17, 0.02, "подъём 10→90 %");
  close(body("in", 0.27).pitch as number, 31.5, 1e-9, "наклон");
  close(body("in", 0.27).move_up as number, -0.3, 0.01, "провал 30 см на 1.5 м");
  const hang = withDefaults(def, { mode: "hang" });
  close(body("hang", def.length!(hang)).move_up as number, body("hang", 0).move_up as number, 1e-9, "петля без шва");
  const full = withDefaults(def, { mode: "full" });
  close(body("full", def.length!(full)).move_up as number, 0, 1e-12, "включился");
  close(def.length!(full), 0.27 + 2 + 0.33, 1e-9);
  assert.deepEqual(def.events!(full).map((e) => [e.t, e.name]), [[0, "power_off"], [2.27, "power_on"]]);
  const limb = (i: number) => def.evaluate(withDefaults(def, { mode: "hang", role: "limb" }), i, 2, 0.5).pitch;
  assert.deepEqual([limb(0), limb(1), def.evaluate(withDefaults(def, { mode: "hang", role: "limb" }), 2, 2, 0.5).pitch], [60, 30, undefined]);
});

test("head-look-peck: шея S-образно в противофазе, крылья дёргаются дважды за цикл ровно на ±wing", () => {
  const def = RECIPES["head-look-peck"];
  const p = withDefaults(def, {});
  const v = (role: string, i: number, t: number, ch = "yaw") => (def.evaluate({ ...p, role }, i, 2, t) as any)[ch] as number;
  close(v("neck", 0, 0.25), 17.8, 1e-9, "первое звено");
  close(v("neck", 1, 0.25), -22.2, 1e-9, "второе — в противофазе");
  close(v("head", 0, 0.25), 10.8, 1e-9);
  close(v("tail", 0, 0.25) * 2, -18.7, 1e-9, "хвост против головы, поровну на кости");
  let max = 0, peaks = 0, prev = 0, prev2 = 0;
  for (let k = 0; k <= 2000; k++) {
    const x = v("wing", 0, k / 2000, "pitch");
    max = Math.max(max, Math.abs(x));
    if (k > 1 && prev > prev2 && prev > x) peaks++;
    prev2 = prev; prev = x;
  }
  close(max, 5.8, 1e-3, "±5.8°");
  assert.equal(peaks, 2, "два подёргивания за цикл");
  close(v("neck", 0, 1), v("neck", 0, 0), 1e-9, "шов");
});

test("curl секциями: внутри секции синхронно, секции сдвинуты по фазе и со своим размахом; одна секция — как раньше", () => {
  const def = RECIPES.curl;
  const p = withDefaults(def, { angle: 150, growth: 0, pulse: 1, period: 1.8, sections: 3, sectionPhase: 120, midAmp: 0.6, tipAmp: 0.8 });
  const v = (i: number, t: number, q = p) => def.evaluate(q, i, 15, t).vertical ?? def.evaluate(q, i, 15, t).lateral!;
  const peakT = (i: number) => { let b = 0; for (let k = 0; k < 1800; k++) if (v(i, k / 1000) > v(i, b / 1000)) b = k; return b / 1000; };
  // секции по 15 звеньям: 0–2, 3–9, 10–14
  assert.deepEqual([0, 2, 3, 9, 10, 14].map((i) => +peakT(i).toFixed(3)), [0.45, 0.45, 0.45 + 0.6, 0.45 + 0.6, 0.45 + 1.2, 0.45 + 1.2].map((x) => +(x % 1.8).toFixed(3)), "пики: синхронно в секции, сдвиг 120° = 0.6 с");
  const range = (i: number) => { let lo = 1e9, hi = -1e9; for (let k = 0; k < 180; k++) { const x = v(i, k / 100); lo = Math.min(lo, x); hi = Math.max(hi, x); } return hi - lo; };
  close(range(5) / range(0), 0.6, 1e-3, "середина 0.6");
  close(range(12) / range(0), 0.8, 1e-3, "кончик 0.8");
  // без секций — прежняя формула
  const old = withDefaults(def, { angle: 40, pulse: 0.5, growth: 1 });
  close(v(7, 0.3, old), 40 * (8 / 15) / (16 * 15 / 2 / 15) * (1 + 0.5 * Math.sin(2 * Math.PI * (0.3 / old.period))), 1e-9, "одна секция");
});

test("thrust-trail: таз ложится на тягу по замерам Breathedge, диагонали поворачивают, ноги отстают", () => {
  const def = RECIPES["thrust-trail"];
  const at = (angle: number, role = "pelvis", amount = 1) => def.evaluate(withDefaults(def, { angle, role, amount }), 0, 1, 0);
  close(at(0).pitch!, 26.6, 1e-9, "F");
  close(at(180).pitch!, -38, 1e-9, "B");
  close(at(90).bank!, 22.5, 1e-9, "R");
  close(at(-90).bank!, -22.5, 1e-9, "L");
  close(Math.abs(at(0).yaw!), 0, 1e-9, "по оси без рыскания");
  close(Math.abs(at(45).yaw!), 44, 1e-9, "диагональ 44°");
  assert.ok(at(45).yaw! * at(-45).yaw! < 0, "FL и FR в разные стороны");
  close(at(45, "pelvis", 0.5).pitch!, 26.6 * 0.5 * Math.SQRT1_2, 1e-9, "сила тяги");
  assert.ok(at(0, "leg").pitch! > 0 && at(180, "leg").pitch! < 0, "бёдра против тяги");
  assert.deepEqual(def.evaluate(withDefaults(def, {}), 1, 2, 0), {});
});

test("inspect-item: размахи Breathedge (кисть 163°, предплечье 57°, плечо 20°), проворот — на кисти или последней кости", () => {
  const def = RECIPES["inspect-item"];
  const p = withDefaults(def, {});
  const range = (i: number, n: number, ch: string) => { let lo = 1e9, hi = -1e9; for (let k = 0; k < 400; k++) { const x = (def.evaluate(p, i, n, (k / 400) * p.period) as any)[ch]; lo = Math.min(lo, x); hi = Math.max(hi, x); } return hi - lo; };
  close(range(2, 3, "roll"), 163, 0.01, "кисть");
  close(range(1, 3, "pitch"), 57, 0.01, "предплечье");
  close(range(0, 3, "pitch"), 20, 0.01, "плечо");
  close(range(1, 2, "roll"), 163, 0.01, "без кисти — на предплечье");
  assert.equal((def.evaluate(p, 1, 3, 0.3) as any).roll, undefined);
  close(def.evaluate(p, 2, 3, p.period).roll!, def.evaluate(p, 2, 3, 0).roll!, 1e-9, "шов");
});

test("fp-aim-arms: плечо 0.66 тангажа вверх и 0.53 вниз, предплечье и кисть сильнее вниз, с инструментом — только плечо", () => {
  const def = RECIPES["fp-aim-arms"];
  const at = (pitch: number, i: number, tool = "empty") => def.evaluate(withDefaults(def, { pitch, tool }), i, 3, 0).pitch ?? 0;
  close(at(90, 0), -59.4, 1e-9, "плечо вверх ≈ 59–61°");
  close(at(-90, 0), 47.7, 1e-9, "плечо вниз ≈ 48°");
  assert.ok(Math.abs(at(-90, 1)) > Math.abs(at(90, 1)) && Math.abs(at(-90, 2)) > Math.abs(at(90, 2)), "вниз сильнее");
  assert.deepEqual([at(90, 1, "tool"), at(90, 2, "tool")], [0, 0]);
  close(at(45, 0), at(90, 0) / 2, 1e-9, "линейно по тангажу");
});

test("tool-use: дальняя точка в замеренный момент, возврат в исходную, дрожь только у бура в удержании, замах лома", () => {
  const def = RECIPES["tool-use"];
  const sh = (kind: string, t: number, extra = {}) => def.evaluate(withDefaults(def, { kind, ...extra }), 0, 2, t).pitch!;
  const far = (kind: string) => { const p = withDefaults(def, { kind }), L = def.length!(p); let b = 0; for (let k = 0; k <= 1000; k++) if (sh(kind, (k / 1000) * L, { tremor: 0 }) < sh(kind, b, { tremor: 0 })) b = (k / 1000) * L; return b; };
  close(far("camera"), 0.53, 0.01, "камера");
  close(far("throw"), 0.17, 0.01, "бросок");
  close(far("scrap"), 0.23, 0.01, "лом");
  for (const kind of Object.keys(TOOL)) { const p = withDefaults(def, { kind }); close(sh(kind, def.length!(p)), 0, 1e-12, `${kind}: вернулась`); }
  assert.ok(sh("scrap", 0.1) > 0, "замах лома назад");
  assert.notEqual(sh("drill", 0.5), sh("drill", 0.5, { tremor: 0 }), "дрожь в удержании");
  assert.equal(sh("drill", 0.2), sh("drill", 0.2, { tremor: 0 }), "до удержания — без дрожи");
  assert.equal(sh("camera", 0.8), sh("camera", 0.8, { tremor: 0 }), "у камеры дрожи нет");
  const ev = def.events!(withDefaults(def, { kind: "scrap", speed: 2 }));
  assert.deepEqual(ev, [{ t: 0.1945, name: "hit" }, { t: 0.46, name: "window_open" }]);
  close(def.evaluate(withDefaults(def, { kind: "camera" }), 1, 2, 0.53).pitch!, 0, 1e-12, "в дальней точке локоть прям");
});

test("твин стаи Breathedge: выскок 7 м за 0.3 с, разворот 90 % к 0.53–1.23 с, рывок 5 % → 95 % за ≈ 1 с с пиком 600–900 м/с", () => {
  const lib = JSON.parse(readFileSync(new URL("../../../library/tweens/breathedge.json", import.meta.url), "utf8"));
  const p = lib.presets.find((x: any) => x.name === "breathedge-swarm-launch");
  assert.equal(p.target, "node");
  const s = (t: number) => sampleTween(p, t);
  close(s(0.3).y, 7, 1e-9, "выскок");
  let t90 = 0; for (let t = 0; t < 2; t += 0.001) if (!t90 && s(t).yaw >= 81) t90 = t;
  assert.ok(t90 >= 0.53 && t90 <= 1.23, `90 % разворота к ${t90}`);
  let t5 = 0, t95 = 0, vmax = 0;
  for (let t = 0; t < 4; t += 0.001) { const f = s(t).forward; if (!t5 && f >= 0.05 * 735) t5 = t; if (!t95 && f >= 0.95 * 735) t95 = t; vmax = Math.max(vmax, (s(t + 0.001).forward - f) / 0.001); }
  assert.ok(t5 >= 1.9 && t5 <= 2.5 && t95 >= 3.27 && t95 <= 3.37, `5 % в ${t5}, 95 % в ${t95}`);
  assert.ok(vmax >= 600 && vmax <= 900, `пик ${vmax} м/с`);
});

test("челюсть Haven: в таране открыта к концу замаха и закрыта к удару; в реакции распахнута к jawT, у смерти остаётся", () => {
  const ram = RECIPES["body-ram"], p = withDefaults(ram, { jawOpen: 53, role: "jaw" });
  const a = p.windupT, b = a + p.hold, c = b + p.strikeT;
  close(ram.evaluate(p, 0, 1, b).pitch!, 53, 1e-9, "пик в конце задержки замаха");
  close(ram.evaluate(p, 0, 1, c).pitch!, 0, 1e-9, "к удару закрыта");
  assert.deepEqual(ram.evaluate(withDefaults(ram, { role: "jaw" }), 0, 1, b), {}, "без jawOpen — не трогаем");
  const hr = RECIPES["hit-react"];
  const light = withDefaults(hr, { role: "jaw", jawOpen: 30, jawT: 0.12 });
  close(hr.evaluate(light, 0, 1, 0.12).pitch!, 30, 1e-9);
  close(hr.evaluate(light, 0, 1, light.settleT).pitch!, 0, 1e-9, "закрылась к успокоению");
  const death = withDefaults(hr, { role: "jaw", jawOpen: 30, jawT: 0.4, keep: 1, settleT: 1.67, peakT: 1.57, peakVelT: 0.7, duration: 1.67 });
  close(hr.evaluate(death, 0, 1, 1.67).pitch!, 30, 1e-9, "смерть — пасть открыта");
});

test("rig.detect: челюсть bn_Jaw (как в Haven) — цепочка jaw", () => {
  const sk = humanSkel(CONV.unreal);
  sk.nodes.push({ name: "bn_Jaw", parent: "head", restT: [0, -0.03, 0.06], restR: [0, 0, 0, 1], restS: [1, 1, 1], isJoint: true });
  assert.deepEqual(detectRig(sk, { up: [0, 1, 0] }).chains.jaw, ["bn_Jaw"]);
  assert.equal(detectRig(humanSkel(CONV.unreal), { up: [0, 1, 0] }).chains.jaw, undefined, "без челюсти — нет");
});

test("multileg-gait: у каждой ноги своя фаза (Heliga Haven) — вынос в замеренный момент, средние стоят короче", () => {
  const def = RECIPES["multileg-gait"];
  const lib = JSON.parse(readFileSync(new URL("../../../library/presets/multileg-gait.json", import.meta.url), "utf8"));
  const p = withDefaults(def, lib.presets.find((x: any) => x.name === "haven-heliga-walk").params);
  const lift = (role: string, t: number) => (def.evaluate({ ...p, role }, 0, 2, t).vertical ?? 0) as number;
  const meas: Record<string, number> = { leg_l0: 0, leg_r0: 0.434, leg_l1: 0.608, leg_r1: 0.159, leg_l2: 0.863, leg_r2: 0.404 };
  for (const [role, m] of Object.entries(meas)) {
    let start = -1, swing = 0;
    for (let k = 0; k < 2000; k++) { const t = (k / 2000) * p.period, a = lift(role, t), b = lift(role, t + p.period / 2000); if (a <= 1e-9 && b > 1e-9) start = t; if (b > 1e-9) swing++; }
    close(((start / p.period - m) % 1 + 1.5) % 1 - 0.5, 0, 0.002, `${role}: вынос в ${start / p.period}, замер ${m}`);
    close(1 - swing / 2000, role.endsWith("1") ? 0.42 : 0.6, 0.002, `${role}: опора`);
  }
  // без таблицы — прежняя формула по lag и side
  const tri = withDefaults(def, { lag: 0.5, side: 0.5 });
  close(multilegPhase(tri, "r", 1, 0.1), multilegPhase({ ...tri, ph_r1: -1 }, "r", 1, 0.1), 1e-12);
  close(multilegPhase(tri, "r", 1, 0), ((0 - (-0.5 + 0.5)) % 1 + 1) % 1, 1e-12, "трипод как раньше");
});

test("wing-flap: пауза вверху, гребок вбок и крен перьев (Haven); без них — как раньше", () => {
  const def = RECIPES["wing-flap"];
  const base = withDefaults(def, { period: 1, amp: 40, mean: 0, down: 0.5, lag: 0 });
  const ev = (extra: Record<string, unknown>, i: number, t: number) => def.evaluate({ ...base, ...extra }, i, 3, t, { height: 1 });
  // пауза 0.17: всю долю паузы крыло наверху (+amp), потом взмах
  for (const t of [0, 0.08, 0.16]) close(ev({ pause: 0.17 }, 0, t).vertical!, 40, 1e-9, `пауза t=${t}`);
  assert.ok(ev({ pause: 0.17 }, 0, 0.3).vertical! < 40 - 1, "после паузы — взмах");
  close(ev({ pause: 0.17 }, 0, 0.17 + 0.83 * 0.5).vertical!, -40, 1e-9, "низ взмаха — середина оставшегося цикла");
  // гребок вбок: ход основания — рыскание, зеркально у правого
  const lat = ev({ stroke: "lateral" }, 0, 0.2);
  assert.equal(lat.vertical, undefined);
  close(ev({ stroke: "lateral", role: "wing_r" }, 0, 0.2).yaw!, -lat.yaw!, 1e-12, "правое — зеркально");
  // крен перьев — у дальних костей, основание без крена
  assert.equal(ev({ featherRoll: 20 }, 0, 0.3).roll, undefined);
  let mx = 0; for (let k = 0; k < 200; k++) mx = Math.max(mx, Math.abs(ev({ featherRoll: 20 }, 2, k / 200).roll!));
  close(mx, 20, 1e-3, "±20°");
  assert.equal(ev({}, 2, 0.3).roll, undefined, "по умолчанию крена нет");
});

test("hover Ghost Master: нырок банши несимметричный, голова отстаёт на 0.37 цикла, руки-противовес в противофазе", () => {
  const def = RECIPES.hover;
  const lib = JSON.parse(readFileSync(new URL("../../../library/presets/hover.json", import.meta.url), "utf8"));
  const pre = (name: string) => withDefaults(def, lib.presets.find((x: any) => x.name === name).params);
  const dive = pre("gm-banshee-dive"), T = dive.period;
  const up = (t: number) => def.evaluate({ ...dive, role: "pelvis" }, 0, 1, t, { height: 1 }).move_up!;
  let lo = 0, hi = 0; for (let k = 0; k < 2000; k++) { const t = (k / 2000) * T; if (up(t) < up(lo)) lo = t; if (up(t) > up(hi)) hi = t; }
  // провал быстрый (≈0.15 цикла от начала спуска), подъём вдвое дольше, оседание — почти полцикла
  close(lo / T, 0.25, 0.03, "низ на 0.25 цикла");
  close(hi / T, 0.57, 0.04, "верх на ≈0.55");
  close(up(hi) - up(lo), 0.73 / 0.366 * 0.38, 0.02, "размах подъёма 0.73 м");
  const sheet = pre("gm-sheet-ghost-idle");
  const at = (role: string, i: number, t: number) => def.evaluate({ ...sheet, role }, i, 2, t, { height: 1 });
  let hb = 0, hh = 0; for (let k = 0; k < 2000; k++) { const t = (k / 2000) * sheet.period; if (at("pelvis", 0, t).move_up! > at("pelvis", 0, hb).move_up!) hb = t; if ((at("head", 0, t).pitch ?? 0) + (at("chest", 0, t).pitch ?? 0) > (at("head", 0, hh).pitch ?? 0) + (at("chest", 0, hh).pitch ?? 0)) hh = t; }
  close(hb / sheet.period, 0.5, 0.002, "верх подскока 0.5");
  close(((hh - hb) / sheet.period + 1) % 1, 0.37, 0.003, "голова в мире отстаёт на 0.37");
  close(at("arm", 0, hb + 0.49 * sheet.period).pitch!, 21, 1e-6, "плечо ±21 с пиком через 0.49");
  close(at("arm", 1, hb).pitch!, 21 * 1.14, 1e-6, "локоть в противофазе");
  assert.deepEqual(def.evaluate(withDefaults(def, { role: "arm" }), 0, 2, 0.3), {}, "без armCounter руки не трогаем");
  close(def.evaluate(withDefaults(def, {}), 0, 1, 0.75 * withDefaults(def, {}).period, { height: 1 }).move_up!, withDefaults(def, {}).bob, 1e-9, "Witcher: верх на 0.75 как раньше");
});
