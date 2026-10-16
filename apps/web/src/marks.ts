// Ручные точки авторига: порядок, цвета, зеркало и проверка сторон — без React, чтобы проверялось тестом.
export type MarkKey = "chin" | "groin" | "wrist_l" | "elbow_l" | "knee_l" | "wrist_r" | "elbow_r" | "knee_r";
export type Marks = Partial<Record<MarkKey, [number, number, number]>>;
type V = [number, number, number];

export const MARKS: { key: MarkKey; title: string; color: string }[] = [
  { key: "chin", title: "подбородок", color: "#ffb547" },
  { key: "groin", title: "пах", color: "#ffb547" },
  { key: "wrist_l", title: "запястье левое", color: "#5fb3ff" },
  { key: "elbow_l", title: "локоть левый", color: "#5fb3ff" },
  { key: "knee_l", title: "колено левое", color: "#5fb3ff" },
  { key: "wrist_r", title: "запястье правое", color: "#ff7a7a" },
  { key: "elbow_r", title: "локоть правый", color: "#ff7a7a" },
  { key: "knee_r", title: "колено правое", color: "#ff7a7a" },
];

const other = (k: MarkKey): MarkKey | undefined => (k.endsWith("_l") ? (k.replace(/_l$/, "_r") as MarkKey) : k.endsWith("_r") ? (k.replace(/_r$/, "_l") as MarkKey) : undefined);
const sub = (a: V, b: V): V => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a: V, b: V) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

/** Левая сторона персонажа: up × forward. */
export function leftAxis(up: V, forward: V): V {
  const s: V = [up[1] * forward[2] - up[2] * forward[1], up[2] * forward[0] - up[0] * forward[2], up[0] * forward[1] - up[1] * forward[0]];
  const n = Math.hypot(...s) || 1;
  return [s[0] / n, s[1] / n, s[2] / n];
}

/** Поставить точку key; с зеркалом — и парную (отражение через подбородок или пах поперёк тела). Следующая — первая пустая. */
export function placeMark(marks: Marks, key: MarkKey, p: V, mirror: boolean, left: V): { marks: Marks; next: MarkKey | null } {
  const out: Marks = { ...marks, [key]: p };
  const o = other(key);
  const c = out.chin ?? out.groin;
  if (mirror && o && c) {
    const d = 2 * dot(sub(p, c), left);
    out[o] = [p[0] - d * left[0], p[1] - d * left[1], p[2] - d * left[2]].map((x) => +x.toFixed(4)) as V;
  }
  return { marks: out, next: MARKS.find((m) => !out[m.key])?.key ?? null };
}

/** Левые точки должны лежать слева от правых (кликнули наоборот — меняем пары местами). */
export function fixSides(marks: Marks, left: V): { marks: Marks; swapped: boolean } {
  const { wrist_l, wrist_r } = marks;
  if (!wrist_l || !wrist_r || dot(sub(wrist_l, wrist_r), left) >= 0) return { marks, swapped: false };
  const out: Marks = { ...marks };
  for (const k of ["wrist_l", "elbow_l", "knee_l"] as const) [out[k], out[other(k)!]] = [marks[other(k)!], marks[k]];
  return { marks: out, swapped: true };
}

