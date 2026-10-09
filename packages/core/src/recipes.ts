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
  /** рост всего скелета в rest (от нижней кости до верхней) */
  size?: number;
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
  /** Какую стандартную цепочку (rig.ts) берёт каждая роль — для `recipe.rig`: один вызов ставит слои на всё тело.
   * Значение — имя цепочки или функция от стороны («r»/«l», для ударов). Плюс параметры, которые роль требует. */
  roles?: Record<string, { chain: string | ((side: "l" | "r") => string); params?: Record<string, string | number>; optional?: boolean }>;
  /** События рецепта (удар, звук, шлейф, окно ввода) в секундах клипа — уходят в экспорт и в Godot. */
  events?(p: Record<string, any>): ClipEvent[];
  /** Длина разового движения целиком, с — под неё делается клип (у циклов длина — период). */
  length?(p: Record<string, any>): number;
  /** Главные ручки рецепта — 3–5 параметров, которые простой режим редактора показывает ползунками. */
  main?: string[];
}

const wave: RecipeDef = {
  name: "wave",
  main: ["period", "tipAmp", "growth", "bodyDelay"],
  help:
    "Волна по цепочке: синус с задержкой фазы от основания к кончику и амплитудой, растущей к кончику. " +
    "Плавание рыб и скатов (plane=lateral), китов и дельфинов (plane=vertical), щупальца, хвосты, змеи.",
  params: {
    plane: { type: "enum", default: "lateral", options: ["lateral", "vertical"], help: "lateral — вбок (рыбы, скаты), vertical — вверх-вниз (киты, дельфины)" },
    period: { type: "number", default: 1.6, min: 0.2, max: 8, unit: "с", help: "период одного взмаха" },
    tipAmp: { type: "number", default: 12, min: 0, max: 60, unit: "°", help: "амплитуда кончика (последней кости)" },
    growth: { type: "number", default: 1.5, min: 0, max: 3, help: "рост амплитуды к кончику: A_i = tipAmp·((i+1)/n)^growth; 0 — ровно по всей длине (щупальце Witcher), 1 — дельфин, 2 — кит" },
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
  main: ["angle", "period", "pulse"],
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
  main: ["period", "reach", "coreRoll"],
  roles: { leg_left: { chain: "leg_l" }, leg_right: { chain: "leg_r" }, core: { chain: "pelvis", params: { plane: "lateral" } } },
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
  main: ["period", "pelvisRoll", "bob", "armSwing", "legSwing"],
  roles: Object.fromEntries(["pelvis", "chest", "head", "arm_l", "arm_r", "leg_l", "leg_r"].map((r) => [r, { chain: r }])),
  help:
    "Мультяшная ходьба вразвалку (Tools Up!): таз рыщет и подпрыгивает, плечи в противофазе, голова стабилизирована, " +
    "руки маятником, ноги — простой мах с подгибом колена. Один слой на роль. Повороты — в осях тела (yaw, bank, pitch), " +
    "поэтому рецепт одинаков для любого рига; руки в T-позе сначала опусти project.align (rig.detect делает это сам).",
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
    legPhase: { type: "number", default: 0, min: 0, max: 360, unit: "°", help: "сдвиг фазы ног к тазу: у разных пресетов и тел верная разная — подбирает проверка «стопа скользит» (af check --fix)" },
    armLag: { type: "number", default: 0, min: 0, max: 90, unit: "°", help: "руки отстают от шага по фазе — оверлап; нужен, когда мах маленький (колобок), иначе руки «приклеены»" },
    legSwing: { type: "number", default: 30, min: 0, max: 60, unit: "°", help: "мах бедра (Witcher: шаг ±24.7, бег ±31.8; TLJ ±14–17)" },
    knee: { type: "number", default: 45, min: 0, max: 120, unit: "°", help: "подгиб колена в переносе ноги (на глаз)" },
    chestBow: { type: "number", default: 0, min: 0, max: 30, unit: "°", help: "поклон груди на каждом шаге, 2-я гармоника (голем Witcher ±15; Tools Up! 0)" },
  },
  evaluate(p, i, n, t, info) {
    const w = (2 * Math.PI * t) / p.period;
    const rad = Math.PI / 180;
    const sw = Math.sin(w);
    // Углы Tools Up! замерены в осях персонажа (мировые для каждой кости). Кости вложены: грудь в тазу, голова в груди,
    // поэтому слой отдаёт разницу «своё − родителя»: тогда в мире грудь крутится на −16°, а голова почти неподвижна.
    const world = {
      pelvis: { yaw: p.pelvisYaw * sw, bank: p.pelvisRoll * Math.sin(w + p.rollPhase * rad) },
      chest: { yaw: p.chestCounter * p.pelvisYaw * Math.sin(w + p.chestPhase * rad), bank: p.chestRoll * Math.sin(w + (p.rollPhase - 2) * rad) },
      head: { yaw: p.headYaw * Math.sin(w + Math.PI), bank: p.headRoll * Math.sin(w + (p.rollPhase + p.headLag) * rad) },
    };
    const rel = (a: { yaw: number; bank: number }, b: { yaw: number; bank: number }) => ({ yaw: a.yaw - b.yaw, bank: a.bank - b.bank });
    switch (p.role) {
      case "pelvis":
        if (i > 0) return {};
        // 2 шага за цикл → подскок вдвое чаще. Низ шага (кадр 3 из 14) ставим на момент, когда нога впереди
        // и принимает вес (sin = ±1). Привязка фазы к ногам — допущение: ноги в Tools Up! в углах не замерены.
        return { ...world.pelvis, move_up: p.bob * (info?.height ?? 0) * bobAt((2 * t) / p.period - 0.5 + 3 / 14) };
      case "chest":
        // поклон — дважды за цикл, в низ шага (когда нога принимает вес); фаза — допущение
        return i > 0 ? {} : { ...rel(world.chest, world.pelvis), ...(p.chestBow ? { pitch: p.chestBow * Math.cos(2 * w) } : {}) };
      case "head":
        return i > 0 ? {} : rel(world.head, world.chest);
      case "arm_l":
      case "arm_r": {
        if (i > 0) return {};
        const s = p.role === "arm_l" ? 1 : -1;
        return { pitch: -s * p.armSwing * Math.sin(w - (p.armLag ?? 0) * rad) }; // − : свисающая рука вперёд
      }
      default: {
        // нога: бедро — маятник в противофазе своей руке; колено гнётся, пока нога идёт вперёд (перенос)
        const s = p.role === "leg_l" ? -1 : 1;
        const wl = w + (p.legPhase ?? 0) * rad;
        if (i === 0) return { pitch: -s * p.legSwing * Math.sin(wl) };
        if (i === 1) return { pitch: p.knee * Math.max(0, s * Math.cos(wl)) }; // + : голень назад — колено сгибается
        return {};
      }
    }
  },
};

