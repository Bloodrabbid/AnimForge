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

export interface ClipEvent {
  t: number;
  name: string;
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
  /** События рецепта (удар, звук, шлейф, окно ввода) в секундах клипа — уходят в экспорт и в Godot. */
  events?(p: Record<string, any>): ClipEvent[];
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
    period: { type: "number", default: 0.479, min: 0.3, max: 2, unit: "с", help: "цикл из двух шагов (Tools Up!: 0.479, с ношей 0.5–0.6; TLJ: ходьба 1.3–1.37, бег 0.73)" },
    pelvisYaw: { type: "number", default: 32, min: 0, max: 45, unit: "°", help: "рыскание таза, один раз за цикл (±32.7)" },
    chestCounter: { type: "number", default: 0.49, min: 0, max: 2, help: "рыскание плеч — доля от таза (Tools Up! 16.1 / 32.7; бег Геральта 1.97)" },
    chestPhase: { type: "number", default: 180, min: -180, max: 360, unit: "°", help: "фаза плеч к тазу: 180 — строго против (Tools Up!), Геральт −132 в шаге и −9 в боевом шаге" },
    headYaw: { type: "number", default: 6, min: 0, max: 15, unit: "°", help: "остаток рыскания головы после стабилизации (±5.9)" },
    pelvisRoll: { type: "number", default: 10, min: 0, max: 25, unit: "°", help: "крен таза «вразвалку» (±10.0)" },
    chestRoll: { type: "number", default: 14, min: 0, max: 25, unit: "°", help: "крен груди (±14.3)" },
    headRoll: { type: "number", default: 7, min: 0, max: 25, unit: "°", help: "крен головы (±6.9)" },
    rollPhase: { type: "number", default: 80, min: 0, max: 180, unit: "°", help: "фаза крена относительно рыскания (таз 80, грудь 78)" },
    headLag: { type: "number", default: 54, min: 0, max: 120, unit: "°", help: "отставание крена головы по фазе (≈0.07 с)" },
    bob: { type: "number", default: 0.248, min: 0, max: 0.4, help: "подскок таза — доля его высоты (24.8 %; спокойные 14.5–21 %)" },
    armSwing: { type: "number", default: 30, min: 0, max: 60, unit: "°", help: "маятник рук, в противофазе ногам (UpperArm ±30)" },
    legSwing: { type: "number", default: 30, min: 0, max: 60, unit: "°", help: "мах бедра (Witcher: шаг ±24.7, бег ±31.8; TLJ ±14–17)" },
    knee: { type: "number", default: 45, min: 0, max: 120, unit: "°", help: "подгиб колена в переносе ноги (на глаз)" },
  },
  evaluate(p, i, n, t, info) {
    const w = (2 * Math.PI * t) / p.period;
    const rad = Math.PI / 180;
    const sw = Math.sin(w);
    // Углы Tools Up! замерены в осях персонажа (мировые для каждой кости). Кости вложены: грудь в тазу, голова в груди,
    // поэтому слой отдаёт разницу «своё − родителя»: тогда в мире грудь крутится на −16°, а голова почти неподвижна.
    const world = {
      pelvis: { roll: p.pelvisYaw * sw, lateral: p.pelvisRoll * Math.sin(w + p.rollPhase * rad) },
      chest: { roll: p.chestCounter * p.pelvisYaw * Math.sin(w + p.chestPhase * rad), lateral: p.chestRoll * Math.sin(w + (p.rollPhase - 2) * rad) },
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
    open: { type: "number", default: 0.05, min: 0.03, max: 0.25, unit: "с", help: "открыть (Tools Up! 0.05; у Геральта медленнее закрытия — 0.167)" },
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

// ── удары ────────────────────────────────────────────────────────────────────────────────────────────────────────
// Взмах — ease с треугольной скоростью: разгон до пика в доле a, затем торможение. Пик скорости — момент контакта
// (в Witcher hit засчитывается через hitLag после пика скорости запястья).
function swingEase(u: number, a: number): number {
  u = Math.min(1, Math.max(0, u));
  return u <= a ? (u * u) / a : 1 - ((1 - u) * (1 - u)) / (1 - a);
}
const smooth = (x: number) => { x = Math.min(1, Math.max(0, x)); return x * x * (3 - 2 * x); };
/** Угол руки по фазе: в замахе — из покоя к up, во взмахе — прямо между up (pos = +1) и follow (pos = −1),
 * в возврате — из крайней точки в покой. На стыках фаз скорость нулевая, поэтому движение гладкое.
 * Доля «к замаху» w ∈ [0, 1] — для сгиба локтя: согнут в замахе, прям в доводке. */
function armPath(pos: number, phase: string, up: number, follow: number): { angle: number; w: number } {
  if (phase === "swing" || phase === "hold") { const w = (pos + 1) / 2; return { angle: follow + (up - follow) * w, w }; }
  if (pos >= 0) return { angle: up * pos, w: pos }; // замах или возврат со стороны замаха
  return { angle: follow * -pos, w: 0 }; // возврат из доводки
}

/** Траектория серии ударов в долях: pos ∈ [−1, 1] (+1 — замах, −1 — доводка), моменты попаданий и окно ввода. */
function strikePlan(p: Record<string, any>) {
  const k = 1 / p.tempo;
  const strike = p.strike * k, follow = p.follow * k, hitLag = p.hitLag * k, recover = p.recover * k, tail = p.tail * k;
  const swing = p.hits > 1 ? p.interval * k : strike + follow; // в серии каждый взмах длится interval
  const a = strike / (strike + follow);
  const firstHit = Math.max(p.firstHit * k, hitLag + a * swing + 0.05);
  const s0 = firstHit - hitLag - a * swing; // начало первого взмаха = конец замаха
  const hits = Array.from({ length: p.hits }, (_, i) => firstHit + i * swing);
  const end = s0 + p.hits * swing; // конец последнего взмаха
  return { s0, swing, a, hits, end, recover, tail, total: end + recover + tail };
}

function strikePos(p: Record<string, any>, t: number): { pos: number; phase: "ready" | "windup" | "swing" | "recover" | "rest"; i: number } {
  const pl = strikePlan(p);
  if (t < 0) return { pos: 0, phase: "ready", i: 0 };
  if (t < pl.s0) return { pos: smooth(t / pl.s0), phase: "windup", i: 0 }; // замах inOut до +1
  if (t < pl.end) {
    const i = Math.floor((t - pl.s0) / pl.swing);
    const from = i % 2 === 0 ? 1 : -1; // взмахи чередуются: замах → доводка → обратно
    return { pos: from - 2 * from * swingEase((t - pl.s0 - i * pl.swing) / pl.swing, pl.a), phase: "swing", i };
  }
  const last = p.hits % 2 === 1 ? -1 : 1;
  if (t < pl.end + pl.recover) return { pos: last * (1 - smooth((t - pl.end) / pl.recover)), phase: "recover", i: p.hits - 1 };
  return { pos: 0, phase: "rest", i: p.hits - 1 };
}

const meleeStrike: RecipeDef = {
  name: "melee-strike",
  help:
    "Удар или серия ударов (Witcher + Tools Up!): замах → взмах с пиком скорости в контакте → доводка → возврат → окно на " +
    "следующий ввод. Один слой на роль: arm — цепочка плечо→локоть (мах vertical, локоть сгибается в крайних точках), " +
    "core — кручение и наклон корпуса за рукой, pelvis — присед на замахе и оседание после удара. События: hit, " +
    "trail_on/off, whoosh, effort, window_open/close.",
  params: {
    role: { type: "enum", default: "arm", options: ["arm", "core", "pelvis"], help: "что двигает слой" },
    start: { type: "number", default: 0, min: 0, max: 10, unit: "с", help: "когда начать (несколько ударов в одном клипе)" },
    hits: { type: "number", default: 1, min: 1, max: 6, help: "ударов в звене серии (Witcher: 2 → 4 → 5 → 4 по уровням)" },
    firstHit: { type: "number", default: 0.685, min: 0.19, max: 2.2, unit: "с", help: "от начала до первого удара — «телеграф» (собаки 0.31, меч 0.57, двуручник 1.01, голем 1.20; Геральт 0.21–0.60)" },
    strike: { type: "number", default: 0.3, min: 0.05, max: 0.6, unit: "с", help: "разгон взмаха до пика скорости (медиана 169 ударов 0.30)" },
    follow: { type: "number", default: 0.3, min: 0.05, max: 0.8, unit: "с", help: "торможение после пика — доводка (медианы стилей 0.25–0.52)" },
    interval: { type: "number", default: 0.47, min: 0.15, max: 0.8, unit: "с", help: "между ударами серии (быстрый стиль 0.29, сильный 0.47)" },
    hitLag: { type: "number", default: 0.053, min: -0.02, max: 0.15, unit: "с", help: "контакт после пика скорости (Witcher 0.053; Tools Up! молоток 0.035)" },
    recover: { type: "number", default: 0.4, min: 0.05, max: 1.5, unit: "с", help: "возврат в стойку (на глаз)" },
    tail: { type: "number", default: 0.9, min: 0, max: 2, unit: "с", help: "окно на следующий ввод после возврата (сталь 0.9, серебро 1.1–1.3)" },
    tempo: { type: "number", default: 1, min: 0.5, max: 2.5, help: "ускорение всего звена — так Witcher делает серию быстрее тем же мокапом (×1.37…1.92)" },
    windupAngle: { type: "number", default: 110, min: 0, max: 170, unit: "°", help: "подъём руки в замахе (на глаз: в играх измерен подъём кисти, не угол)" },
    followAngle: { type: "number", default: 20, min: -120, max: 120, unit: "°", help: "где рука заканчивает взмах: 20 — рубящий удар закончен впереди-внизу, −60 — рука уходит за спину (на глаз)" },
    elbow: { type: "number", default: 60, min: 0, max: 140, unit: "°", help: "сгиб локтя в замахе; к доводке рука выпрямляется (на глаз)" },
    plane: { type: "enum", default: "vertical", options: ["vertical", "lateral"], help: "плоскость маха руки: vertical — рубящий сверху (вперёд-вверх), lateral — вбок" },
    coreTwist: { type: "number", default: 25, min: 0, max: 60, unit: "°", help: "кручение корпуса за рукой (на глаз)" },
    coreLean: { type: "number", default: 10, min: 0, max: 40, unit: "°", help: "наклон корпуса за рукой (на глаз)" },
    crouch: { type: "number", default: 0.1, min: 0, max: 0.4, help: "присед на замахе — доля высоты таза (на глаз)" },
    settle: { type: "number", default: 0.22, min: 0, max: 0.4, help: "оседание после удара — доля высоты таза (Tools Up! молоток −0.10 при тазе 0.46)" },
    trailLead: { type: "number", default: 0.13, min: 0, max: 0.3, unit: "с", help: "шлейф клинка включается до контакта (0.09–0.22)" },
    trailLag: { type: "number", default: 0.05, min: 0, max: 0.15, unit: "с", help: "и гаснет после (0.01–0.12)" },
    whooshLead: { type: "number", default: 0.115, min: 0, max: 0.3, unit: "с", help: "звук взмаха до контакта (n = 337, 0.045–0.29)" },
    effortLead: { type: "number", default: 0.17, min: 0, max: 0.4, unit: "с", help: "выдох/крик усилия до контакта (n = 193)" },
  },
  evaluate(p, i, _n, t, info) {
    if (i > 1 || (p.role !== "arm" && i > 0)) return {};
    const tt = t - p.start;
    const { pos, phase } = strikePos(p, tt);
    switch (p.role) {
      case "arm": {
        const a = armPath(pos, phase, p.windupAngle, p.followAngle);
        return i === 0 ? { [p.plane]: a.angle } : { [p.plane]: -p.elbow * a.w };
      }
      case "core":
        return { roll: pos * p.coreTwist, vertical: -pos * p.coreLean };
      default: {
        const h = info?.height ?? 0;
        const pl = strikePlan(p);
        let dip = 0;
        if (phase === "windup" || phase === "swing") dip -= p.crouch * h * Math.max(0, pos) * (phase === "windup" ? 1 : 1 - swingEase((tt - pl.s0) / pl.swing, pl.a));
        // оседание после последнего удара: опускание за доводку, возврат за recover
        const tl = pl.hits[pl.hits.length - 1];
        const fall = (pl.end - tl) + pl.recover * 0.5;
        if (tt > tl) dip -= p.settle * h * Math.sin(Math.PI * Math.min(1, (tt - tl) / (fall + pl.recover * 0.5)));
        return { move_up: dip };
      }
    }
  },
  events(p) {
    const pl = strikePlan(p);
    const ev: ClipEvent[] = [];
    for (const h of pl.hits) {
      ev.push({ t: h - p.effortLead / p.tempo, name: "effort" }, { t: h - p.whooshLead / p.tempo, name: "whoosh" });
      ev.push({ t: h - p.trailLead / p.tempo, name: "trail_on" }, { t: h, name: "hit" }, { t: h + p.trailLag / p.tempo, name: "trail_off" });
    }
    ev.push({ t: pl.end + pl.recover, name: "window_open" }, { t: pl.total, name: "window_close" });
    return ev.map((e) => ({ ...e, t: +(e.t + p.start).toFixed(4) })).sort((a, b) => a.t - b.t);
  },
};

const chargeRelease: RecipeDef = {
  name: "charge-release",
  help:
    "Силовая атака (Witcher): долгий замах → удержание с пружинящим корнем (петля) → выпуск двумя ударами → возврат. " +
    "Роли как у melee-strike. События: charge_start, charge_full, hit ×2, window_open.",
  params: {
    role: { type: "enum", default: "arm", options: ["arm", "core", "pelvis"], help: "что двигает слой" },
    windup: { type: "number", default: 1.7, min: 0.3, max: 3, unit: "с", help: "замах заряда (1hS_powpre 1.70)" },
    hold: { type: "number", default: 0.8, min: 0, max: 5, unit: "с", help: "удержание; в игре — петля 0.80 с, пока держат кнопку" },
    holdPeriod: { type: "number", default: 0.8, min: 0.2, max: 2, unit: "с", help: "период пружинки в удержании (длина петли)" },
    holdBob: { type: "number", default: 0.058, min: 0, max: 0.15, help: "пружинка корня в удержании — доля высоты таза (5.4 см при 0.93)" },
    release: { type: "number", default: 1.9, min: 0.4, max: 3, unit: "с", help: "выпуск (1hS_pow_1 1.90)" },
    hit1: { type: "number", default: 0.4, min: 0.1, max: 1.5, unit: "с", help: "первый удар от начала выпуска (0.40)" },
    hit2: { type: "number", default: 1.05, min: 0.2, max: 2.5, unit: "с", help: "второй удар (1.05)" },
    windupAngle: { type: "number", default: 140, min: 0, max: 175, unit: "°", help: "замах заряда — шире обычного (на глаз)" },
    followAngle: { type: "number", default: 10, min: -120, max: 120, unit: "°", help: "где рука заканчивает первый взмах (на глаз)" },
    elbow: { type: "number", default: 70, min: 0, max: 140, unit: "°", help: "сгиб локтя в замахе (на глаз)" },
    coreTwist: { type: "number", default: 35, min: 0, max: 60, unit: "°", help: "кручение корпуса (на глаз)" },
    crouch: { type: "number", default: 0.15, min: 0, max: 0.4, help: "присед в заряде — доля высоты таза (на глаз)" },
  },
  evaluate(p, i, _n, t, info) {
    if (i > 1 || (p.role !== "arm" && i > 0)) return {};
    const lag = 0.053; // контакт после пика скорости запястья (Witcher, медиана 245 ударов)
    const A = p.windup, B = A + p.hold, h1 = B + p.hit1 - lag, h2 = B + p.hit2 - lag, E = B + p.release;
    // pos: 0 → +1 замах; держим; к h1 — взмах в −1 (пик скорости в контакте); к h2 — обратно в +0.6; к E — в 0
    let pos: number, phase: string;
    const m1 = h1 + (h2 - h1) / 2, m2 = h2 + (E - h2) / 2;
    if (t < A) { pos = smooth(t / A); phase = "windup"; }
    else if (t < B) { pos = 1; phase = "hold"; }
    else if (t < m1) { pos = 1 - 2 * swingEase((t - B) / (m1 - B), (h1 - B) / (m1 - B)); phase = "swing"; }
    else if (t < m2) { pos = -1 + 1.6 * swingEase((t - m1) / (m2 - m1), (h2 - m1) / (m2 - m1)); phase = "swing"; }
    else { pos = 0.6 * (1 - smooth((t - m2) / (E - m2))); phase = "recover"; }
    if (p.role === "arm") {
      // в возврате рука идёт из точки второго взмаха (0.6 пути к замаху) в покой
      const a = phase === "recover" ? { angle: (p.followAngle + (p.windupAngle - p.followAngle) * 0.8) * (pos / 0.6), w: 0.8 * (pos / 0.6) } : armPath(pos, phase, p.windupAngle, p.followAngle);
      return i === 0 ? { vertical: a.angle } : { vertical: -p.elbow * a.w };
    }
    if (p.role === "core") return { roll: pos * p.coreTwist };
    const hgt = info?.height ?? 0;
    const charge = t < A ? smooth(t / A) : t < B ? 1 : 1 - smooth((t - B) / Math.max(1e-6, p.hit1));
    const bob = t >= A && t < B ? p.holdBob * hgt * 0.5 * (1 - Math.cos((2 * Math.PI * (t - A)) / p.holdPeriod)) : 0;
    return { move_up: -p.crouch * hgt * charge - bob };
  },
  events(p) {
    const B = p.windup + p.hold;
    return [
      { t: 0, name: "charge_start" }, { t: p.windup, name: "charge_full" },
      { t: B + p.hit1, name: "hit" }, { t: B + p.hit2, name: "hit" }, { t: B + p.release, name: "window_open" },
    ].map((e) => ({ ...e, t: +e.t.toFixed(4) }));
  },
};

export const RECIPES: Record<string, RecipeDef> = { wave, curl, "compass-step": compassStep, "waddle-walk": waddleWalk, blink, jiggle, "melee-strike": meleeStrike, "charge-release": chargeRelease };

export { strikePlan, strikePos, swingEase };

export function withDefaults(def: RecipeDef, params: Record<string, unknown>): Record<string, any> {
  const out: Record<string, any> = {};
  for (const [k, s] of Object.entries(def.params)) out[k] = params[k] ?? s.default;
  return out;
}
