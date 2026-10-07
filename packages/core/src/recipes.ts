// Реестр рецептов. Рецепт по параметрам и цепочке костей выдаёт углы по семантическим осям в момент t.
// Параметры описаны схемой — по ней интерфейс рисует ползунки, а агент знает, что можно менять.
import type { SemanticAxis } from "./project.ts";

export interface ParamSpec {
  type: "number" | "enum";
  default: number | string;
  min?: number;
  max?: number;
  unit?: string;
  options?: string[];
  help: string;
}

export interface RecipeDef {
  name: string;
  help: string;
  params: Record<string, ParamSpec>;
  /** Углы в градусах для кости chain[i] в момент t. */
  evaluate(p: Record<string, any>, i: number, n: number, t: number): Partial<Record<SemanticAxis, number>>;
}

const wave: RecipeDef = {
  name: "wave",
  help:
    "Волна по цепочке: синус с задержкой фазы от основания к кончику и амплитудой, растущей к кончику. " +
    "Плавание рыб и скатов (plane=lateral), китов и дельфинов (plane=vertical), щупальца, хвосты, змеи.",
  params: {
    plane: { type: "enum", default: "lateral", options: ["lateral", "vertical"], help: "lateral — вбок (рыбы, скаты), vertical — вверх-вниз (киты, дельфины)" },
    period: { type: "number", default: 1.6, min: 0.2, max: 8, unit: "с", help: "период одного взмаха" },
    tipAmp: { type: "number", default: 12, min: 0, max: 60, unit: "°", help: "амплитуда кончика (последней кости)" },
    growth: { type: "number", default: 1.5, min: 0.5, max: 3, help: "рост амплитуды к кончику: A_i = tipAmp·((i+1)/n)^growth; 1 — дельфин, 2 — кит" },
    bodyDelay: { type: "number", default: 120, min: 0, max: 360, unit: "°", help: "задержка фазы по всему телу от первой кости до кончика (не зависит от числа костей)" },
    headAmp: { type: "number", default: 0, min: 0, max: 30, unit: "°", help: "если > 0, первая кость цепочки — голова: качается с опережением headLead" },
    headLead: { type: "number", default: 90, min: 0, max: 180, unit: "°", help: "опережение головы по фазе (в DREDGE ≈ четверть периода)" },
  },
  evaluate(p, i, n, t) {
    const w = 2 * Math.PI * (t / p.period);
    const rad = Math.PI / 180;
    if (p.headAmp > 0) {
      if (i === 0) return { [p.plane as SemanticAxis]: p.headAmp * Math.sin(w + p.headLead * rad) };
      i -= 1;
      n -= 1;
    }
    const amp = p.tipAmp * Math.pow((i + 1) / n, p.growth);
    const dphi = n > 1 ? (p.bodyDelay / (n - 1)) * rad : 0;
    return { [p.plane as SemanticAxis]: amp * Math.sin(w - i * dphi) };
  },
};

export const RECIPES: Record<string, RecipeDef> = { wave };

export function withDefaults(def: RecipeDef, params: Record<string, unknown>): Record<string, any> {
  const out: Record<string, any> = {};
  for (const [k, s] of Object.entries(def.params)) out[k] = params[k] ?? s.default;
  return out;
}
