// Реестр рецептов. Рецепт по параметрам и цепочке костей выдаёт углы по семантическим осям в момент t.
// Параметры описаны схемой — по ней интерфейс рисует ползунки, а агент знает, что можно менять.
import type { Channel, SemanticAxis } from "./project.ts";

export interface ParamSpec {
  type: "number" | "enum";
  default: number | string;
  min?: number;
  max?: number;
  unit?: string;
  options?: string[];
  help: string;
}

export interface BoneInfo {
  height: number;
}

export interface RecipeDef {
  name: string;
  help: string;
  params: Record<string, ParamSpec>;
  /** Значения каналов для кости chain[i] в момент t: углы в градусах, сдвиги в метрах, масштаб — множитель.
   * info.height — высота кости над нижней костью скелета в rest (чтобы подскок задавать долей роста). */
  evaluate(p: Record<string, any>, i: number, n: number, t: number, info?: BoneInfo): Partial<Record<Channel, number>>;
  /** Вторичная динамика: считается не формулой, а симуляцией по движению остальных слоёв (evaluate.ts). */
  secondary?: boolean;
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


// Подскок таза Tools Up! (WalkCycle_3): высоты таза по кадрам одного шага, 14 кадров, 0.490 … 0.507 (02 §2.1).
// Нормируем к [−1, 0]: 0 — вершина, −1 — низ. Между кадрами — замкнутый Catmull-Rom.
const BOB_H = [0.490, 0.452, 0.416, 0.398, 0.409, 0.438, 0.469, 0.491, 0.505, 0.512, 0.515, 0.515, 0.514, 0.507];
const BOB = BOB_H.map((h) => (h - Math.max(...BOB_H)) / (Math.max(...BOB_H) - Math.min(...BOB_H)));
function bobAt(s: number): number {
  const n = BOB.length;
  const f = (((s % 1) + 1) % 1) * n;
  const k = Math.floor(f), u = f - k;
  const p0 = BOB[(k - 1 + n) % n], p1 = BOB[k], p2 = BOB[(k + 1) % n], p3 = BOB[(k + 2) % n];
  return 0.5 * (2 * p1 + (p2 - p0) * u + (2 * p0 - 5 * p1 + 4 * p2 - p3) * u * u + (3 * p1 - p0 - 3 * p2 + p3) * u * u * u);
}

const waddleWalk: RecipeDef = {
  name: "waddle-walk",
  help:
    "Мультяшная ходьба вразвалку (Tools Up!): таз рыщет и подпрыгивает, плечи в противофазе, голова стабилизирована, " +
    "руки маятником, ноги — простой мах с подгибом колена. Один слой на роль. У вертикальной цепочки (спина, ноги, руки) " +
    "каналы такие: roll — поворот вокруг вертикали (рыскание), lateral — крен вбок, vertical — мах вперёд-назад.",
  params: {
    role: { type: "enum", default: "pelvis", options: ["pelvis", "chest", "head", "arm_l", "arm_r", "leg_l", "leg_r"], help: "какую часть тела крутит слой (первая кость цепочки; у ног и рук — две кости)" },
    period: { type: "number", default: 0.479, min: 0.3, max: 1.2, unit: "с", help: "цикл из двух шагов (Tools Up!: 0.479; с ношей 0.5–0.6)" },
    pelvisYaw: { type: "number", default: 32, min: 0, max: 45, unit: "°", help: "рыскание таза, один раз за цикл (±32.7)" },
    chestCounter: { type: "number", default: 0.49, min: 0, max: 1, help: "плечи в противофазе: доля от рыскания таза (16.1 / 32.7)" },
    headYaw: { type: "number", default: 6, min: 0, max: 15, unit: "°", help: "остаток рыскания головы после стабилизации (±5.9)" },
    pelvisRoll: { type: "number", default: 10, min: 0, max: 25, unit: "°", help: "крен таза «вразвалку» (±10.0)" },
    chestRoll: { type: "number", default: 14, min: 0, max: 25, unit: "°", help: "крен груди (±14.3)" },
    headRoll: { type: "number", default: 7, min: 0, max: 25, unit: "°", help: "крен головы (±6.9)" },
    rollPhase: { type: "number", default: 80, min: 0, max: 180, unit: "°", help: "фаза крена относительно рыскания (таз 80, грудь 78)" },
    headLag: { type: "number", default: 54, min: 0, max: 120, unit: "°", help: "отставание крена головы по фазе (≈0.07 с)" },
    bob: { type: "number", default: 0.248, min: 0, max: 0.4, help: "подскок таза — доля его высоты (24.8 %; спокойные 14.5–21 %)" },
    armSwing: { type: "number", default: 30, min: 0, max: 60, unit: "°", help: "маятник рук, в противофазе ногам (UpperArm ±30)" },
    legSwing: { type: "number", default: 30, min: 0, max: 60, unit: "°", help: "мах бедра (на глаз — в игре ноги не замерены в углах)" },
    knee: { type: "number", default: 45, min: 0, max: 90, unit: "°", help: "подгиб колена в переносе ноги (на глаз)" },
  },
  evaluate(p, i, n, t, info) {
    const w = (2 * Math.PI * t) / p.period;
    const rad = Math.PI / 180;
    const sw = Math.sin(w);
    // Углы Tools Up! замерены в осях персонажа (мировые для каждой кости). Кости вложены: грудь в тазу, голова в груди,
    // поэтому слой отдаёт разницу «своё − родителя»: тогда в мире грудь крутится на −16°, а голова почти неподвижна.
    const world = {
      pelvis: { roll: p.pelvisYaw * sw, lateral: p.pelvisRoll * Math.sin(w + p.rollPhase * rad) },
      chest: { roll: -p.chestCounter * p.pelvisYaw * sw, lateral: p.chestRoll * Math.sin(w + (p.rollPhase - 2) * rad) },
      head: { roll: p.headYaw * Math.sin(w + Math.PI), lateral: p.headRoll * Math.sin(w + (p.rollPhase + p.headLag) * rad) },
    };
    const rel = (a: { roll: number; lateral: number }, b: { roll: number; lateral: number }) => ({ roll: a.roll - b.roll, lateral: a.lateral - b.lateral });
    switch (p.role) {
      case "pelvis":
        if (i > 0) return {};
        // 2 шага за цикл → подскок вдвое чаще. Низ шага (кадр 3 из 14) ставим на момент, когда нога впереди
        // и принимает вес (sin = ±1). Привязка фазы к ногам — допущение: ноги в Tools Up! в углах не замерены.
        return { ...world.pelvis, move_up: p.bob * (info?.height ?? 0) * bobAt((2 * t) / p.period - 0.5 + 3 / 14) };
      case "chest":
        return i > 0 ? {} : rel(world.chest, world.pelvis);
      case "head":
        return i > 0 ? {} : rel(world.head, world.chest);
      case "arm_l":
      case "arm_r": {
        if (i > 0) return {};
        const s = p.role === "arm_l" ? 1 : -1;
        return { vertical: s * p.armSwing * sw };
      }
      default: {
        // нога: бедро — маятник в противофазе своей руке; колено гнётся, пока нога идёт вперёд (перенос)
        const s = p.role === "leg_l" ? -1 : 1;
        if (i === 0) return { vertical: s * p.legSwing * sw };
        if (i === 1) return { vertical: -p.knee * Math.max(0, s * Math.cos(w)) };
        return {};
      }
    }
  },
};

const blink: RecipeDef = {
  name: "blink",
  help:
    "Моргание масштабом кости глаза (Tools Up!): сплющить по вертикали и чуть расширить, подержать, открыть с перелётом. " +
    "Цикл = interval; моргание в начале цикла.",
  params: {
    interval: { type: "number", default: 1.8, min: 0.5, max: 6, unit: "с", help: "период морганий" },
    close: { type: "number", default: 0.067, min: 0.03, max: 0.15, unit: "с", help: "закрыть (2 кадра)" },
    hold: { type: "number", default: 0.083, min: 0, max: 0.2, unit: "с", help: "держать закрытым" },
    open: { type: "number", default: 0.05, min: 0.03, max: 0.15, unit: "с", help: "открыть" },
    minY: { type: "number", default: 0.3, min: 0, max: 0.6, help: "масштаб по вертикали в закрытом глазу (медиана 0.32)" },
    widenX: { type: "number", default: 1.2, min: 1, max: 1.5, help: "расширение вбок в закрытом глазу (1.21)" },
    overshoot: { type: "number", default: 1.17, min: 1, max: 1.3, help: "перелёт по вертикали при открытии" },
    settle: { type: "number", default: 0.1, min: 0.02, max: 0.4, unit: "с", help: "успокоение после перелёта (на глаз)" },
  },
  evaluate(p, _i, _n, t) {
    const tt = ((t % p.interval) + p.interval) % p.interval;
    const sm = (x: number) => { x = Math.min(1, Math.max(0, x)); return x * x * (3 - 2 * x); };
    const c = p.close, h = c + p.hold, o = h + p.open, e = o + p.settle;
    let y: number, x: number;
    if (tt < c) { const k = sm(tt / c); y = 1 + (p.minY - 1) * k; x = 1 + (p.widenX - 1) * k; }
    else if (tt < h) { y = p.minY; x = p.widenX; }
    else if (tt < o) { const k = sm((tt - h) / p.open); y = p.minY + (p.overshoot - p.minY) * k; x = p.widenX + (1 - p.widenX) * k; }
    else if (tt < e) { y = p.overshoot + (1 - p.overshoot) * sm((tt - o) / p.settle); x = 1; }
    else { y = 1; x = 1; }
    return { scale_up: y, scale_side: x };
  },
};

const jiggle: RecipeDef = {
  name: "jiggle",
  secondary: true,
  help:
    "Вторичная динамика (как DynamicBone): цепочка — маятник с пружиной, её раскачивают ускорения и повороты родителя " +
    "из остальных слоёв. Уши, усы, волосы, хвосты, шапки. Считается симуляцией по запечённому движению, цикл замыкается.",
  params: {
    hz: { type: "number", default: 1.6, min: 0.3, max: 8, unit: "Гц", help: "собственная частота (ухо 1.6, волосы 2.4, желе-голова 4.2)" },
    damping: { type: "number", default: 0.31, min: 0.05, max: 1.5, help: "ζ: 0.2 — болтается долго, 1 — без перелёта" },
    inert: { type: "number", default: 0.5, min: 0, max: 1, help: "доля движения родителя, которую кость «берёт с собой» (меньше раскачки)" },
    gain: { type: "number", default: 1, min: 0, max: 3, help: "усиление раскачки (1 — физически)" },
    length: { type: "number", default: 1, min: 0.2, max: 5, help: "множитель длины маятника: длиннее — сильнее отзыв на повороты, слабее на толчки" },
  },
  evaluate: () => ({}),
};

export const RECIPES: Record<string, RecipeDef> = { wave, curl, "compass-step": compassStep, "waddle-walk": waddleWalk, blink, jiggle };

export function withDefaults(def: RecipeDef, params: Record<string, unknown>): Record<string, any> {
  const out: Record<string, any> = {};
  for (const [k, s] of Object.entries(def.params)) out[k] = params[k] ?? s.default;
  return out;
}
