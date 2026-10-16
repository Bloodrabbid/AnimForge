// Эталон для сверки AFRecipes (godot/sandbox/addons/animforge/live/af_recipes.gd) с ядром: входы и выходы evaluate,
// events и length по каждому рецепту. Наборы параметров — значения по умолчанию, пресеты библиотеки и каждое значение
// каждого enum-параметра поверх них. Проверка — `recipes.verify` (node.ts) и godot/sandbox/tests/recipes_verify.gd.
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { RECIPES, STARTLE, glancePlan, strikePlan, withDefaults } from "../../core/src/index.ts";

const LIB = resolve(dirname(fileURLToPath(import.meta.url)), "../../../library/presets");
const NS = [1, 3, 6];
const HEIGHTS = [0, 0.9];
const SIZE = 1.7;
const EPS = 1e-7;

// JSON не передаёт NaN и ±∞ — кодируем строкой, Godot сравнит строки
const num = (x: number) => (Number.isFinite(x) ? x : String(x));
const enc = (o: Record<string, number | undefined>) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, num(v as number)]));

function presetParams(recipe: string): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  for (const f of readdirSync(LIB).filter((f) => f.endsWith(".json"))) {
    const lib = JSON.parse(readFileSync(join(LIB, f), "utf8")) as { recipe: string; presets: { recipe?: string; params: Record<string, unknown> }[] };
    for (const p of lib.presets) if ((p.recipe ?? lib.recipe) === recipe) out.push(p.params ?? {});
  }
  return out;
}

/** Моменты, где формула меняет ветку: проверяем точно в них и рядом. */
function keyTimes(recipe: string, p: Record<string, any>): number[] {
  switch (recipe) {
    case "compass-step": return [p.period / 2, p.openTime, p.period / 2 + p.openTime, p.period];
    case "blink": { const c = p.close, h = c + p.hold, o = h + p.open; return [c, h, o, o + p.settle, p.interval]; }
    case "melee-strike": {
      const pl = strikePlan(p);
      return [0, pl.s0, ...pl.hits, ...Array.from({ length: Math.max(0, Math.floor(p.hits)) + 1 }, (_, k) => pl.s0 + k * pl.swing), pl.end, pl.end + pl.recover, pl.total].map((x) => x + p.start);
    }
    case "charge-release": {
      const A = p.windup, B = A + p.hold, h1 = B + p.hit1 - 0.053, h2 = B + p.hit2 - 0.053, E = B + p.release;
      return [A, B, h1, h2, h1 + (h2 - h1) / 2, h2 + (E - h2) / 2, E];
    }
    case "tentacle-strike": {
      const t1 = p.windupT, t2 = t1 + p.strikeT, t3 = t2 + p.hold, t4 = t3 + p.returnT;
      return [0, 1, 2, 5].flatMap((i) => [0, t1, t2, t3, t4].map((x) => x + i * p.delay));
    }
    case "emerge": {
      const pre = p.anticipation > 0 ? p.preT : 0;
      return [pre, pre + p.rise * (1 - pre), 1].map((u) => u * p.duration);
    }
    case "idle-glance": return [0, p.period, ...glancePlan(p).segs.flatMap((g) => [g.a, g.b, (g.a + g.b) / 2])];
    case "scare-pose": { const pre = p.anticipation > 0 ? p.preT : 0, a = pre + p.rise, b = a + p.settle; return [0, pre, a, b, Math.max(p.duration, b + 0.01)]; }
    case "startle": return STARTLE[p.kind].t.map((x: number) => x / p.speed);
    case "hit-react": {
      const T = [0, p.windupT, p.peakVelT, p.peakT, p.settleT, p.duration];
      return [...T, ...T.map((x) => x + p.headLag)];
    }
    case "body-ram": {
      const a = p.windupT, b = a + p.hold, c = b + p.strikeT, d = c + p.contact, e = d + p.recover;
      const T = [0, a, b, c, d, e, e + p.settle * 0.45, e + p.settle];
      return [...T, ...T.map((x) => x + p.headLag)];
    }
    case "wing-flap": return [0, 1, 2].flatMap((i) => [0, p.down, 1].map((u) => (u + i * p.lag) * p.period)).concat([0.1, 0.2].map((s) => (s + p.down) * p.period));
    case "multileg-gait": return [0, p.duty, 1].map((u) => u * p.period);
    default: return p.period !== undefined ? [0, p.period / 2, p.period] : [0];
  }
}

function times(recipe: string, p: Record<string, any>): number[] {
  const def = RECIPES[recipe];
  const span = def.length?.(p) ?? p.period ?? p.interval ?? p.duration ?? 2;
  const end = 2 * span;
  const ts = Array.from({ length: 40 }, (_, k) => -0.1 + ((end + 0.1) * k) / 39);
  for (const k of keyTimes(recipe, p)) if (Number.isFinite(k)) ts.push(k, k - EPS, k + EPS);
  return ts;
}

type VectorSet = { params: Record<string, any>; events: unknown[]; length: number | string; ts: number[]; rows: { n: number; i: number; height: number; out: Record<string, unknown>[] }[] };

export function recipeVectors(): { size: number; recipes: Record<string, { secondary: boolean; sets: VectorSet[] }> } {
  const recipes: ReturnType<typeof recipeVectors>["recipes"] = {};
  for (const [name, def] of Object.entries(RECIPES)) {
    const bases = [{}, ...presetParams(name)].map((x) => withDefaults(def, x));
    const sets = new Map<string, Record<string, any>>();
    const add = (p: Record<string, any>) => sets.set(JSON.stringify(p), p);
    for (const b of bases) {
      add(b);
      for (const [k, s] of Object.entries(def.params)) if (s.type === "enum") for (const o of s.options ?? []) add({ ...b, [k]: o });
    }
    recipes[name] = { secondary: !!def.secondary, sets: [...sets.values()].map((p) => {
      const ts = times(name, p);
      const rows = [];
      for (const n of NS) for (let i = 0; i < n; i++) for (const height of HEIGHTS) {
        rows.push({ n, i, height, out: ts.map((t) => enc(def.evaluate(p, i, n, t, { height, size: SIZE }))) });
      }
      return { params: p, events: (def.events?.(p) ?? []).map((e) => ({ t: num(e.t), name: e.name })), length: num(def.length?.(p) ?? -1), ts, rows };
    }) };
  }
  return { size: SIZE, recipes };
}
