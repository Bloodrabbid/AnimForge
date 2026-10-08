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


/** Сгладить веса у границ соседних костей (родитель — ребёнок): там, где вершины жёстко поделены между бедром и голенью,
 * при сгибе колена открывается щель. Берём вершины в rings рёбрах от такой границы и iters раз усредняем веса
 * с соседями (4 самые тяжёлые кости, сумма 1). Соседи — по рёбрам треугольников и по совпадающим позициям (швы UV
 * дублируют вершины — иначе по шву разошлись бы веса). parent — родитель кости среди костей скина.
 * Меняет j и w на месте, возвращает число изменённых вершин. */
export function smoothJointWeights(
  j: Uint16Array, w: Float32Array, pos: Float32Array, faces: ArrayLike<number>, parent: ArrayLike<number>, rings = 3, iters = 6,
): number {
  const n = pos.length / 3;
  // одна вершина на позицию: швы UV сшиваем
  const key = new Map<string, number>(), rep = new Int32Array(n);
  for (let i = 0; i < n; i++) {
    const k = `${pos[i * 3].toFixed(5)},${pos[i * 3 + 1].toFixed(5)},${pos[i * 3 + 2].toFixed(5)}`;
    if (!key.has(k)) key.set(k, i);
    rep[i] = key.get(k)!;
  }
  const nb = new Map<number, Set<number>>();
  const link = (a: number, b: number) => { if (a === b) return; (nb.get(a) ?? nb.set(a, new Set()).get(a)!).add(b); (nb.get(b) ?? nb.set(b, new Set()).get(b)!).add(a); };
  for (let t = 0; t + 2 < faces.length; t += 3) { const a = rep[faces[t]], b = rep[faces[t + 1]], c = rep[faces[t + 2]]; link(a, b); link(b, c); link(c, a); }
  const main = (v: number) => { let m = 0; for (let k = 1; k < 4; k++) if (w[v * 4 + k] > w[v * 4 + m]) m = k; return j[v * 4 + m]; };
  const kin = (a: number, b: number) => parent[a] === b || parent[b] === a;
  // граница: у соседей главные кости — родитель и ребёнок
  let front = [...nb.keys()].filter((v) => [...nb.get(v)!].some((u) => main(u) !== main(v) && kin(main(u), main(v))));
  const zone = new Set(front);
  for (let r = 0; r < rings; r++) {
    const next: number[] = [];
    for (const v of front) for (const u of nb.get(v)!) if (!zone.has(u)) { zone.add(u); next.push(u); }
    front = next;
  }
  if (!zone.size) return 0;
  const get = (v: number) => { const m = new Map<number, number>(); for (let k = 0; k < 4; k++) if (w[v * 4 + k] > 0) m.set(j[v * 4 + k], (m.get(j[v * 4 + k]) ?? 0) + w[v * 4 + k]); return m; };
  const put = (v: number, m: Map<number, number>) => {
    const top = [...m].sort((a, b) => b[1] - a[1]).slice(0, 4);
    const s = top.reduce((a, [, x]) => a + x, 0) || 1;
    for (let k = 0; k < 4; k++) { j[v * 4 + k] = top[k]?.[0] ?? 0; w[v * 4 + k] = top[k] ? top[k][1] / s : 0; }
  };
  for (let it = 0; it < iters; it++) {
    const out = new Map<number, Map<number, number>>();
    for (const v of zone) {
      const acc = get(v);
      for (const u of nb.get(v)!) for (const [b, x] of get(u)) acc.set(b, (acc.get(b) ?? 0) + x);
      out.set(v, acc);
    }
    for (const [v, m] of out) put(v, m);
  }
  // дубликаты по швам — те же веса, что у представителя
  for (let i = 0; i < n; i++) if (rep[i] !== i && zone.has(rep[i])) for (let k = 0; k < 4; k++) { j[i * 4 + k] = j[rep[i] * 4 + k]; w[i * 4 + k] = w[rep[i] * 4 + k]; }
  return [...Array(n).keys()].filter((i) => zone.has(rep[i])).length;
}