const blink: RecipeDef = {
  name: "blink",
  main: ["interval", "close", "open"],
  roles: { eye_l: { chain: "eye_l" }, eye_r: { chain: "eye_r" } },
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
  main: ["hz", "damping", "gain"],
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

const strikeRoles: RecipeDef["roles"] = { arm: { chain: (s) => `arm_${s}` }, core: { chain: "chest" }, pelvis: { chain: "pelvis" } };
// у charge-release нет параметра side — recipe.rig передаёт его только тем, у кого он есть

const meleeStrike: RecipeDef = {
  name: "melee-strike",
  main: ["firstHit", "strike", "windupAngle", "coreTwist", "crouch"],
  roles: strikeRoles,
  // клип — до закрытия окна ввода, но не короче 0,3 с после его открытия (рука уже вернулась)
  length: (p) => {
    const ev = meleeStrike.events!(p);
    const open = ev.find((e) => e.name === "window_open")?.t ?? 1.3, close = ev.find((e) => e.name === "window_close")?.t ?? 0;
    return +Math.max(open + 0.3, close).toFixed(3);
  },
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
    side: { type: "enum", default: "r", options: ["l", "r"], help: "какой рукой (для бокового маха — в какую сторону)" },
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
        // pitch < 0 — свисающая рука вперёд-вверх; локоть сгибается тоже «вперёд» (−pitch вокруг той же оси)
        const a = armPath(pos, phase, p.windupAngle, p.followAngle);
        const ch = p.plane === "lateral" ? "bank" : "pitch";
        const sgn = p.plane === "lateral" ? (p.side === "l" ? -1 : 1) : -1;
        return i === 0 ? { [ch]: sgn * a.angle } : { pitch: -p.elbow * a.w };
      }
      case "core":
        return { yaw: pos * p.coreTwist * (p.side === "l" ? -1 : 1), pitch: -pos * p.coreLean };
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
  main: ["windup", "hold", "release", "windupAngle"],
  roles: strikeRoles,
  length: (p) => +(p.windup + p.hold + p.release + 0.3).toFixed(3),
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
      return i === 0 ? { pitch: -a.angle } : { pitch: -p.elbow * a.w };
    }
    if (p.role === "core") return { yaw: pos * p.coreTwist };
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


