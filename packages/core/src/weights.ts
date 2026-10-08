// Веса кожи: у вершины 4 слота (кость, вес), сумма весов — 1. Правка веса одной кости — как кисть в Blender:
// остальные кости делят остаток пропорционально прежним весам.

/** Вес кости bone у вершины: сумма по слотам с этой костью. */
export function boneWeight(idx: ArrayLike<number>, w: ArrayLike<number>, bone: number): number {
  let s = 0;
  for (let k = 0; k < 4; k++) if (idx[k] === bone) s += w[k];
  return s;
}

/** Поставить вес кости bone = value (0…1) в 4 слотах вершины, сумма остаётся 1.
 * Если кости в слотах нет — она занимает самый лёгкий слот. Если других костей нет, а вес уменьшают, —
 * остаток уходит запасной кости fallback (обычно родителю), иначе вершина повисла бы ни на чём.
 * Меняет idx и w на месте. */
export function setBoneWeight(idx: number[], w: number[], bone: number, value: number, fallback: number): void {
  value = Math.min(1, Math.max(0, value));
  // слоты с этой костью сводим в один
  let slot = -1;
  for (let k = 0; k < 4; k++) {
    if (idx[k] !== bone) continue;
    if (slot < 0) slot = k;
    else { w[slot] += w[k]; w[k] = 0; }
  }
  if (slot < 0) {
    if (value === 0) return;
    slot = 0;
    for (let k = 1; k < 4; k++) if (w[k] < w[slot]) slot = k;
    idx[slot] = bone;
    w[slot] = 0;
  }
  const others = w.reduce((s, x, k) => (k === slot ? s : s + x), 0);
  if (others < 1e-9) {
    w[slot] = value;
    if (value < 1) {
      // остаток — запасной кости в свободный слот
      const free = [0, 1, 2, 3].find((k) => k !== slot && (w[k] === 0 || idx[k] === fallback))!;
      idx[free] = fallback;
      w[free] = 1 - value;
    }
  } else {
    const scale = (1 - value) / others;
    for (let k = 0; k < 4; k++) if (k !== slot) w[k] *= scale;
    w[slot] = value;
  }
  for (let k = 0; k < 4; k++) if (w[k] < 1e-6) w[k] = 0;
}

/** Мягкий край кисти: 1 в центре, 0 на радиусе. */
export const brushFalloff = (d: number, r: number) => (d >= r ? 0 : (1 - (d / r) ** 2) ** 2);
