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
    bodyDelay: { type: "number", default: 120, min: 0, max: 720, unit: "°", help: "задержка фазы по всему телу от первой кости до кончика (не зависит от числа костей); > 360 — на теле больше одной волны, как у змеи" },
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


const curl: RecipeDef = {
  name: "curl",
  help:
    "Изгиб цепочки: угол распределён по костям с ростом к кончику, может пульсировать. " +
    "Загиб щупальца, поджатый хвост, дыхание (маленький пульсирующий изгиб спины), сжатие перед прыжком.",
  params: {
    plane: { type: "enum", default: "vertical", options: ["lateral", "vertical", "roll"], help: "в какой плоскости гнуть" },
    angle: { type: "number", default: 40, min: -180, max: 180, unit: "°", help: "суммарный изгиб всей цепочки" },
    growth: { type: "number", default: 1, min: 0, max: 3, help: "0 — поровну на все кости, больше — сильнее к кончику" },
    pulse: { type: "number", default: 0, min: 0, max: 1, help: "доля изгиба, которая пульсирует (0 — статично, 1 — от 0 до 2·angle)" },
    period: { type: "number", default: 3, min: 0.2, max: 10, unit: "с", help: "период пульсации" },
    phase: { type: "number", default: 0, min: 0, max: 360, unit: "°", help: "сдвиг пульсации (чтобы разнести несколько слоёв или существ)" },
  },
  evaluate(p, i, n, t) {
    // веса костей ∝ ((i+1)/n)^growth, нормированы так, что сумма углов = angle
    let sum = 0;
    for (let j = 0; j < n; j++) sum += Math.pow((j + 1) / n, p.growth);
    const share = Math.pow((i + 1) / n, p.growth) / sum;
    const k = 1 + p.pulse * Math.sin(2 * Math.PI * (t / p.period) + (p.phase * Math.PI) / 180);
    return { [p.plane as SemanticAxis]: p.angle * share * k };
  },
};


// Пружина второго порядка x'' = ω²(цель − x) − 2ζωx' по периодической цели. Возвращает установившийся цикл:
// значение зависит только от фазы, поэтому запечённый цикл замыкается без рывка.
const springCache = new Map<string, Float64Array>();
function springCycle(key: string, period: number, hz: number, zeta: number, target: (tau: number) => number): Float64Array {
  const hit = springCache.get(key);
  if (hit) return hit;
  const steps = Math.max(8, Math.ceil(period * 480));
  const dt = period / steps;
  const w = 2 * Math.PI * hz;
  let x = target(0), v = 0;
  const out = new Float64Array(steps + 1);
  for (let cycle = 0; cycle < 6; cycle++) {
    for (let k = 0; k < steps; k++) {
      if (cycle === 5) out[k] = x;
      // полунеявный Эйлер: устойчив при ω·dt ≪ 1 (здесь ω·dt < 0.1 до 7 Гц)
      v += (w * w * (target(k * dt) - x) - 2 * zeta * w * v) * dt;
      x += v * dt;
    }
  }
  out[steps] = out[0];
  if (springCache.size > 256) springCache.clear();
  springCache.set(key, out);
  return out;
}

const compassStep: RecipeDef = {
  name: "compass-step",
  help:
    "Шаг циркулем (Biped): шагающая нога раскрывается на reach за openTime, опорная отклоняется на −support, " +
    "корпус кренится на coreRoll над опорной ногой. Ноги в противофазе. Резкие смены позы сглаживает пружина " +
    "(springHz, damping) — в игре это делают физические PD-пружины. Один слой на цепочку: role = leg_left | leg_right | core. " +
    "Ноги — вертикальные цепочки вниз, plane=vertical (мах вперёд-назад); корпус — plane=lateral (крен вбок).",
  params: {
    role: { type: "enum", default: "leg_left", options: ["leg_left", "leg_right", "core"], help: "чем управляет слой" },
    plane: { type: "enum", default: "vertical", options: ["lateral", "vertical", "roll"], help: "ось поворота: для ноги vertical (вперёд-назад), для корпуса lateral (крен вбок у вертикальной спины)" },
    period: { type: "number", default: 1.2, min: 0.3, max: 4, unit: "с", help: "цикл из двух шагов; в Biped темп задаёт игрок стиком — в коде числа нет" },
    reach: { type: "number", default: 90, min: 0, max: 120, unit: "°", help: "мах шагающей ноги (Biped: 90, лёд 108, хват 120)" },
    support: { type: "number", default: 36, min: 0, max: 60, unit: "°", help: "отклонение опорной ноги назад (Biped: 36, старая модель 45)" },
    coreRoll: { type: "number", default: 36, min: -45, max: 45, unit: "°", help: "крен корпуса над опорной ногой; минус — в другую сторону" },
    openTime: { type: "number", default: 0.28, min: 0.03, max: 1, unit: "с", help: "за сколько поза шага раскрывается полностью (Biped: 0.28, лёд 0.083)" },
    gain: { type: "number", default: 1, min: 0, max: 1, help: "какую долю целевых углов тело реально проходит: в Biped 90°/36° — цели PD-пружин с ограниченной силой, под гравитацией они не достигаются" },
    springHz: { type: "number", default: 1.6, min: 0.5, max: 7, unit: "Гц", help: "собственная частота сглаживающей пружины (Biped ≈ 1.6 свободно, 3.9 при кручении стика — оценка)" },
    damping: { type: "number", default: 0.47, min: 0.1, max: 2, help: "ζ пружины: < 1 — с перелётом, 1 — критическое" },
  },
  evaluate(p, i, n, t) {
    if (i > 0) return {}; // нога циркуля жёсткая, корпус кренится целиком: двигается только первая кость цепочки
    const half = p.period / 2;
    const ramp = (tau: number) => Math.min(1, tau / p.openTime);
    const g = p.gain;
    const legL = (tau: number) => g * (tau < half ? p.reach * ramp(tau) : -p.support * ramp(tau - half));
    const target =
      p.role === "leg_left" ? legL
      : p.role === "leg_right" ? (tau: number) => legL((tau + half) % p.period)
      : (tau: number) => g * (tau < half ? -p.coreRoll * ramp(tau) : p.coreRoll * ramp(tau - half));
    const key = [p.role, p.gain, p.period, p.reach, p.support, p.coreRoll, p.openTime, p.springHz, p.damping].join("|");
    const cyc = springCycle(key, p.period, p.springHz, p.damping, target);
    const steps = cyc.length - 1;
    const f = ((((t % p.period) + p.period) % p.period) / p.period) * steps;
    const k = Math.min(steps - 1, Math.floor(f));
    return { [p.plane as SemanticAxis]: cyc[k] + (cyc[k + 1] - cyc[k]) * (f - k) };
  },
};

export const RECIPES: Record<string, RecipeDef> = { wave, curl, "compass-step": compassStep };

export function withDefaults(def: RecipeDef, params: Record<string, unknown>): Record<string, any> {
  const out: Record<string, any> = {};
  for (const [k, s] of Object.entries(def.params)) out[k] = params[k] ?? s.default;
  return out;
}