// ── четвероногие: собака Witcher (cr_canine; баргест играет те же клипы) ──────────────────────────────────────────
// Кривые суставов лап за цикл (research: witcher/analysis/s11_quad_curves.py). Угол — в плоскости тела, + — конец кости
// вперёд; j0 — плечо/бедро от вертикали мира, j1…j3 — сустав относительно родителя. Фаза 0 — лапа дальше всего впереди.
// 20 отсчётов на цикл, отклонение от среднего, среднее левой и правой лапы.
const QUAD: Record<string, { fore: number[][]; hind: number[][]; body: Record<string, [number, number][]>; pelvisH: number }> = {
  walk: {
    fore: [[36.8, 34.9, 26.0, 18.9, 12.7, 7.9, 4.0, 0.5, -2.7, -5.5, -8.1, -12.1, -19.1, -25.0, -29.8, -32.2, -24.3, -9.9, 4.7, 22.6], [-18.6, -23.9, -16.5, -12.0, -7.3, -4.2, -2.8, -2.7, -3.7, -5.8, -8.6, -9.3, -6.6, -5.5, -1.2, 16.7, 32.5, 39.1, 32.7, 7.8], [10.1, 5.8, 0.3, 2.3, 4.9, 7.1, 10.2, 13.9, 18.1, 22.5, 26.7, 27.9, 23.9, 19.2, 9.7, -17.8, -52.2, -69.6, -51.7, -12.1], [-28.3, -16.8, -9.8, -9.2, -10.2, -10.9, -11.4, -11.7, -11.6, -11.1, -10.0, -6.4, 1.8, 11.3, 21.2, 33.3, 44.0, 40.3, 14.3, -18.4]],
    hind: [[17.1, 18.3, 18.2, 14.3, 7.8, 0.2, -7.9, -15.6, -21.1, -23.5, -24.2, -23.3, -23.1, -24.5, -13.8, -0.1, 16.7, 28.7, 30.2, 24.6], [25.0, 15.0, 4.7, -0.8, -1.9, -0.0, 4.5, 9.6, 12.1, 10.2, 6.5, 2.0, -0.2, 1.1, -10.8, -23.2, -28.4, -21.8, -10.0, 8.6], [-30.3, -18.6, -7.5, 1.2, 8.0, 12.0, 13.1, 12.2, 10.6, 8.9, 6.3, 2.7, -1.9, -4.6, 4.7, 12.3, 9.0, -3.4, -13.0, -23.2], [29.3, 7.9, -1.9, -1.3, -0.3, 1.4, 3.9, 6.6, 9.0, 10.8, 11.8, 8.9, 3.6, -2.8, -16.0, -26.4, -26.7, -19.9, -7.5, 12.8]],
    // гармоники [амплитуда, пик в долях цикла от выноса левой передней]: 1-я и 2-я
    body: {"spine_pitch": [[0.078, 0.94], [1.087, 0.047]], "spine_yaw": [[3.54, 0.156], [0.103, 0.126]], "neck_pitch": [[0.499, 0.056], [3.008, 0.033]], "neck_yaw": [[2.539, 0.712], [0.549, 0.43]], "pelvis_bob_m": [[0.004, 0.314], [0.007, 0.288]]},
    pelvisH: 0.531,
  },
  run: {
    fore: [[60.5, 42.7, 24.8, 8.5, -4.1, -10.7, -16.1, -22.3, -31.0, -30.6, -26.7, -25.7, -33.6, -31.6, -20.4, -5.2, 9.1, 23.2, 38.1, 51.4], [-39.6, -23.8, -9.3, 2.2, 8.6, 5.3, 1.7, -1.4, -3.4, -14.1, -26.3, -26.0, 0.7, 21.5, 33.6, 37.5, 34.6, 22.3, -0.1, -23.8], [29.5, 28.0, 25.4, 23.0, 22.2, 24.3, 24.3, 22.2, 17.8, 10.3, 4.3, -4.0, -19.0, -32.6, -44.7, -51.3, -49.3, -36.8, -10.4, 16.8], [-50.3, -46.9, -40.9, -33.7, -26.7, -18.9, -9.9, 1.4, 16.6, 34.3, 48.7, 55.7, 51.9, 42.7, 31.5, 19.0, 5.6, -8.7, -27.6, -44.4]],
    hind: [[25.3, 22.1, 17.7, 12.0, 5.1, -5.3, -15.6, -23.2, -25.5, -25.7, -21.2, -14.4, -7.4, -3.4, -1.3, 0.7, 4.3, 12.3, 19.5, 24.4], [23.8, 17.2, 6.6, -4.2, -11.2, -7.8, 0.7, 9.3, 13.2, 14.7, 6.1, -7.7, -22.0, -26.4, -21.8, -12.8, -4.0, 1.3, 8.5, 16.5], [-22.2, -16.1, -7.7, 0.1, 4.5, 1.6, -6.7, -17.5, -28.0, -31.7, -22.9, -6.5, 12.9, 27.3, 35.4, 37.5, 33.3, 18.7, 1.6, -13.5], [11.1, 13.0, 18.3, 22.4, 20.8, 18.1, 14.3, 7.7, -2.9, -11.8, -16.5, -18.6, -20.1, -20.3, -19.5, -17.0, -12.2, -3.8, 5.1, 11.1]],
    // гармоники [амплитуда, пик в долях цикла от выноса левой передней]: 1-я и 2-я
    body: {"spine_pitch": [[11.266, 0.004], [1.248, 0.344]], "spine_yaw": [[2.074, 0.87], [0.503, 0.365]], "neck_pitch": [[8.489, 0.805], [1.223, 0.027]], "neck_yaw": [[1.762, 0.449], [0.649, 0.109]], "pelvis_bob_m": [[0.038, 0.528], [0.004, 0.051]]},
    pelvisH: 0.517,
  },
};

/** Периодическая таблица → значение в доле цикла s (Катмулл-Ром, без излома на стыке цикла). */
function periodic(tab: number[], s: number): number {
  const n = tab.length;
  const f = (((s % 1) + 1) % 1) * n;
  const k = Math.floor(f), u = f - k;
  const p0 = tab[(k - 1 + n) % n], p1 = tab[k], p2 = tab[(k + 1) % n], p3 = tab[(k + 2) % n];
  return 0.5 * (2 * p1 + (p2 - p0) * u + (2 * p0 - 5 * p1 + 4 * p2 - p3) * u * u + (3 * p1 - p0 - 3 * p2 + p3) * u * u * u);
}
const harmAt = (h: [number, number][], s: number) => h.reduce((a, [amp, peak], k) => a + amp * Math.cos(2 * Math.PI * (k + 1) * (s - peak)), 0);

const QUAD_ROLES = { pelvis: "pelvis", spine: "spine", neck: "neck", leg_fl: "arm_l", leg_fr: "arm_r", leg_hl: "leg_l", leg_hr: "leg_r" } as const;

