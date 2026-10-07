// Тесты ядра. Каждый проверяет конкретное число, которое сломается при ошибке в формуле, — тест должен уметь падать.
import assert from "node:assert/strict";
import { test } from "node:test";
import { evalKeys } from "./curves.ts";
import { bakeClip, buildRig, poseAt } from "./evaluate.ts";
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
