// Кривые ручного слоя. Три вида перехода — всё, что реально встретилось в разборе DREDGE:
// smooth (сплайн), linear (прямая) и step (ступенька: держать значение до следующего ключа).
import type { Key } from "./project.ts";

export function evalKeys(keys: Key[], t: number, loop: boolean, duration: number): number {
  if (keys.length === 0) return 0;
  const ks = [...keys].sort((a, b) => a.t - b.t);
  if (loop && duration > 0) t = ((t % duration) + duration) % duration;
  if (t <= ks[0].t) return ks[0].v;
  const last = ks[ks.length - 1];
  if (t >= last.t) return last.v;
  let i = 0;
  while (ks[i + 1].t < t) i++;
  const a = ks[i], b = ks[i + 1];
  const mode = a.interp ?? "smooth";
  if (mode === "step") return a.v;
  const u = (t - a.t) / (b.t - a.t);
  if (mode === "linear") return a.v + (b.v - a.v) * u;
  // Catmull-Rom касательные; на краях плоские — так клип мягко стартует и останавливается.
  const slope = (j: number) => {
    if (j <= 0 || j >= ks.length - 1) return 0;
    return (ks[j + 1].v - ks[j - 1].v) / (ks[j + 1].t - ks[j - 1].t);
  };
  const h = b.t - a.t;
  const m0 = slope(i) * h, m1 = slope(i + 1) * h;
  const u2 = u * u, u3 = u2 * u;
  return (2 * u3 - 3 * u2 + 1) * a.v + (u3 - 2 * u2 + u) * m0 + (-2 * u3 + 3 * u2) * b.v + (u3 - u2) * m1;
}