const quadrupedGait: RecipeDef = {
  name: "quadruped-gait",
  main: ["period", "legs", "body", "bob"],
  roles: Object.fromEntries(Object.entries(QUAD_ROLES).map(([role, chain]) => [role, { chain }])),
  help:
    "Походка четвероногого по собаке Witcher: у каждой лапы свои кривые плеча/бедра, локтя/колена, пясти/плюсны и пальцев " +
    "(вынос быстрый, опора ≈70 % цикла), лапы сдвинуты по фазе (шаг — почти диагональные пары, галоп — задние, потом передние). " +
    "Корпус качается носом вверх-вниз и изгибается вбок, шея — своё минус корпус, таз подскакивает. Цепочки — как у rig.detect " +
    "для четвероногих: передние лапы arm_l/arm_r, задние leg_l/leg_r. Хвост не анимирован и в Witcher — повесь на него jiggle.",
  params: {
    role: { type: "enum", default: "leg_fl", options: Object.keys(QUAD_ROLES), help: "какую часть крутит слой: таз, спина, шея или лапа (fl — передняя левая, hr — задняя правая)" },
    gait: { type: "enum", default: "walk", options: ["walk", "run"], help: "набор кривых: walk — шаг собаки (M_walk), run — галоп (M_run)" },
    period: { type: "number", default: 0.933, min: 0.25, max: 3, unit: "с", help: "цикл: каждая лапа шагает один раз (собака: шаг 0.933, галоп 0.5)" },
    offsetFR: { type: "number", default: 0.496, min: 0, max: 1, help: "фаза передней правой от передней левой, доля цикла (шаг 0.496, галоп 0.333, рысь 0.5)" },
    offsetHL: { type: "number", default: 0.463, min: 0, max: 1, help: "фаза задней левой (шаг 0.463, галоп 0.733, рысь 0.5, иноходь 0)" },
    offsetHR: { type: "number", default: 0.892, min: 0, max: 1, help: "фаза задней правой (шаг 0.892, галоп 0.933, рысь 0, иноходь 0.5)" },
    legs: { type: "number", default: 1, min: 0, max: 2, help: "размах суставов лап — доля от собаки" },
    body: { type: "number", default: 1, min: 0, max: 3, help: "качание корпуса и шеи — доля от собаки (шаг: спина ±1.1°, шея ±3°; галоп: корпус ±11°, шея ±8.5°)" },
    bob: { type: "number", default: 1, min: 0, max: 5, help: "подскок таза — доля от собаки (шаг 1.3 % высоты таза, галоп 7.4 %)" },
  },
  evaluate(p, i, n, t, info) {
    const g = QUAD[p.gait] ?? QUAD.walk;
    const s = t / p.period;
    // корпус носом вверх (+): поворачиваем таз — всё тело качается вокруг бёдер
    const nose = p.body * harmAt(g.body.spine_pitch, s);
    const bend = p.body * harmAt(g.body.spine_yaw, s); // + — грудь влево
    switch (p.role) {
      case "pelvis":
        if (i > 0) return {};
        return { pitch: -nose, move_up: p.bob * (info?.height ?? 0) * harmAt(g.body.pelvis_bob_m, s) / g.pelvisH };
      case "spine":
        return { yaw: bend / n };
      case "neck":
        // шея в Witcher замерена в мире: отдаём разницу с корпусом, делим на кости шеи
        return { pitch: -(p.body * harmAt(g.body.neck_pitch, s) - nose) / n, yaw: (p.body * harmAt(g.body.neck_yaw, s) - bend) / n };
      default: {
        const fore = p.role === "leg_fl" || p.role === "leg_fr";
        const off = { leg_fl: 0, leg_fr: p.offsetFR, leg_hl: p.offsetHL, leg_hr: p.offsetHR }[p.role as "leg_fl"];
        // у длинной цепочки (лопатка/таз + 4 кости) первую кость не трогаем: кривые начинаются с плеча/бедра
        const j = i - (n >= 5 ? 1 : 0);
        if (j < 0 || j > 3) return {};
        let a = p.legs * periodic((fore ? g.fore : g.hind)[j], s - off);
        if (j === 0) a -= nose; // плечо и бедро замерены от вертикали мира, а корпус уже качнули
        return { pitch: -a }; // + угла — конец кости вперёд, а pitch + уводит висящую кость назад
      }
    }
  },
};

// ── многоногие: волна шагов по ногам ─────────────────────────────────────────────────────────────────────────────
// Нога — бедро (кость 0), голень (1), лапка (2+). Опора: бедро равномерно уводит стопу назад (поворот вокруг вертикали);
// перенос: бедро возвращает стопу вперёд и поднимает (поворот вокруг поперечной оси ноги), голень складывается.
// Фаза ноги k (0 — передняя пара): −k·lag — задние шагают раньше, волна бежит к голове; правая сторона + side.
const MAX_PAIRS = 24;
function multilegPhase(p: Record<string, any>, side: "l" | "r", k: number, t: number) {
  const u = t / p.period - (-k * p.lag + (side === "r" ? p.side : 0));
  return ((u % 1) + 1) % 1;
}
/** Профиль ноги: protract — вынос вперёд в долях размаха (+1 впереди, −1 сзади), lift — подъём 0…1 (только в переносе). */
function legProfile(ph: number, duty: number): { protract: number; lift: number } {
  if (ph < duty) return { protract: 1 - (2 * ph) / duty, lift: 0 };
  const w = (ph - duty) / (1 - duty);
  return { protract: -Math.cos(Math.PI * w), lift: Math.sin(Math.PI * w) };
}
const multilegGait: RecipeDef = {
  name: "multileg-gait",
  main: ["period", "swing", "lift", "bob"],
  roles: {
    ...Object.fromEntries([...Array(MAX_PAIRS).keys()].flatMap((k) => (["l", "r"] as const).map((s) => [`leg_${s}${k}`, { chain: `leg_${s}${k}`, optional: true }]))),
    spine: { chain: "spine", optional: true },
    // раскоряка на четырёх ногах (кикимора): rig.detect называет её ноги как у четвероногого
    fore_l: { chain: "arm_l", params: { role: "leg_l0" }, optional: true }, fore_r: { chain: "arm_r", params: { role: "leg_r0" }, optional: true },
    hind_l: { chain: "leg_l", params: { role: "leg_l1" }, optional: true }, hind_r: { chain: "leg_r", params: { role: "leg_r1" }, optional: true },
    pelvis: { chain: "pelvis", optional: true }, chest: { chain: "chest", optional: true },
  },
  help:
    "Походка многоногого (насекомое, паук, сколопендра): каждая нога — опора (стопа равномерно уходит назад) и перенос " +
    "(вынос вперёд с подъёмом, голень складывается). Ноги сдвинуты по фазе: lag — сдвиг между соседними парами (волна от хвоста " +
    "к голове), side — между левой и правой. У шести ног lag 0.5 и side 0.5 дают трипод. Цепочки — из rig.detect: leg_l0, leg_r0 " +
    "(передняя пара), leg_l1… и spine (волна тела, у сколопендры).",
  params: {
    role: { type: "enum", default: "leg_l0", options: [...[...Array(MAX_PAIRS).keys()].flatMap((k) => [`leg_l${k}`, `leg_r${k}`]), "spine", "pelvis", "chest"], help: "нога (leg_l0 — передняя левая), spine, pelvis или chest" },
    period: { type: "number", default: 0.6, min: 0.1, max: 4, unit: "с", help: "цикл одной ноги" },
    duty: { type: "number", default: 0.5, min: 0.2, max: 0.9, help: "доля опоры в цикле (трипод 0.5, медленная волна 0.6–0.8)" },
    lag: { type: "number", default: 0.5, min: -1, max: 1, help: "сдвиг фазы между соседними парами, доля цикла (трипод 0.5; волна сколопендры 0.1–0.2)" },
    side: { type: "number", default: 0.5, min: 0, max: 1, help: "сдвиг правой стороны от левой (0.5 — в противофазе)" },
    swing: { type: "number", default: 20, min: 0, max: 60, unit: "°", help: "размах бедра вперёд-назад (±)" },
    lift: { type: "number", default: 20, min: 0, max: 60, unit: "°", help: "подъём бедра в переносе" },
    fold: { type: "number", default: 15, min: 0, max: 60, unit: "°", help: "складывание голени в переносе" },
    bodyWave: { type: "number", default: 0, min: 0, max: 30, unit: "°", help: "волна тела вбок на кость spine (сколопендра)" },
    waveLag: { type: "number", default: 0.1, min: -1, max: 1, help: "сдвиг фазы волны тела на кость" },
    pelvisYaw: { type: "number", default: 0, min: 0, max: 30, unit: "°", help: "рыскание таза раз за цикл (кикимора ±9.8)" },
    chestRoll: { type: "number", default: 0, min: 0, max: 30, unit: "°", help: "крен груди раз за цикл (кикимора ±17.3)" },
    bob: { type: "number", default: 0, min: 0, max: 0.2, help: "подскок таза дважды за цикл — доля высоты (кикимора 0.066 / 1.86 = 3.5 %)" },
  },
  evaluate(p, i, n, t, info) {
    const cyc = 2 * Math.PI * (t / p.period);
    if (p.role === "pelvis") return i > 0 ? {} : { yaw: p.pelvisYaw * Math.cos(cyc - 2 * Math.PI * 0.07), move_up: p.bob * (info?.height ?? 0) * Math.cos(2 * cyc) };
    if (p.role === "chest") return i > 0 ? {} : { bank: p.chestRoll * Math.cos(cyc - 2 * Math.PI * 0.57), yaw: -0.67 * p.pelvisYaw * Math.cos(cyc - 2 * Math.PI * 0.07) };
    if (p.role === "spine") {
      if (!p.bodyWave) return {};
      return { yaw: p.bodyWave * Math.sin(2 * Math.PI * (t / p.period + i * p.waveLag)) };
    }
    const m = /^leg_([lr])(\d+)$/.exec(p.role);
    if (!m) return {};
    const s = m[1] as "l" | "r", k = +m[2];
    const { protract, lift } = legProfile(multilegPhase(p, s, k, t), p.duty);
    const sgn = s === "l" ? 1 : -1;
    // вокруг вертикали: + уводит левую ногу назад, правую — вперёд; вокруг поперечной оси ноги (vertical цепочки) + поднимает
    if (i === 0) return { yaw: -sgn * p.swing * protract, vertical: p.lift * lift };
    if (i === 1) return { vertical: -p.fold * lift };
    return {};
  },
};

