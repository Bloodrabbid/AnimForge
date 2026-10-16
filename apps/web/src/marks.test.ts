// Ручные точки авторига: зеркало ставит парную точку отражением поперёк тела, следующая — первая пустая;
// перепутанные стороны (кликнули правую как левую) меняются местами целиком.
import assert from "node:assert/strict";
import { test } from "node:test";
import { fixSides, leftAxis, placeMark, type Marks } from "./marks.ts";

const left = leftAxis([0, 1, 0], [0, 0, 1]);

test("левая сторона персонажа: up × forward, у glTF — +X", () => {
  assert.deepEqual(left.map((x) => +x.toFixed(6) + 0), [1, 0, 0]);
});

test("зеркало: запястье левое ставит правое через подбородок, дальше — первая пустая", () => {
  let r = placeMark({}, "chin", [0.1, 1.5, 0.05], true, left);
  assert.equal(r.next, "groin");
  r = placeMark(r.marks, "groin", [0.1, 0.9, 0.05], true, left);
  r = placeMark(r.marks, "wrist_l", [0.9, 1.4, 0.02], true, left);
  assert.deepEqual(r.marks.wrist_r, [-0.7, 1.4, 0.02]);
  assert.equal(r.next, "elbow_l");
  // без зеркала парная не появляется
  const s = placeMark(r.marks, "elbow_l", [0.5, 1.4, 0], false, left);
  assert.equal(s.marks.elbow_r, undefined);
  assert.equal(s.next, "knee_l");
});

test("кликнули наоборот — пары левых и правых меняются местами; верно — без изменений", () => {
  const m: Marks = { wrist_l: [-0.8, 1, 0], wrist_r: [0.8, 1, 0], elbow_l: [-0.4, 1, 0], elbow_r: [0.4, 1, 0], knee_l: [-0.1, 0.5, 0], knee_r: [0.1, 0.5, 0] };
  const r = fixSides(m, left);
  assert.ok(r.swapped);
  assert.deepEqual([r.marks.wrist_l, r.marks.elbow_l, r.marks.knee_l], [m.wrist_r, m.elbow_r, m.knee_r]);
  assert.deepEqual([r.marks.wrist_r, r.marks.elbow_r, r.marks.knee_r], [m.wrist_l, m.elbow_l, m.knee_l]);
  assert.equal(fixSides(r.marks, left).swapped, false);
});