// ── крылья: машущий полёт ─────────────────────────────────────────────────────────────────────────────────────────
/** Профиль взмаха: +1 — крыло вверху (u = 0), −1 — внизу (u = down). Вниз — рабочий ход (дольше), вверх — возврат. */
function flapProfile(u: number, down: number): number {
  u = ((u % 1) + 1) % 1;
  return u < down ? Math.cos((Math.PI * u) / down) : -Math.cos((Math.PI * (u - down)) / (1 - down));
}
const wingFlap: RecipeDef = {
  name: "wing-flap",
  main: ["period", "amp", "down", "fold"],
  roles: {
    wing_l: { chain: "wing_l" }, wing_r: { chain: "wing_r" }, body: { chain: "pelvis", optional: true },
    tail: { chain: "tail", optional: true }, leg_l: { chain: "leg_l", optional: true }, leg_r: { chain: "leg_r", optional: true },
  },
  help:
    "Машущий полёт: крыло ходит вверх-вниз вокруг поперечной оси (вниз — рабочий ход, дольше подъёма), на подъёме складывается " +
    "в локте и запястье, кончик отстаёт по фазе; корпус подскакивает на рабочем ходе, хвост отвечает, ноги поджаты. " +
    "Цепочки wing_l/wing_r — из rig.detect (размах больше 1.6 роста).",
  params: {
    role: { type: "enum", default: "wing_l", options: ["wing_l", "wing_r", "body", "tail", "leg_l", "leg_r"], help: "крыло, корпус (таз), хвост или нога" },
    period: { type: "number", default: 0.35, min: 0.05, max: 6, unit: "с", help: "один взмах (птица 0.2–0.5, ласт черепахи ~4)" },
    amp: { type: "number", default: 45, min: 0, max: 90, unit: "°", help: "размах: от середины до верха и до низа" },
    mean: { type: "number", default: 5, min: -45, max: 45, unit: "°", help: "середина взмаха: + — крылья выше горизонта" },
    down: { type: "number", default: 0.55, min: 0.3, max: 0.8, help: "доля цикла на рабочий ход вниз" },
    lag: { type: "number", default: 0.08, min: 0, max: 0.3, help: "отставание фазы на кость к кончику, доля цикла" },
    fold: { type: "number", default: 25, min: 0, max: 90, unit: "°", help: "складывание локтя на подъёме (кисть — встречно, вполовину)" },
    bob: { type: "number", default: 0.04, min: 0, max: 0.3, help: "подскок корпуса за взмах — доля высоты таза" },
    tailPitch: { type: "number", default: 6, min: 0, max: 30, unit: "°", help: "ответ хвоста за взмах" },
    tuck: { type: "number", default: 50, min: 0, max: 120, unit: "°", help: "ноги поджаты назад в полёте" },
  },
  evaluate(p, i, n, t, info) {
    const u = t / p.period;
    switch (p.role) {
      case "body": {
        if (i > 0) return {};
        // корпус поднимается на рабочем ходе: ниже всего — в начале взмаха вниз, выше — к его концу
        return { move_up: p.bob * (info?.height ?? 0) * -flapProfile(u - 0.1, p.down) * 0.5 };
      }
      case "tail":
        return { pitch: (p.tailPitch / n) * flapProfile(u - 0.2, p.down) };
      case "leg_l":
      case "leg_r":
        return i === 0 ? { pitch: p.tuck } : i === 1 ? { pitch: -p.tuck * 0.8 } : {};
      default: {
        const s = p.role === "wing_l" ? 1 : -1;
        const f = flapProfile(u - i * p.lag, p.down);
        // складывание — на подъёме (вторая часть цикла), плавный горб
        const uu = (((u - i * p.lag) % 1) + 1) % 1;
        const up = uu < p.down ? 0 : Math.sin((Math.PI * (uu - p.down)) / (1 - p.down));
        // vertical цепочки крыла: + поднимает и левое, и правое; вокруг вертикали + уводит левую кисть назад
        if (i === 0) return { vertical: p.mean + p.amp * f };
        if (i === 1) return { vertical: 0.3 * p.amp * (f - flapProfile(u, p.down)), yaw: s * p.fold * up };
        return { yaw: -s * 0.5 * p.fold * up };
      }
    }
  },
};

// ── парение (призрак Witcher, cr_wraith) ─────────────────────────────────────────────────────────────────────────
const hover: RecipeDef = {
  name: "hover",
  main: ["period", "bob", "lean", "roll"],
  roles: { pelvis: { chain: "pelvis" }, chest: { chain: "chest", optional: true }, head: { chain: "head", optional: true } },
  help:
    "Парение без ног (призрак Witcher): таз поднимается и опускается почти чистым синусом, корпус кивает и кренится, грудь рыщет, " +
    "в движении наклон вперёд. Скорость перемещения задаёт игра — клип на месте. Руки и полы одежды — jiggle.",
  params: {
    role: { type: "enum", default: "pelvis", options: ["pelvis", "chest", "head"], help: "таз (подъём, тангаж, крен, наклон), грудь (рыскание) или голова (озирается)" },
    period: { type: "number", default: 1.467, min: 0.3, max: 8, unit: "с", help: "цикл (Witcher: движение 1.47, idle 3.07, боевая стойка 3.9)" },
    bob: { type: "number", default: 0.119, min: 0, max: 0.4, help: "подъём таза — доля его высоты (Witcher: движение ±0.196 м при 1.65 м = 11.9 %, idle 8.4 %, стойка 3.6 %)" },
    lean: { type: "number", default: 15, min: -30, max: 45, unit: "°", help: "постоянный наклон вперёд (в движении 15, на месте −6…−9)" },
    pitch: { type: "number", default: 5.4, min: 0, max: 20, unit: "°", help: "кивок таза (назад ходом ±10.4)" },
    roll: { type: "number", default: 4.1, min: 0, max: 20, unit: "°", help: "крен таза" },
    chestYaw: { type: "number", default: 7.3, min: 0, max: 30, unit: "°", help: "рыскание груди" },
    look: { type: "number", default: 0, min: 0, max: 40, unit: "°", help: "голова озирается (боевая стойка: ±24 + 2-я гармоника ±29)" },
    chestPitch: { type: "number", default: 0, min: 0, max: 60, unit: "°", help: "кивок груди (ифрит: нарастает от таза к голове 8 → 37 → 48°)" },
    headPitch: { type: "number", default: 0, min: 0, max: 60, unit: "°", help: "кивок головы (ифрит ±48)" },
  },
  evaluate(p, i, n, t, info) {
    if (i > 0) return {};
    const s = t / p.period, c = (peak: number, k = 1) => Math.cos(2 * Math.PI * k * (s - peak));
    // пики гармоник — из M_walk: подъём 0.75, тангаж 0.93, крен 0.18, рыскание груди 0.78 (доли цикла)
    if (p.role === "pelvis") return { move_up: p.bob * (info?.height ?? 0) * c(0.75), pitch: p.lean + p.pitch * c(0.93), bank: p.roll * c(0.18) };
    // кивки груди и головы — в мире (ифрит: пики 0.82 и 0.67); слой отдаёт разницу с родителем
    if (p.role === "chest") return { yaw: p.chestYaw * c(0.78), ...(p.chestPitch ? { pitch: p.chestPitch * c(0.82) - p.pitch * c(0.93) } : {}) };
    return { ...(p.look ? { yaw: p.look * c(0.3) + 1.2 * p.look * c(0.1, 2) } : {}), ...(p.headPitch ? { pitch: p.headPitch * c(0.67) - (p.chestPitch ? p.chestPitch * c(0.82) : p.pitch * c(0.93)) } : {}) };
  },
};

// ── удар щупальцем или стеблем (cr_tenta, cr_echin, cr_zeugl) ─────────────────────────────────────────────────────
/** Профиль удара в момент t (без задержки по костям): замах −windup, удар +1, удержание, возврат по экспоненте. */
function strikeCurve(p: Record<string, any>, t: number): number {
  const t1 = p.windupT, t2 = t1 + p.strikeT, t3 = t2 + p.hold, t4 = t3 + p.returnT;
  if (t <= 0) return 0;
  if (t < t1) return -p.windup * smooth(t / t1);
  if (t < t2) { const u = (t - t1) / p.strikeT; return -p.windup + (1 + p.windup) * u * u * (3 - 2 * u); }
  if (t < t3) return 1;
  if (t < t4) return 1 - smooth((t - t3) / p.returnT); // эхинопс S3: 6.6 → 0 плавно, без отскока
  return 0;
}
const tentacleStrike: RecipeDef = {
  name: "tentacle-strike",
  main: ["amp", "windupT", "strikeT", "returnT"],
  length: (p) => +(p.windupT + p.strikeT + p.hold + p.returnT + 0.3).toFixed(3),
  help:
    "Удар щупальцем, стеблем или хвостом (Witcher: щупальце, эхинопс, зейгл): замах назад, удар за доли секунды, удержание, " +
    "медленный возврат. delay — задержка удара на кость: 0 — вся цепочка бьёт разом (щупальце Witcher), 0.057 с — настоящий хлыст " +
    "(эхинопс). Изгиб растёт к концу цепочки. Событие hit — в момент удара конца.",
  params: {
    plane: { type: "enum", default: "vertical", options: ["vertical", "lateral"], help: "vertical — сверху вниз, lateral — вбок" },
    amp: { type: "number", default: 12, min: -60, max: 60, unit: "°", help: "изгиб на кость в момент удара (середина цепочки)" },
    windup: { type: "number", default: 0.8, min: 0, max: 2, help: "замах — доля от удара в обратную сторону (S3 щупальца: −7.3 м против +6.2 м)" },
    growth: { type: "number", default: 1, min: 0, max: 3, help: "рост изгиба к концу: A_i = amp·(0.4 + 0.6·((i+1)/n)^growth)" },
    windupT: { type: "number", default: 0.25, min: 0.02, max: 2, unit: "с", help: "время замаха (0.2–0.25)" },
    strikeT: { type: "number", default: 0.1, min: 0.02, max: 1, unit: "с", help: "время удара (0.1)" },
    hold: { type: "number", default: 0.2, min: 0, max: 2, unit: "с", help: "удержание после удара (0.1–0.3)" },
    returnT: { type: "number", default: 0.6, min: 0.05, max: 3, unit: "с", help: "возврат (0.4–0.8)" },
    delay: { type: "number", default: 0, min: 0, max: 0.2, unit: "с", help: "задержка на кость (0 — разом, 0.057 — хлыст эхинопса)" },
  },
  evaluate(p, i, n, t) {
    const a = p.amp * (0.4 + 0.6 * Math.pow((i + 1) / n, p.growth));
    return { [p.plane as SemanticAxis]: a * strikeCurve(p, t - i * p.delay) };
  },
  events(p) {
    // удар основания; при delay > 0 конец бьёт позже на delay·(n − 1) — число костей рецепту здесь неизвестно
    return [{ t: +(p.windupT + p.strikeT).toFixed(4), name: "hit" }];
  },
};

// ── появление и уход (из воды, из земли) ──────────────────────────────────────────────────────────────────────────
/** 0 → 1 (появление) или 1 → 0 (уход) с предварительным ходом и перелётом; доля пути от времени u ∈ [0, 1]. */
function emergeCurve(p: Record<string, any>, u: number): number {
  u = Math.min(1, Math.max(0, u));
  const pre = p.anticipation > 0 ? p.preT : 0;
  if (p.mode === "submerge") {
    // замах вверх (призрак +30 %, утопец +35 %), потом уход с ускорением
    if (u < pre) return 1 + p.anticipation * Math.sin((Math.PI / 2) * (u / pre));
    const v = (u - pre) / (1 - pre);
    return (1 + p.anticipation) * (1 - Math.pow(v, p.easeIn));
  }
  if (u < pre) return -p.anticipation * Math.sin(Math.PI * (u / pre));
  const v = (u - pre) / (1 - pre);
  // быстрый подъём до 1 + overshoot к доле rise, затем оседание
  if (v < p.rise) { const w = v / p.rise; return (1 + p.overshoot) * (1 - Math.pow(1 - w, 3)); }
  const w = (v - p.rise) / (1 - p.rise);
  return 1 + p.overshoot * (1 - smooth(w));
}
const emerge: RecipeDef = {
  name: "emerge",
  main: ["duration", "rise", "overshoot", "anticipation"],
  help:
    "Появление из воды или земли и уход (Witcher): корень цепочки поднимается из глубины depth. Щупальце и стебель выбрасываются " +
    "почти линейно, Дагон перелетает на 15 % и оседает, зейгл сначала приседает; уход — с ускорением, у призрака и утопца перед ним " +
    "замах вверх на 30–35 %. Ставь на первую кость тела (таз, основание щупальца).",
  params: {
    mode: { type: "enum", default: "emerge", options: ["emerge", "submerge"], help: "появление или уход" },
    depth: { type: "number", default: 1, min: 0, max: 5, help: "глубина — доля роста существа (1 — уходит целиком; щупальце 11.6 м при 9.5 м ≈ 1.2)" },
    duration: { type: "number", default: 1, min: 0.1, max: 10, unit: "с", help: "время всего движения" },
    rise: { type: "number", default: 0.35, min: 0.05, max: 1, help: "доля времени на основной подъём (щупальце 0.3 / 0.32 с, зейгл 0.45)" },
    overshoot: { type: "number", default: 0, min: 0, max: 0.5, help: "перелёт (Дагон 0.15, призрак 0.06, утопец 0.02)" },
    anticipation: { type: "number", default: 0, min: 0, max: 0.5, help: "предварительный ход: появление — присед вниз (зейгл 0.035), уход — вверх (призрак 0.3, утопец 0.35)" },
    preT: { type: "number", default: 0.25, min: 0.02, max: 0.8, help: "доля времени на предварительный ход" },
    easeIn: { type: "number", default: 2, min: 1, max: 4, help: "ускорение ухода (2 — квадратичное)" },
  },
  evaluate(p, i, n, t, info) {
    if (i > 0) return {};
    const h = (info?.size ?? info?.height ?? 1) * p.depth;
    return { move_up: -h * (1 - emergeCurve(p, t / p.duration)) };
  },
};

/** Таран корпусом: удар у персонажа, которому нельзя махать руками (руки слеплены с телом — колобок-пекарь).
 * Позы корня по времени: замах назад с задержкой → бросок вперёд с задержкой на контакте → откат за нейтраль →
 * оседание. Собрано в пять кругов с критиком на пекаре (critic/CRITIC.md): антиципация видна заранее (NPC),
 * на контакте — без крена вбок (иначе в фас «ком на камеру»), корень приподнят (иначе ноги в полу), возврат долгий. */
const RAM_KEYS = (p: Record<string, any>) => {
  // e — откат за нейтраль, g — затухающий отскок обратно, f — стойка: без него тело «выщёлкивается» в нейтраль (критик)
  const a = p.windupT, b = a + p.hold, c = b + p.strikeT, d = c + p.contact, e = d + p.recover, g = e + p.settle * 0.45, f = e + p.settle;
  return { t: [0, a, b, c, d, e, g, f], ev: { a, b, c, d, e, f } };
};
const bodyRam: RecipeDef = {
  name: "body-ram",
  main: ["windupT", "back", "forward", "contact", "recover"],
  // голова — своим слоем: держится на линии удара и чуть отстаёт (критик: «голова с колпаком опережает корпус, силуэт размыт»)
  roles: { pelvis: { chain: "pelvis", params: { role: "pelvis" } }, head: { chain: "head", params: { role: "head" }, optional: true } },
  help:
    "Таран корпусом (на глаз, по кругам с критиком): удар всем телом от корня — для персонажей, у которых руки не двигаются " +
    "(слеплены с телом). Замах назад с задержкой, бросок вперёд с задержкой на контакте, откат за нейтраль, оседание. " +
    "События: effort, whoosh, hit, window_open/close.",
  params: {
    role: { type: "enum", default: "pelvis", options: ["pelvis", "head"], help: "что крутит слой: таз ведёт удар, голова гасит его наклон" },
    headHold: { type: "number", default: 0.4, min: 0, max: 1, help: "голова гасит эту долю наклона корпуса — остаётся на линии удара, а не ныряет вперёд" },
    headLag: { type: "number", default: 0.03, min: 0, max: 0.2, unit: "с", help: "голова догоняет корпус с запаздыванием — масса читается" },
    windupT: { type: "number", default: 0.5, min: 0.1, max: 1.5, unit: "с", help: "замах назад (NPC — длиннее, игрок — короче)" },
    hold: { type: "number", default: 0.2, min: 0, max: 1, unit: "с", help: "задержка в замахе — антиципация" },
    strikeT: { type: "number", default: 0.12, min: 0.04, max: 0.5, unit: "с", help: "бросок до контакта" },
    contact: { type: "number", default: 0.15, min: 0, max: 0.6, unit: "с", help: "задержка на контакте" },
    recover: { type: "number", default: 0.7, min: 0.1, max: 1.5, unit: "с", help: "откат за нейтраль" },
    settle: { type: "number", default: 0.55, min: 0.1, max: 1.5, unit: "с", help: "оседание в стойку" },
    back: { type: "number", default: 24, min: 0, max: 45, unit: "°", help: "отклон назад в замахе" },
    forward: { type: "number", default: 24, min: 0, max: 60, unit: "°", help: "наклон вперёд на контакте (больше замаха — удар читается вперёд)" },
    overshoot: { type: "number", default: 10, min: 0, max: 20, unit: "°", help: "откат назад за нейтраль" },
    bank: { type: "number", default: 8, min: 0, max: 25, unit: "°", help: "крен вбок в замахе (на контакте крена нет)" },
    push: { type: "number", default: 0.09, min: 0, max: 0.3, help: "бросок вперёд — доля высоты таза" },
    lift: { type: "number", default: 0.02, min: 0, max: 0.1, help: "корень приподнят в замахе и на контакте — доля высоты таза (ноги не уходят в пол)" },
    tail: { type: "number", default: 0.3, min: 0, max: 2, unit: "с", help: "окно на следующий ввод после оседания" },
  },
  length: (p) => +(RAM_KEYS(p).ev.f + p.tail).toFixed(3),
  evaluate(p, i, n, t, info) {
    if (i > 0) return {};
    const { t: T } = RAM_KEYS(p);
    const H = info?.height ?? 1;
    const curve = (v: number[], t: number) => {
      if (t <= 0) return v[0];
      for (let k = 1; k < T.length; k++) if (t < T[k]) { const u = (t - T[k - 1]) / (T[k] - T[k - 1]); return v[k - 1] + (v[k] - v[k - 1]) * u * u * (3 - 2 * u); }
      return v[v.length - 1];
    };
    const PITCH = [0, -p.back, -p.back * 1.05, p.forward, p.forward * 0.95, -p.overshoot, p.overshoot * 0.3, 0];
    // голова в мире = (1 − hold) · наклон корпуса с запаздыванием; слой отдаёт разницу с корпусом, который она наследует
    if (p.role === "head") return { pitch: (1 - p.headHold) * curve(PITCH, t - p.headLag) - curve(PITCH, t) };
    return {
      pitch: curve(PITCH, t),
      bank: curve([0, -p.bank, -p.bank * 1.1, 0, 0, p.bank * 0.1, 0, 0], t),
      move_forward: curve([0, -p.push * 0.45, -p.push * 0.5, p.push, p.push, -p.push * 0.15, p.push * 0.04, 0], t) * H,
      move_up: curve([0, p.lift * 0.6, p.lift * 0.6, p.lift, p.lift, 0, 0, 0], t) * H,
    };
  },
  events(p) {
    const { a, b, c, d, f } = RAM_KEYS(p).ev;
    return [{ t: a * 0.5, name: "effort" }, { t: b + (c - b) * 0.3, name: "whoosh" }, { t: c, name: "hit" }, { t: d, name: "trail_off" }, { t: f, name: "window_open" }, { t: f + p.tail, name: "window_close" }];
  },
};

export const RECIPES: Record<string, RecipeDef> = { wave, curl, "compass-step": compassStep, "waddle-walk": waddleWalk, blink, jiggle, "melee-strike": meleeStrike, "charge-release": chargeRelease, "quadruped-gait": quadrupedGait, "multileg-gait": multilegGait, "wing-flap": wingFlap, hover, "tentacle-strike": tentacleStrike, emerge, "body-ram": bodyRam };

export { QUAD, emergeCurve, strikeCurve, flapProfile, legProfile, multilegPhase, periodic, strikePlan, strikePos, swingEase };

export function withDefaults(def: RecipeDef, params: Record<string, unknown>): Record<string, any> {
  const out: Record<string, any> = {};
  for (const [k, s] of Object.entries(def.params)) out[k] = params[k] ?? s.default;
  return out;
}
