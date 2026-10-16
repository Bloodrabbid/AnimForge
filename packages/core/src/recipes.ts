// Реестр рецептов. Рецепт по параметрам и цепочке костей выдаёт углы по семантическим осям в момент t.
// Параметры описаны схемой — по ней интерфейс рисует ползунки, а агент знает, что можно менять.
import type { Channel, SemanticAxis } from "./project.ts";
import { rand01 } from "./math.ts";

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
    sections: { type: "number", default: 1, min: 1, max: 3, help: "секции цепочки (хвост пришельца Breathedge — 3: звенья 0–2 / 3–9 / 10–14 из 15): внутри секции изгиб синхронный, у секций своя фаза и размах" },
    sectionPhase: { type: "number", default: 120, min: -360, max: 360, unit: "°", help: "запаздывание пульсации от секции к секции, к кончику (на глаз 90–180)" },
    midAmp: { type: "number", default: 1, min: 0, max: 3, help: "размах средней секции к корневой (хвост пришельца: 12–14° против 20–22° — 0.6)" },
    tipAmp: { type: "number", default: 1, min: 0, max: 3, help: "размах концевой секции к корневой (16–18° — 0.8)" },
  },
  evaluate(p, i, n, t) {
    // веса костей ∝ ((i+1)/n)^growth, нормированы так, что сумма углов = angle
    let sum = 0;
    for (let j = 0; j < n; j++) sum += Math.pow((j + 1) / n, p.growth);
    const share = Math.pow((i + 1) / n, p.growth) / sum;
    // секция кости: три — границы 0.2 и 0.667 длины (как 3 / 10 из 15 звеньев), две — пополам
    const S = Math.round(p.sections ?? 1);
    const sec = S >= 3 ? (i < Math.round(0.2 * n) ? 0 : i < Math.round(0.667 * n) ? 1 : 2) : S === 2 ? (i < Math.round(0.5 * n) ? 0 : 2) : 0;
    const amp = sec === 0 ? 1 : sec === 1 ? (p.midAmp ?? 1) : (p.tipAmp ?? 1);
    const k = 1 + p.pulse * Math.sin(2 * Math.PI * (t / p.period) + ((p.phase - (S >= 3 ? sec : sec / 2) * (p.sectionPhase ?? 0)) * Math.PI) / 180);
    return { [p.plane as SemanticAxis]: p.angle * share * k * amp };
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
    period: { type: "number", default: 0.479, min: 0.3, max: 3, unit: "с", help: "цикл из двух шагов (Tools Up!: 0.479, с ношей 0.5–0.6; TLJ: ходьба 1.3–1.37, бег 0.73; крадущийся смертный Ghost Master — 2.43)" },
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
    legPhase: { type: "number", default: 0, min: 0, max: 360, unit: "°", help: "сдвиг фазы ног к тазу: у пресетов библиотеки — свой, 150–270° (подобран проверкой «стопа скользит» на рабочем и пекаре; 0 даёт «лунную» походку); под другое тело подбирает af check --fix" },
    armLag: { type: "number", default: 0, min: 0, max: 90, unit: "°", help: "руки отстают от шага по фазе — оверлап; нужен, когда мах маленький (колобок), иначе руки «приклеены»" },
    legSwing: { type: "number", default: 30, min: 0, max: 60, unit: "°", help: "мах бедра (Witcher: шаг ±24.7, бег ±31.8; TLJ ±14–17)" },
    knee: { type: "number", default: 45, min: 0, max: 120, unit: "°", help: "подгиб колена в переносе ноги (на глаз)" },
    chestBow: { type: "number", default: 0, min: 0, max: 30, unit: "°", help: "поклон груди на каждом шаге, 2-я гармоника (голем Witcher ±15; Tools Up! 0)" },
    headNod: { type: "number", default: 0, min: 0, max: 45, unit: "°", help: "кивок головы на каждом шаге, в мире (Haven: Chirulida шаг ±9.7 — птичий кивок, Daikon бег прыжками ±30.8, Nokk 6.1, Sunatcha 6.3)" },
    nodPhase: { type: "number", default: 0, min: -180, max: 180, unit: "°", help: "фаза кивка к поклону груди (на глаз: 0 — голова внизу, когда нога принимает вес)" },
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
      case "head": {
        if (i > 0) return {};
        // кивок в мире; голова сидит на груди, которая уже кланяется chestBow — отдаём разницу
        const nod = p.headNod ? { pitch: p.headNod * Math.cos(2 * w + p.nodPhase * rad) - p.chestBow * Math.cos(2 * w) } : {};
        return { ...rel(world.head, world.chest), ...nod };
      }
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
    period: { type: "number", default: 0.933, min: 0.25, max: 5, unit: "с", help: "цикл: каждая лапа шагает один раз (собака: шаг 0.933, галоп 0.5; Tanoli из Haven — шаг 4 с)" },
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
  // своя фаза ноги (Haven Heliga: не трипод и не волна) — если задана, иначе сдвиг по lag и side
  const own = k < 3 ? p[`ph_${side}${k}`] ?? -1 : -1;
  const u = t / p.period - (own >= 0 ? own : -k * p.lag + (side === "r" ? p.side : 0));
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
    ...Object.fromEntries([0, 1, 2].flatMap((k) => (["l", "r"] as const).map((s) => [`ph_${s}${k}`, { type: "number" as const, default: -1, min: -1, max: 1, help: `своя фаза выноса ноги ${s === "l" ? "левой" : "правой"} пары ${k}, доля цикла (−1 — по lag и side; Haven Heliga: 0, .434, .608, .159, .863, .404)` }]))),
    ...Object.fromEntries([0, 1, 2].map((k) => [`duty${k}`, { type: "number" as const, default: -1, min: -1, max: 0.9, help: `доля опоры пары ${k} (−1 — как duty; у Heliga средние короче всех: 0.42)` }])),
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
    const dk = k < 3 ? p[`duty${k}`] ?? -1 : -1;
    const { protract, lift } = legProfile(multilegPhase(p, s, k, t), dk > 0 ? dk : p.duty);
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
  roles: { pelvis: { chain: "pelvis", params: { role: "pelvis" } }, head: { chain: "head", params: { role: "head" }, optional: true }, jaw: { chain: "jaw", params: { role: "jaw" }, optional: true } },
  help:
    "Таран корпусом (на глаз, по кругам с критиком): удар всем телом от корня — для персонажей, у которых руки не двигаются " +
    "(слеплены с телом). Замах назад с задержкой, бросок вперёд с задержкой на контакте, откат за нейтраль, оседание. " +
    "События: effort, whoosh, hit, window_open/close.",
  params: {
    role: { type: "enum", default: "pelvis", options: ["pelvis", "head", "jaw"], help: "что крутит слой: таз ведёт удар, голова гасит его наклон, челюсть рычит в замахе" },
    jawOpen: { type: "number", default: 0, min: 0, max: 150, unit: "°", help: "пасть в замахе: открыта к концу замаха, к удару закрыта (Haven: Dorago 53 → 2, Bigufurai 82 → 0, Toriko 38 → 2, босс Babulardo 95)" },
    headHold: { type: "number", default: 0.4, min: 0, max: 1, help: "голова гасит эту долю наклона корпуса — остаётся на линии удара, а не ныряет вперёд" },
    headLag: { type: "number", default: 0.03, min: 0, max: 0.2, unit: "с", help: "голова догоняет корпус с запаздыванием — масса читается" },
    windupT: { type: "number", default: 0.5, min: 0.1, max: 5, unit: "с", help: "замах назад (NPC — длиннее, игрок — короче; «телеграф» существ Haven — медиана 1.9 с, до 5)" },
    hold: { type: "number", default: 0.2, min: 0, max: 1, unit: "с", help: "задержка в замахе — антиципация" },
    strikeT: { type: "number", default: 0.12, min: 0.04, max: 1.5, unit: "с", help: "бросок до контакта (существа Haven: 0.07–1.43)" },
    contact: { type: "number", default: 0.15, min: 0, max: 0.6, unit: "с", help: "задержка на контакте" },
    recover: { type: "number", default: 0.7, min: 0.1, max: 3.5, unit: "с", help: "откат за нейтраль (существа Haven: до 3.4)" },
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
    // пасть: раскрывается за замах, пик в конце задержки, к контакту закрыта
    if (p.role === "jaw") return p.jawOpen ? { pitch: p.jawOpen * curve([0, 0.8, 1, 0, 0, 0, 0, 0], t) } : {};
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

// ── дрожь страха или холода (Ghost Master pe25b, pe28b/d, kid_pe25b, sheep_fri) ─────────────────────────────────
/** Частота дрожи, округлённая до целого числа колебаний за период — запечённый цикл замыкается без рывка. */
const trembleHz = (p: Record<string, any>) => Math.max(1, Math.round(p.hz * p.period)) / p.period;
const tremble: RecipeDef = {
  name: "tremble",
  main: ["hz", "headAmp", "chestAmp", "irregular"],
  roles: { chest: { chain: "chest", params: { role: "chest" } }, head: { chain: "head", params: { role: "head" }, optional: true }, tail: { chain: "tail", params: { role: "tail" }, optional: true } },
  help:
    "Дрожь страха или холода (Ghost Master): почти синус 7.5–7.8 Гц у взрослых, 3 Гц у детей, 5 Гц у овцы. " +
    "Голова ±4.6–5°, грудь ±3.1–3.3°, хвост овцы ±31°. Слой поверх стойки или испуга; ось и неровность — на глаз.",
  params: {
    role: { type: "enum", default: "chest", options: ["chest", "head", "tail"], help: "что дрожит: грудь, голова или хвост" },
    hz: { type: "number", default: 7.6, min: 0.5, max: 15, unit: "Гц", help: "частота (взрослые 7.5–7.8, дети 3, овца 5); округляется до целого числа колебаний за период" },
    period: { type: "number", default: 2, min: 0.5, max: 10, unit: "с", help: "длина цикла клипа — за неё же один раз нарастает и спадает неровность" },
    chestAmp: { type: "number", default: 3.2, min: 0, max: 20, unit: "°", help: "амплитуда груди (взрослые 3.1–3.3)" },
    headAmp: { type: "number", default: 4.8, min: 0, max: 30, unit: "°", help: "амплитуда головы (взрослые 4.6–5, ≈ 1.5 груди)" },
    tailAmp: { type: "number", default: 0, min: 0, max: 60, unit: "°", help: "амплитуда хвоста (овца ±31)" },
    plane: { type: "enum", default: "pitch", options: ["pitch", "bank", "yaw"], help: "ось дрожи (на глаз: кивок; хвост — рыскание)" },
    irregular: { type: "number", default: 0.15, min: 0, max: 0.5, help: "неровность: доля амплитуды, которая плавает за период (чистота синуса в Ghost Master 0.83–1.0)" },
    lag: { type: "number", default: 0, min: 0, max: 180, unit: "°", help: "голова и хвост запаздывают от груди по фазе (на глаз)" },
  },
  evaluate(p, i, n, t) {
    const amp = p.role === "head" ? p.headAmp : p.role === "tail" ? p.tailAmp : p.chestAmp;
    const lag = p.role === "chest" ? 0 : p.lag * (Math.PI / 180);
    const env = 1 + p.irregular * Math.sin(2 * Math.PI * (t / p.period));
    const v = (amp / Math.max(1, n)) * env * Math.sin(2 * Math.PI * trembleHz(p) * t - lag);
    return { [p.role === "tail" && p.plane === "pitch" ? "yaw" : p.plane]: v };
  },
};

// ── реакция существа: удар, уклон, «заметил», смерть (Haven, 22–24 вида) ───────────────────────────────────────
/** Доля отклонения в момент t: замах против хода (если windup > 0), рывок к пику с пиком скорости в peakVelT,
 * успокоение без перелёта до доли keep к settleT (keep = 1 — остаётся, как смерть). */
function reactCurve(p: Record<string, any>, t: number): number {
  const w0 = p.windup > 0 ? p.windupT : 0;
  if (t <= 0) return 0;
  if (t < w0) return -p.windup * smooth(t / w0);
  if (t < p.peakT) {
    const a = Math.min(0.95, Math.max(0.02, (p.peakVelT - w0) / (p.peakT - w0)));
    return -p.windup + (1 + p.windup) * swingEase((t - w0) / (p.peakT - w0), a);
  }
  if (t < p.settleT) return 1 + (p.keep - 1) * smooth((t - p.peakT) / (p.settleT - p.peakT));
  return p.keep;
}
const REACT_DIR: Record<string, [number, number]> = { back: [-1, 0], forward: [1, 0], left: [0, -1], right: [0, 1] };
const hitReact: RecipeDef = {
  name: "hit-react",
  main: ["pitch", "push", "peakT", "settleT"],
  roles: { pelvis: { chain: "pelvis", params: { role: "pelvis" } }, head: { chain: "head", params: { role: "head" }, optional: true }, jaw: { chain: "jaw", params: { role: "jaw" }, optional: true } },
  help:
    "Реакция существа (Haven, 22–24 вида): удар, тяжёлый удар, уклон, «заметил», смерть. Рывок без замаха — пик скорости " +
    "в первые 0.05 с, пик отклонения к 0.27 с, мягкое успокоение без перелёта к 0.78 с. Смерть — медленно, пик скорости к 0.7 с " +
    "и остаётся (keep = 1). Ноги на полу держит clip.ground. Времена измерены, амплитуды — на глаз в измеренных пределах.",
  params: {
    role: { type: "enum", default: "pelvis", options: ["pelvis", "head", "jaw"], help: "таз ведёт реакцию, голова добавляет свой кивок с запаздыванием, пасть распахивается" },
    jawOpen: { type: "number", default: 0, min: 0, max: 150, unit: "°", help: "пасть в реакции (Haven HitLight: 16–62°; смерть 24–56 — остаётся открытой)" },
    jawT: { type: "number", default: 0.1, min: 0.01, max: 1, unit: "с", help: "пасть раскрыта к (Haven 0.03–0.21)" },
    dir: { type: "enum", default: "back", options: ["back", "forward", "left", "right"], help: "куда отбрасывает тело (удар спереди — назад)" },
    duration: { type: "number", default: 1, min: 0.3, max: 5, unit: "с", help: "длина клипа (Haven: удар 1.0, тяжёлый 2.0, уклон 1.13, «заметил» 0.667, смерть 1.67)" },
    peakVelT: { type: "number", default: 0.05, min: 0.01, max: 2, unit: "с", help: "пик скорости (удар и уклон 0.05–0.06 — рывок, смерть 0.7)" },
    peakT: { type: "number", default: 0.27, min: 0.05, max: 4, unit: "с", help: "пик отклонения (удар 0.27, тяжёлый 0.62, уклон 0.33, смерть 1.57)" },
    settleT: { type: "number", default: 0.78, min: 0.1, max: 5, unit: "с", help: "успокоение к (удар 0.78, тяжёлый 1.41, уклон 0.94)" },
    keep: { type: "number", default: 0, min: 0, max: 1, help: "доля отклонения, которая остаётся к концу (смерть — 1, «заметил» — настороженная поза)" },
    windup: { type: "number", default: 0, min: 0, max: 0.7, help: "замах против хода — доля главного (медиана 0; присед крупных Babulardo, Chirulida, Heliga 0.36–0.43)" },
    windupT: { type: "number", default: 0.1, min: 0.02, max: 1, unit: "с", help: "длина замаха (на глаз)" },
    pitch: { type: "number", default: 25, min: 0, max: 90, unit: "°", help: "наклон таза в сторону отлёта (Haven ±13…58°)" },
    push: { type: "number", default: 0.3, min: 0, max: 2, help: "отлёт таза — доля его высоты (голова Haven уходит на 0.4–1.5 h, у мелких до 3–4)" },
    drop: { type: "number", default: 0, min: -0.5, max: 1.2, help: "оседание таза — доля высоты (смерть ~1 h у головы; минус — подскок)" },
    headPitch: { type: "number", default: 10, min: -60, max: 60, unit: "°", help: "голова добавляет кивок в сторону отлёта (на глаз)" },
    headLag: { type: "number", default: 0.04, min: 0, max: 0.3, unit: "с", help: "голова отстаёт от таза (Haven: таз к 0.1–0.3 с, голова к 0.27)" },
  },
  length: (p) => p.duration,
  evaluate(p, i, n, t, info) {
    if (i > 0) return {};
    const [f, s] = REACT_DIR[p.dir as string] ?? REACT_DIR.back;
    if (p.role === "head") { const c = p.headPitch * reactCurve(p, t - p.headLag); return f ? { pitch: f * c } : { bank: s * c }; }
    // пасть: распахнута к jawT, к успокоению закрыта (у смерти — остаётся по keep)
    if (p.role === "jaw") return p.jawOpen ? { pitch: p.jawOpen * keyCurve([0, p.jawT, Math.max(p.jawT + 0.01, p.settleT)], [0, 1, p.keep], t) } : {};
    const c = reactCurve(p, t), H = info?.height ?? 1;
    return {
      ...(f ? { pitch: f * p.pitch * c } : { bank: s * p.pitch * c }),
      ...(f ? { move_forward: f * p.push * H * c } : { move_side: s * p.push * H * c }),
      ...(p.drop ? { move_up: -p.drop * H * c } : {}),
    };
  },
  events(p) {
    // смерть: «thud» — тело легло (пик отклонения), успокоения нет
    const impact = { t: p.windup > 0 ? p.windupT : 0, name: "impact" };
    return p.keep >= 1 ? [impact, { t: p.peakT, name: "thud" }] : [impact, { t: p.peakT, name: "peak" }, { t: p.settleT, name: "recovered" }];
  },
};

// ── случайные взгляды в стойке (Haven, FinalIK LookAt героев — из кода) ───────────────────────────────────────
/** Вес перехода взгляда: 0 → 1, наклон 1 в начале и 0 в конце (lookAtTransitionCurve). */
const glanceEase = (u: number) => { u = Math.min(1, Math.max(0, u)); return u + u * u - u * u * u; };
type GlanceSeg = { a: number; b: number; from: [number, number]; to: [number, number] };
/** Расписание взглядов на петле: отрезки «из позы в позу» [рыскание, вниз]. Всё помещается в период — шва нет. */
function glancePlan(p: Record<string, any>): { starts: number[]; segs: GlanceSeg[] } {
  const r = (k: number, j: number) => rand01(p.seed, k, j, 7);
  const lerp = (a: number, b: number, u: number) => a + (b - a) * u;
  const target = (k: number, j: number, side: number): [number, number] => [
    Math.max(-p.limitYaw, Math.min(p.limitYaw, side * lerp(p.yawMin, p.yawMax, r(k, j)))),
    Math.min(p.limitDown, lerp(p.downMin, p.downMax, r(k, j + 1))),
  ];
  const T = p.transition, starts: number[] = [], segs: GlanceSeg[] = [];
  let cur = 0;
  for (let k = 0; k < 64; k++) {
    const s0 = cur + lerp(p.intervalMin, p.intervalMax, r(k, 0)) * (k === 0 ? 0.5 : 1);
    const side = r(k, 1) < 0.5 ? -1 : 1;
    const g1 = target(k, 2, side), h1 = lerp(p.holdMin, p.holdMax, r(k, 4));
    const two = r(k, 5) < p.double;
    const g2 = two ? target(k, 6, r(k, 8) < p.opposite ? -side : side) : g1, h2 = two ? lerp(p.holdMin, p.holdMax, r(k, 9)) : 0;
    const end = s0 + T + h1 + (two ? T + h2 : 0) + T;
    if (end > p.period - 1e-6) break;
    starts.push(s0);
    let t = s0;
    const push = (d: number, from: [number, number], to: [number, number]) => { segs.push({ a: t, b: t + d, from, to }); t += d; };
    push(T, [0, 0], g1); push(h1, g1, g1);
    if (two) { push(T, g1, g2); push(h2, g2, g2); }
    push(T, g2, [0, 0]);
    cur = end;
  }
  return { starts, segs };
}
const idleGlance: RecipeDef = {
  name: "idle-glance",
  main: ["intervalMin", "intervalMax", "yawMax", "seed"],
  roles: { head: { chain: "head" } },
  help:
    "Случайные взгляды в стойке (Haven, LookAt героев — из кода): раз в 8–15 с голова уходит на 30–70° вбок и 0–30° вниз, " +
    "держит 0.2–1.5 с, с вероятностью 0.6 переводит взгляд во вторую точку; переход 0.7 с, мягко к концу. " +
    "Расписание задаёт seed — одинаково в редакторе и в Godot; все взгляды помещаются в петлю.",
  params: {
    period: { type: "number", default: 40, min: 5, max: 120, unit: "с", help: "длина петли — в неё раскладываются взгляды" },
    seed: { type: "number", default: 1, min: 0, max: 9999, help: "зерно расписания: другое число — другие взгляды" },
    intervalMin: { type: "number", default: 8, min: 0.5, max: 60, unit: "с", help: "пауза между взглядами, от (вдвоём 8, в одиночку 7)" },
    intervalMax: { type: "number", default: 15, min: 0.5, max: 60, unit: "с", help: "пауза, до (вдвоём 15, в одиночку 12)" },
    yawMin: { type: "number", default: 30, min: 0, max: 90, unit: "°", help: "поворот вбок, от (вдвоём 30, в одиночку 45)" },
    yawMax: { type: "number", default: 70, min: 0, max: 90, unit: "°", help: "поворот вбок, до (70)" },
    downMin: { type: "number", default: 0, min: -30, max: 45, unit: "°", help: "вниз, от" },
    downMax: { type: "number", default: 30, min: -30, max: 45, unit: "°", help: "вниз, до (вдвоём 30, в одиночку 10)" },
    holdMin: { type: "number", default: 0.2, min: 0, max: 5, unit: "с", help: "удержание, от" },
    holdMax: { type: "number", default: 1.5, min: 0, max: 5, unit: "с", help: "удержание, до (вдвоём 1.5, в одиночку 0.5)" },
    double: { type: "number", default: 0.6, min: 0, max: 1, help: "вероятность двойного взгляда — перевести во вторую точку (вдвоём 0.6, в одиночку всегда)" },
    opposite: { type: "number", default: 0.5, min: 0, max: 1, help: "вероятность, что вторая точка — в другую сторону (в одиночку — всегда)" },
    transition: { type: "number", default: 0.7, min: 0.1, max: 3, unit: "с", help: "переход взгляда (Haven 0.7)" },
    limitYaw: { type: "number", default: 85, min: 0, max: 120, unit: "°", help: "предел вбок (±85)" },
    limitDown: { type: "number", default: 20, min: -30, max: 60, unit: "°", help: "предел по вертикали (±20 — режет «вниз до 30»)" },
  },
  evaluate(p, i, n, t) {
    const tt = ((t % p.period) + p.period) % p.period;
    for (const g of glancePlan(p).segs) {
      if (tt < g.a || tt >= g.b) continue;
      const u = g.b > g.a ? glanceEase((tt - g.a) / (g.b - g.a)) : 1;
      const k = 1 / Math.max(1, n);
      return { yaw: (g.from[0] + (g.to[0] - g.from[0]) * u) * k, pitch: (g.from[1] + (g.to[1] - g.from[1]) * u) * k };
    }
    return {};
  },
  events: (p) => glancePlan(p).starts.map((t) => ({ t: +t.toFixed(4), name: "glance" })),
};

// ── испуг смертного (Ghost Master: re1, maa_boo, dbltake, re18, re7) ───────────────────────────────────────────
/** Ключевые позы по ролям: времена (с) — измерены, позы рук, ног и наклоны — на глаз по раскадровкам; сдвиги — доли
 * высоты таза (H Ghost Master — рост головы 1.62 м, таз ≈ 0.59 H, так что 0.06 H ≈ 0.10 таза). Копия — в af_recipes.gd. */
const STARTLE: Record<string, any> = {"flinch": {"t": [0, 0.1, 0.27, 0.53, 1.13], "ev": [[0.13, "surprise"]], "pelvis": {"move_up": [0, -0.05, -0.1, -0.1, 0], "move_forward": [0, -0.02, -0.05, -0.05, 0], "pitch": [0, 2, 6, 6, 0]}, "chest": {"pitch": [0, 4, 10, 10, 0]}, "head": {"pitch": [0, 4, 8, 8, 0]}, "arm0": {"pitch": [0, -10, -35, -35, 0]}, "arm1": {"pitch": [0, -20, -60, -60, 0]}, "leg0": {"pitch": [0, -5, -12, -12, 0]}, "leg1": {"pitch": [0, 8, 20, 20, 0]}}, "jump": {"t": [0, 0.39, 0.55, 0.63, 0.79, 1.0, 1.25, 2.0], "ev": [[0.39, "surprise"], [1.0, "land"]], "pelvis": {"move_up": [0, -0.14, 0.1, 0.16, 0.14, -0.1, -0.05, 0], "pitch": [0, 10, -4, -6, -5, 8, 3, 0]}, "chest": {"pitch": [0, 12, -8, -12, -10, 10, 4, 0]}, "head": {"pitch": [0, 14, -12, -20, -16, 8, 3, 0]}, "arm0": {"pitch": [0, 25, -120, -165, -160, -50, -20, 0]}, "arm1": {"pitch": [0, -30, -10, 0, 0, -40, -15, 0]}, "leg0": {"pitch": [0, -30, 5, 8, 6, -25, -10, 0]}, "leg1": {"pitch": [0, 55, 0, 0, 0, 45, 20, 0]}}, "doubletake": {"t": [0, 0.3, 0.55, 0.85, 1.28, 1.43, 1.75, 2.17], "ev": [[0.55, "surprise"], [1.75, "land"]], "pelvis": {"move_up": [0, 0, 0, -0.14, 0.08, 0.12, -0.08, -0.08], "pitch": [0, 0, 0, 10, -4, -6, 8, 8]}, "chest": {"pitch": [0, 0, 0, 12, -8, -10, 10, 10], "yaw": [0, 10, 0, 0, 0, 0, 0, 0]}, "head": {"pitch": [0, 0, 0, 8, -10, -14, 4, 4], "yaw": [0, 25, 0, 0, 0, 0, 0, 0]}, "arm0": {"pitch": [0, 0, 0, 15, -110, -140, -60, -60]}, "arm1": {"pitch": [0, 0, 0, -20, -10, 0, -30, -30]}, "leg0": {"pitch": [0, 0, 0, -28, 4, 6, -18, -18]}, "leg1": {"pitch": [0, 0, 0, 50, 0, 0, 35, 35]}}, "cower": {"t": [0, 0.25, 0.7, 0.9], "ev": [], "pelvis": {"move_up": [0, -0.15, -0.5, -0.475], "pitch": [0, 5, 12, 11]}, "chest": {"pitch": [0, 5, 15, 14]}, "head": {"pitch": [0, 5, 18, 17]}, "arm0": {"pitch": [0, -60, -165, -160]}, "arm1": {"pitch": [0, -40, -100, -95]}, "leg0": {"pitch": [0, -25, -70, -67]}, "leg1": {"pitch": [0, 45, 120, 115]}}, "faint": {"t": [0, 0.33, 0.65, 0.93, 1.08, 1.25, 1.67], "ev": [[1.08, "thud"]], "pelvis": {"pitch": [0, -5, -35, -82, -76, -80, -80], "move_up": [0, -0.18, -0.53, -1, -0.965, -1, -1], "move_forward": [0, -0.05, -0.35, -0.78, -0.78, -0.78, -0.78]}, "chest": {"pitch": [0, -4, -8, -13, -4, -8, -8]}, "head": {"pitch": [0, -12, -18, -2, 8, 4, 4]}, "arm0": {"pitch": [0, -20, -50, -30, -10, -20, -20]}, "arm1": {"pitch": [0, -20, -40, -20, -10, -15, -15]}, "leg0": {"pitch": [0, -20, -30, -10, -25, -5, -5]}, "leg1": {"pitch": [0, 40, 45, 15, 25, 10, 10]}}};
/** Поза к позе: в каждом ключе скорость ноль (smoothstep), как кривая body-ram. */
function keyCurve(T: number[], v: number[], t: number): number {
  if (t <= 0) return v[0];
  for (let k = 1; k < T.length; k++) if (t < T[k]) { const u = (t - T[k - 1]) / (T[k] - T[k - 1]); return v[k - 1] + (v[k] - v[k - 1]) * u * u * (3 - 2 * u); }
  return v[v.length - 1];
}
const startle: RecipeDef = {
  name: "startle",
  main: ["amount", "speed", "lie"],
  roles: Object.fromEntries(["pelvis", "chest", "head", "arm_l", "arm_r", "leg_l", "leg_r"].map((r) => [r, { chain: r, params: { role: r }, optional: r !== "pelvis" }])),
  help:
    "Испуг смертного (Ghost Master): flinch — вздрог, пик 0.27 с и полный возврат; jump — «выпрыгнуть из кожи»: присед 0.39 с, " +
    "вытяжка с руками над головой к 0.63 с, приземление; doubletake — обернулся, присел, подскок, настороженная поза; " +
    "cower — сжаться, руки на голову, к 0.7 с и остаться; faint — обморок: оседание, заваливание назад, падение плашмя с отскоком. " +
    "Времена и ход таза измерены, позы конечностей — на глаз. Ноги на полу — clip.ground (кроме обморока).",
  params: {
    kind: { type: "enum", default: "flinch", options: ["flinch", "jump", "doubletake", "cower", "faint"], help: "что за испуг" },
    role: { type: "enum", default: "pelvis", options: ["pelvis", "chest", "head", "arm_l", "arm_r", "leg_l", "leg_r"], help: "какую часть тела крутит слой (у рук и ног — две кости)" },
    amount: { type: "number", default: 1, min: 0, max: 2, help: "сила: множитель всех углов и сдвигов" },
    speed: { type: "number", default: 1, min: 0.3, max: 3, help: "темп: 1 — как в игре; 0.63 — «отпрянуть» re2 (пик 0.43 с вместо 0.27)" },
    lie: { type: "number", default: 0.15, min: 0, max: 0.8, help: "обморок: таз лёжа — доля его высоты стоя (тонкий человек 0.15, толстяк — больше; подбирает проверка «в пол»)" },
  },
  length: (p) => +(STARTLE[p.kind].t[STARTLE[p.kind].t.length - 1] / p.speed).toFixed(3),
  evaluate(p, i, n, t, info) {
    const K = STARTLE[p.kind];
    const limb = /^(arm|leg)_/.test(p.role);
    if (limb ? i > 1 : i > 0) return {};
    const ch: Record<string, number[]> | undefined = K[limb ? `${p.role.slice(0, 3)}${i}` : p.role];
    if (!ch) return {};
    const out: Partial<Record<Channel, number>> = {};
    const H = info?.height ?? 1;
    // у обморока подъём таза — доля полного опускания, глубина — lie
    const drop = (c: string) => (p.kind === "faint" && p.role === "pelvis" && c === "move_up" ? 1 - p.lie : 1);
    for (const [c, v] of Object.entries(ch)) out[c as Channel] = keyCurve(K.t, v, t * p.speed) * p.amount * drop(c) * (c.startsWith("move_") ? H : 1);
    return out;
  },
  events: (p) => STARTLE[p.kind].ev.map(([t, name]: [number, string]) => ({ t: +(t / p.speed).toFixed(4), name })),
};

// ── пугалка призрака (Ghost Master, 28 клипов *_man) ───────────────────────────────────────────────────────────
/** Ключи пугалки: замах (если есть), выход в позу к rise, оседание к keep, удержание до конца — без возврата. */
const SCARE_KEYS = (p: Record<string, any>) => {
  const pre = p.anticipation > 0 ? p.preT : 0, a = pre + p.rise, b = a + p.settle;
  return [0, pre, a, b, Math.max(p.duration, b + 0.01)];
};
const scarePose: RecipeDef = {
  name: "scare-pose",
  main: ["rise", "keep", "overshoot", "arms"],
  roles: Object.fromEntries(["pelvis", "chest", "head", "arm_l", "arm_r"].map((r) => [r, { chain: r, params: { role: r }, optional: r !== "pelvis" }])),
  help:
    "Пугалка призрака (Ghost Master, manifest): выход в страшную позу и долгое удержание без возврата — конец 0.73 от пика. " +
    "Подъём 0.17–1.0 с (медиана 0.97), грудь в пике проходит в 2.7–3.5 раза дальше, чем останавливается; замах есть у двух третей " +
    "и почти равен главному ходу (у корпуса; руки идут сразу в позу). Событие manifest (частицы) — в пике. Времена и доли измерены, позы рук — на глаз.",
  params: {
    role: { type: "enum", default: "pelvis", options: ["pelvis", "chest", "head", "arm_l", "arm_r"], help: "какую часть тела крутит слой" },
    duration: { type: "number", default: 2, min: 0.5, max: 8, unit: "с", help: "длина клипа (удержание — 50–80 % клипа)" },
    rise: { type: "number", default: 0.97, min: 0.05, max: 3, unit: "с", help: "выход в позу (медиана 0.97, boo_man 0.17)" },
    settle: { type: "number", default: 0.3, min: 0.05, max: 2, unit: "с", help: "оседание из пика в удержание (на глаз)" },
    keep: { type: "number", default: 0.73, min: 0, max: 1, help: "доля пика, что держится до конца (медиана 0.73; 1 — замер в пике)" },
    anticipation: { type: "number", default: 0, min: 0, max: 1.2, help: "замах против хода — доля главного (у трети нет, у остальных 0.9+)" },
    preT: { type: "number", default: 0.3, min: 0.05, max: 1.5, unit: "с", help: "длина замаха (на глаз)" },
    overshoot: { type: "number", default: 2.7, min: 1, max: 4, help: "перелёт груди: в пике во столько раз дальше конечной позы (2.68–3.46)" },
    lift: { type: "number", default: 0.1, min: -0.5, max: 1.5, help: "подъём таза — доля его высоты (взлёт в силах до +1.1…1.4 H)" },
    lean: { type: "number", default: 15, min: -45, max: 60, unit: "°", help: "наклон корпуса к жертве" },
    chest: { type: "number", default: 8, min: -40, max: 40, unit: "°", help: "наклон груди в удержании (в пике — × overshoot)" },
    head: { type: "number", default: -15, min: -60, max: 60, unit: "°", help: "голова: минус — подбородок вверх, нависает" },
    arms: { type: "number", default: -100, min: -180, max: 60, unit: "°", help: "руки: −100 — когти вперёд (boo_man), −170 — вверх, «на дыбы» (harr_man)" },
    elbow: { type: "number", default: -35, min: -150, max: 30, unit: "°", help: "сгиб локтя (на глаз)" },
  },
  length: (p) => +SCARE_KEYS(p)[4].toFixed(3),
  evaluate(p, i, n, t, info) {
    const T = SCARE_KEYS(p), ant = p.anticipation;
    const main = keyCurve(T, [0, -ant, 1, p.keep, p.keep], t);
    const H = info?.height ?? 1;
    switch (p.role) {
      case "pelvis": return i > 0 ? {} : { pitch: p.lean * main, move_up: p.lift * H * main };
      case "chest": return i > 0 ? {} : { pitch: p.chest * keyCurve(T, [0, -ant * p.overshoot, p.overshoot, 1, 1], t) };
      case "head": return i > 0 ? {} : { pitch: p.head * main };
      default: {
        // руки замаха не делают — корпус замахивается, руки сразу идут в позу (иначе мах на полкруга назад)
        const arm = keyCurve(T, [0, 0, 1, p.keep, p.keep], t);
        return i === 0 ? { pitch: p.arms * arm } : i === 1 ? { pitch: p.elbow * arm } : {};
      }
    }
  },
  events: (p) => [{ t: +SCARE_KEYS(p)[2].toFixed(4), name: "manifest" }],
};

// ── висение в невесомости (Breathedge A_Idle_Fly, 4.03 с) ─────────────────────────────────────────────────────
/** curve20 из разбора (° от среднего, 20 отсчётов на цикл): левая нога, предплечье правой (гребок) и левой (отмашка). */
const ZERO_G: Record<string, number[]> = {"thigh": [-1.1, -3.9, -6.6, -9.1, -10.9, -11.8, -11.4, -10.0, -7.7, -4.6, -0.9, 3.1, 7.2, 11.0, 13.8, 14.7, 12.8, 9.0, 5.0, 1.4], "calf": [8.8, 13.3, 17.3, 20.3, 22.3, 22.9, 21.6, 18.1, 12.9, 6.3, -1.3, -9.6, -17.9, -25.4, -30.9, -32.5, -27.0, -16.8, -5.9, 3.4], "foot": [4.0, -0.5, -6.8, -13.3, -18.2, -20.1, -19.0, -16.4, -12.5, -7.7, -2.3, 3.4, 9.0, 14.0, 17.7, 19.2, 17.7, 14.4, 10.6, 6.8], "paddle": [-1.6, 1.7, 4.9, 7.8, 10.0, 11.4, 11.7, 10.7, 8.8, 6.1, 2.7, -1.3, -5.5, -9.6, -12.7, -13.5, -12.0, -9.5, -6.7, -3.8], "flick": [-13.9, -11.5, -6.0, -0.4, 3.8, 5.5, 5.7, 5.9, 6.0, 6.0, 5.8, 5.4, 4.8, 4.0, 3.0, 1.8, -0.5, -4.2, -8.5, -12.3]};
const zeroGFloat: RecipeDef = {
  name: "zero-g-float",
  main: ["period", "legs", "arms", "legRatio"],
  roles: Object.fromEntries(["pelvis", "spine", "leg_l", "leg_r", "arm_l", "arm_r"].map((r) => [r, { chain: r, params: { role: r }, optional: r !== "leg_l" && r !== "leg_r" }])),
  help:
    "Висение в скафандре (Breathedge A_Idle_Fly): всё тело на одном цикле 4.03 с. Ноги «педалируют» в противофазе — колено " +
    "сгибается, когда бедро уходит назад, сгиб медленный, разгиб быстрый; вторая нога вдвое слабее и сдвинута на 167°. " +
    "Одна рука гребёт синусом, другая делает отмашку; корпус почти стоит — звенья проворачиваются в противофазе ±1–2°. " +
    "Кривые измерены (curve20), средняя поза «поджатых» ног и знаки осей — на глаз. Событие breath на 0.45 цикла.",
  params: {
    role: { type: "enum", default: "leg_l", options: ["pelvis", "spine", "leg_l", "leg_r", "arm_l", "arm_r"], help: "какую часть тела крутит слой" },
    period: { type: "number", default: 4.03, min: 1, max: 10, unit: "с", help: "цикл (Breathedge 4.03)" },
    legs: { type: "number", default: 1, min: 0, max: 2, help: "размах ног: 1 — как в игре (бедро ±12.4°, голень ±26°, стопа ±19°)" },
    legRatio: { type: "number", default: 0.45, min: 0, max: 1, help: "вторая нога — доля первой (0.45)" },
    legLR: { type: "number", default: 167, min: 0, max: 360, unit: "°", help: "сдвиг второй ноги по фазе (167)" },
    strong: { type: "enum", default: "left", options: ["left", "right"], help: "какая нога педалирует сильнее (в игре левая)" },
    arms: { type: "number", default: 1, min: 0, max: 2, help: "размах рук: гребок плечо ±5.6, предплечье ±12, кисть ±8.8; отмашка ±3.2 / 8.6 / 6.5" },
    body: { type: "number", default: 1, min: 0, max: 3, help: "проворот корпуса: таз ±0.86, spine_01 ±1.76, spine_02 ±1.45" },
    hip: { type: "number", default: -20, min: -90, max: 30, unit: "°", help: "средний подъём бёдер — ноги поджаты (на глаз)" },
    knee: { type: "number", default: 35, min: 0, max: 120, unit: "°", help: "средний сгиб колен (на глаз)" },
    elbow: { type: "number", default: -25, min: -120, max: 0, unit: "°", help: "средний сгиб локтей (на глаз)" },
    lift: { type: "number", default: 0.3, min: 0, max: 2, help: "таз приподнят — доля его высоты: поджатые ноги не уходят в пол предпросмотра (в невесомости пола нет)" },
  },
  evaluate(p, i, n, t, info) {
    const s = t / p.period, cs = (peak: number) => Math.cos(2 * Math.PI * (s - peak));
    switch (p.role) {
      case "pelvis": return i > 0 ? {} : { yaw: p.body * 0.86 * cs(0.5), move_up: p.lift * (info?.height ?? 0) };
      case "spine": return i === 0 ? { yaw: p.body * 1.76 * cs(0) } : i === 1 ? { yaw: p.body * 1.45 * cs(0.5) } : {};
      case "leg_l": case "leg_r": {
        const strong = (p.role === "leg_l") === (p.strong === "left");
        const k = p.legs * (strong ? 1 : p.legRatio), u = strong ? s : s - p.legLR / 360;
        // голень со знаком «−»: в curve20 её минимум приходится на заднее бедро, а колено там сгибается
        if (i === 0) return { pitch: p.hip + k * periodic(ZERO_G.thigh, u) };
        if (i === 1) return { pitch: p.knee - k * periodic(ZERO_G.calf, u) };
        if (i === 2) return { pitch: k * periodic(ZERO_G.foot, u) };
        return {};
      }
      default: {
        // правая гребёт синусом (пики 0.75), левая — отмашка: быстрый ход за 0.15 цикла, потом плато
        const flick = (p.role === "arm_l") === (p.strong === "left");
        const fore = periodic(flick ? ZERO_G.flick : ZERO_G.paddle, s) * p.arms;
        if (flick) return i === 0 ? { pitch: fore * (3.2 / 8.6) } : i === 1 ? { pitch: p.elbow + fore } : i === 2 ? { pitch: fore * (6.5 / 8.6) } : {};
        return i === 0 ? { pitch: p.arms * 5.6 * cs(0.75) } : i === 1 ? { pitch: p.elbow + fore } : i === 2 ? { pitch: p.arms * 8.8 * cs(0.75) } : {};
      }
    }
  },
  events: (p) => [{ t: +(0.45 * p.period).toFixed(4), name: "breath" }],
};

// ── отключение парящего робота (Breathedge A_RobotGuardian_DeathIn/DeathIdle/DeathOut) ─────────────────────────
/** Доля «отключённости» 0…1 и время после входа: in — провал и остаётся, out — назад, full — вход, висит hang с, выход. */
function powerLevel(p: Record<string, any>, t: number): number {
  const up = (a: number, d: number) => keyCurve([a, a + d], [0, 1], t), down = (a: number, d: number) => keyCurve([a, a + d], [1, 0], t);
  if (p.mode === "hang") return 1;
  if (p.mode === "in") return up(0, p.inT);
  if (p.mode === "out") return down(0, p.outT);
  return t < p.inT + p.hang ? up(0, p.inT) : down(p.inT + p.hang, p.outT);
}
const powerDown: RecipeDef = {
  name: "power-down",
  main: ["drop", "tilt", "droop", "hang"],
  roles: { body: { chain: "pelvis", params: { role: "body" } }, arm_l: { chain: "arm_l", params: { role: "limb" }, optional: true }, arm_r: { chain: "arm_r", params: { role: "limb" }, optional: true }, head: { chain: "head", params: { role: "head" }, optional: true } },
  help:
    "Отключение и включение парящего робота (Breathedge, охранник): за 0.27 с корпус проваливается на 0.2 роста и клонится " +
    "на 31.5°, руки обвисают и остаются; висит, чуть покачиваясь (±0.8 см за 2 с); за 0.33 с — обратно. mode: in — отключиться, " +
    "hang — петля выключенного, out — включиться, full — всё подряд. Времена и провал измерены, доли обвисания по костям — на глаз.",
  params: {
    role: { type: "enum", default: "body", options: ["body", "limb", "head"], help: "корпус проваливается и клонится, конечность обвисает, голова никнет" },
    mode: { type: "enum", default: "full", options: ["in", "hang", "out", "full"], help: "отключиться / висеть выключенным (петля) / включиться / всё подряд" },
    inT: { type: "number", default: 0.27, min: 0.05, max: 3, unit: "с", help: "отключение (DeathIn 0.27, подъём 10→90 % — 0.17)" },
    outT: { type: "number", default: 0.33, min: 0.05, max: 3, unit: "с", help: "включение (DeathOut 0.33)" },
    hang: { type: "number", default: 2, min: 0, max: 20, unit: "с", help: "сколько висеть выключенным в full (и длина петли hang)" },
    drop: { type: "number", default: 0.2, min: 0, max: 1, help: "провал корпуса — доля роста (30 см на 1.5 м)" },
    tilt: { type: "number", default: 31.5, min: -90, max: 90, unit: "°", help: "наклон корпуса вперёд" },
    droop: { type: "number", default: 60, min: 0, max: 120, unit: "°", help: "обвисание первой кости конечности (Breathedge 20–110° по костям), дальше по цепочке — вполовину" },
    headDroop: { type: "number", default: 25, min: 0, max: 90, unit: "°", help: "голова никнет (на глаз)" },
    bob: { type: "number", default: 0.0055, min: 0, max: 0.05, help: "покачивание выключенного — доля роста (±0.83 см на 1.5 м)" },
    bobPeriod: { type: "number", default: 2, min: 0.5, max: 8, unit: "с", help: "период покачивания (2.0)" },
  },
  length: (p) => +(p.mode === "in" ? p.inT : p.mode === "out" ? p.outT : p.mode === "hang" ? p.bobPeriod : p.inT + p.hang + p.outT).toFixed(3),
  evaluate(p, i, n, t, info) {
    const v = powerLevel(p, t);
    if (p.role === "limb") return i >= n ? {} : { pitch: p.droop * v * (i === 0 ? 1 : 0.5) };
    if (i > 0) return {};
    if (p.role === "head") return { pitch: p.headDroop * v };
    const size = info?.size ?? info?.height ?? 1;
    return { pitch: p.tilt * v, move_up: size * (-p.drop * v + p.bob * v * Math.sin((2 * Math.PI * t) / p.bobPeriod)) };
  },
  events(p) {
    const ev: ClipEvent[] = [];
    if (p.mode === "in" || p.mode === "full") ev.push({ t: 0, name: "power_off" });
    if (p.mode === "out") ev.push({ t: 0, name: "power_on" });
    if (p.mode === "full") ev.push({ t: +(p.inT + p.hang).toFixed(4), name: "power_on" });
    return ev;
  },
};

// ── птица вертит головой (Breathedge A_ChickenKeeper / A_ChickenSafe1/2, 1.0 с) ──────────────────────────────────
const headLookPeck: RecipeDef = {
  name: "head-look-peck",
  main: ["period", "head", "neck", "tail"],
  roles: { neck: { chain: "neck", params: { role: "neck" } }, head: { chain: "head", params: { role: "head" } }, tail: { chain: "tail", params: { role: "tail" }, optional: true }, wing_l: { chain: "wing_l", params: { role: "wing" }, optional: true }, wing_r: { chain: "wing_r", params: { role: "wing" }, optional: true } },
  help:
    "Птица озирается (курица Breathedge): цикл 1 с, шея из двух звеньев в противофазе (±17.8 / ±22.2°) — S-образно, " +
    "голова ±10.8° (спокойно) … ±30.2° (тревожно), хвостовые перья ±18.7°, крылья подёргиваются дважды за цикл (±5.8°). " +
    "Амплитуды измерены; ось (рыскание) и фазы головы и хвоста к шее — на глаз.",
  params: {
    role: { type: "enum", default: "head", options: ["neck", "head", "tail", "wing"], help: "что крутит слой" },
    period: { type: "number", default: 1, min: 0.2, max: 5, unit: "с", help: "цикл (1.0)" },
    neck: { type: "number", default: 17.8, min: 0, max: 45, unit: "°", help: "первое звено шеи; второе — в противофазе с neck2" },
    neck2: { type: "number", default: 22.2, min: 0, max: 45, unit: "°", help: "второе звено шеи (противофаза)" },
    head: { type: "number", default: 10.8, min: 0, max: 60, unit: "°", help: "голова (Keeper 10.8, Safe1 30.2, Safe2 6.8)" },
    headPhase: { type: "number", default: 0, min: -180, max: 180, unit: "°", help: "фаза головы к первому звену шеи (на глаз)" },
    tail: { type: "number", default: 18.7, min: 0, max: 60, unit: "°", help: "хвост (перья ±18.7)" },
    tailPhase: { type: "number", default: 180, min: -180, max: 180, unit: "°", help: "фаза хвоста — против головы (на глаз)" },
    wing: { type: "number", default: 5.8, min: 0, max: 30, unit: "°", help: "подёргивание крыльев (ключицы ±5.8, A2/A1 0.82 — дважды за цикл)" },
  },
  evaluate(p, i, n, t) {
    const w = (2 * Math.PI * t) / p.period, rad = Math.PI / 180;
    switch (p.role) {
      case "neck": return i === 0 ? { yaw: p.neck * Math.sin(w) } : i === 1 ? { yaw: -p.neck2 * Math.sin(w) } : {};
      case "head": return i > 0 ? {} : { yaw: p.head * Math.sin(w + p.headPhase * rad) };
      case "tail": return { yaw: (p.tail / Math.max(1, n)) * Math.sin(w + p.tailPhase * rad) };
      // первая и вторая гармоники 1 : 0.82, нормированы к размаху ±wing
      default: return i > 0 ? {} : { pitch: (p.wing * (Math.sin(w) + 0.82 * Math.sin(2 * w))) / WING_TWITCH_PEAK };
    }
  },
};
/** Пик |sin w + 0.82·sin 2w| — чтобы подёргивание крыльев было ровно ±wing. */
const WING_TWITCH_PEAK = (() => { let m = 0; for (let k = 0; k < 20000; k++) { const w = (2 * Math.PI * k) / 20000; m = Math.max(m, Math.abs(Math.sin(w) + 0.82 * Math.sin(2 * w))); } return m; })();

// ── тело отстаёт от тяги (Breathedge B_Fly_Movement, 9 клипов) ─────────────────────────────────────────────────
/** Вектор тяги в осях тела: вперёд и вправо, по углу (0 — вперёд, 90 — вправо) и силе 0…1. */
const thrustDir = (p: Record<string, any>) => { const a = (p.angle * Math.PI) / 180; return { f: Math.cos(a) * p.amount, s: Math.sin(a) * p.amount }; };
const thrustTrail: RecipeDef = {
  name: "thrust-trail",
  main: ["angle", "amount", "forwardTilt", "backTilt"],
  roles: { pelvis: { chain: "pelvis", params: { role: "pelvis" } }, leg_l: { chain: "leg_l", params: { role: "leg" }, optional: true }, leg_r: { chain: "leg_r", params: { role: "leg" }, optional: true } },
  help:
    "Тело отстаёт от тяги (Breathedge, полёт в скафандре): по направлению тяги таз ложится — вперёд на 27°, назад откидывается " +
    "на 38°, вбок кренится на 15–30°, на диагоналях ещё и поворачивается на ≈ 44°; ноги уходят против тяги. Верх тела не трогается. " +
    "Статичная поза — кладётся поверх zero-g-float; сглаживание входа 1.0 с делает игра. Углы таза измерены, доля ног — на глаз.",
  params: {
    role: { type: "enum", default: "pelvis", options: ["pelvis", "leg"], help: "таз ложится на тягу, бёдра отстают" },
    angle: { type: "number", default: 0, min: -180, max: 180, unit: "°", help: "куда тяга в осях тела: 0 — вперёд, 90 — вправо, 180 — назад" },
    amount: { type: "number", default: 1, min: 0, max: 1, help: "сила тяги (доля полной)" },
    forwardTilt: { type: "number", default: 26.6, min: 0, max: 60, unit: "°", help: "наклон вперёд при тяге вперёд (F: 26.6)" },
    backTilt: { type: "number", default: 38, min: 0, max: 60, unit: "°", help: "откид назад при тяге назад (B: 38)" },
    sideTilt: { type: "number", default: 22.5, min: 0, max: 45, unit: "°", help: "крен при тяге вбок (L 30, R 15 — среднее)" },
    diagYaw: { type: "number", default: 44, min: 0, max: 90, unit: "°", help: "поворот таза на диагоналях (FL/FR/BL/BR: 39–44)" },
    legTrail: { type: "number", default: 20, min: 0, max: 60, unit: "°", help: "бёдра отстают от тяги сверх наклона таза (стопы уходят на 0.33–0.6 роста — на глаз)" },
  },
  evaluate(p, i) {
    if (i > 0) return {};
    const { f, s } = thrustDir(p);
    if (p.role === "leg") return { pitch: p.legTrail * f, bank: -p.legTrail * s };
    // диагональ: 1 под 45°, 0 по осям
    const m2 = f * f + s * s, diag = m2 > 1e-12 ? (2 * Math.abs(f * s)) / m2 : 0;
    return { pitch: f >= 0 ? p.forwardTilt * f : p.backTilt * f, bank: p.sideTilt * s, yaw: p.diagYaw * diag * Math.sign(f * s) * Math.sqrt(m2) };
  },
};

// ── осмотр предмета в руке (Breathedge A_Explore*, петля 1.67–3.17 с) ────────────────────────────────────────────
const inspectItem: RecipeDef = {
  name: "inspect-item",
  main: ["period", "twist", "forearm", "shoulder"],
  roles: { arm: { chain: (side) => `arm_${side}` } },
  help:
    "Осмотр предмета в руке (Breathedge, инструменты): рука держит предмет перед собой, кисть проворачивает его вокруг оси " +
    "предплечья до 163°, предплечье ходит на 54–61°, плечо на 20°. Петля; слой кладётся поверх стойки (в игре — смешивание 1.0 с). " +
    "Размахи измерены, поза «перед лицом» и фазы — на глаз. Если кисти в цепочке нет, проворот — на последней кости.",
  params: {
    period: { type: "number", default: 2.4, min: 0.5, max: 8, unit: "с", help: "петля (Breathedge 1.67–3.17)" },
    twist: { type: "number", default: 163, min: 0, max: 270, unit: "°", help: "проворот кисти, полный размах (до 163)" },
    forearm: { type: "number", default: 57, min: 0, max: 120, unit: "°", help: "ход предплечья, полный размах (54–61)" },
    shoulder: { type: "number", default: 20, min: 0, max: 60, unit: "°", help: "ход плеча, полный размах (20)" },
    raise: { type: "number", default: -65, min: -120, max: 30, unit: "°", help: "рука поднята вперёд — поза держания (на глаз)" },
    elbow: { type: "number", default: -80, min: -150, max: 0, unit: "°", help: "сгиб локтя — предмет перед лицом (на глаз)" },
  },
  evaluate(p, i, n, t) {
    const w = (2 * Math.PI * t) / p.period, q = Math.PI / 2;
    const out: Partial<Record<Channel, number>> = {};
    if (i === 0) out.pitch = p.raise + (p.shoulder / 2) * Math.sin(w + q);
    if (i === 1) out.pitch = p.elbow + (p.forearm / 2) * Math.sin(w + q);
    if (i === Math.min(2, n - 1)) out.roll = (p.twist / 2) * Math.sin(w);
    return out;
  },
};

// ── руки от первого лица за тангажом камеры (Breathedge AO_Fly, AO_StickTool_Fly) ──────────────────────────────
const fpAimArms: RecipeDef = {
  name: "fp-aim-arms",
  main: ["pitch", "kUp", "kDown"],
  roles: { arm_l: { chain: "arm_l" }, arm_r: { chain: "arm_r" } },
  help:
    "Руки от первого лица следят за камерой (Breathedge aim offset): плечо поворачивается на 0.66 тангажа вверх и 0.53 вниз, " +
    "предплечье и кисть добавляют своё — вниз сильнее; с инструментом в руке работает только плечо (0.5–0.55). Корпус и голова " +
    "не участвуют. Статичная поза по тангажу — позы ±90° для смешивания в движке. Коэффициенты измерены, знаки осей — на глаз.",
  params: {
    pitch: { type: "number", default: 0, min: -90, max: 90, unit: "°", help: "тангаж камеры: + вверх, − вниз" },
    tool: { type: "enum", default: "empty", options: ["empty", "tool"], help: "пустые руки — плечо, предплечье и кисть; с инструментом — только плечо" },
    kUp: { type: "number", default: 0.66, min: 0, max: 1.5, help: "плечо к тангажу вверх (пустые 0.66, инструмент 0.5–0.55)" },
    kDown: { type: "number", default: 0.53, min: 0, max: 1.5, help: "плечо к тангажу вниз (0.53)" },
    foreUp: { type: "number", default: 0.18, min: 0, max: 1, help: "предплечье вверх (14–19° на 90)" },
    foreDown: { type: "number", default: 0.46, min: 0, max: 1, help: "предплечье вниз (33–49° на 90)" },
    handUp: { type: "number", default: 0.3, min: 0, max: 1, help: "кисть вверх (27–28° на 90)" },
    handDown: { type: "number", default: 0.61, min: 0, max: 1, help: "кисть вниз (40–70° на 90)" },
  },
  evaluate(p, i) {
    const up = p.pitch >= 0, k = i === 0 ? (up ? p.kUp : p.kDown) : p.tool === "tool" ? 0 : i === 1 ? (up ? p.foreUp : p.foreDown) : i === 2 ? (up ? p.handUp : p.handDown) : 0;
    // «−» — рука вперёд и вверх (как у waddle-walk)
    return k ? { pitch: -k * p.pitch } : {};
  },
};

// ── действие инструментом (Breathedge §4: бур, ножницы, камера, ремонт, бросок, лом) ─────────────────────────────
/** Ход кисти к дальней точке по ключам клипов: времена дальней точки, удержания и звука измерены, доли хода между — на глаз. */
const TOOL: Record<string, { t: number[]; r: number[]; tremor: number; ev: [number, string][] }> = {"drill": {"t": [0, 0.33, 0.85, 1.0], "r": [0, 1, 1, 0], "tremor": 1, "ev": [[0.083, "use"]]}, "scissors": {"t": [0, 0.13, 0.3, 0.43, 0.7, 0.83], "r": [0, 0.4, 1, 0.45, 0.15, 0], "tremor": 0, "ev": [[0.26, "use"]]}, "camera": {"t": [0, 0.53, 1.13, 1.67], "r": [0, 1, 1, 0], "tremor": 0, "ev": [[0.075, "use"]]}, "repair": {"t": [0, 0.27, 0.67, 0.73, 1.0], "r": [0, 0.6, 1, 0.9, 0], "tremor": 0, "ev": [[0.159, "use"]]}, "throw": {"t": [0, 0.17, 0.4, 1.0], "r": [0, 1, 0.3, 0], "tremor": 0, "ev": [[0.17, "release"]]}, "scrap": {"t": [0, 0.1, 0.23, 0.47, 1.0], "r": [0, -0.4, 1, 0.5, 0], "tremor": 0, "ev": [[0.389, "hit"]]}};
const toolUse: RecipeDef = {
  name: "tool-use",
  main: ["swing", "bend", "speed"],
  roles: { arm: { chain: (side) => `arm_${side}` } },
  help:
    "Действие инструментом (Breathedge): кисть уходит к дальней точке и возвращается туда же, откуда начала. drill — толчок " +
    "к 0.33 с и удержание с дрожью; scissors — «щёлк» к 0.43 с; camera — поднёс, подержал 0.6 с, опустил; repair — ровное ведение; " +
    "throw — бросок за 0.17 с; scrap — замах лома и удар (звук через 0.04–0.07 с после пика). События use / hit / release и " +
    "window_open за 0.04 с до конца. Времена измерены, углы руки — на глаз.",
  params: {
    kind: { type: "enum", default: "drill", options: Object.keys(TOOL), help: "какое действие" },
    swing: { type: "number", default: -60, min: -150, max: 60, unit: "°", help: "плечо в дальней точке (минус — вперёд; на глаз)" },
    bend: { type: "number", default: -50, min: -120, max: 0, unit: "°", help: "сгиб локтя посреди хода (на глаз)" },
    tremor: { type: "number", default: 2, min: 0, max: 10, unit: "°", help: "дрожь в удержании у бура (0.3–0.4 м/с)" },
    tremorHz: { type: "number", default: 12, min: 1, max: 30, unit: "Гц", help: "частота дрожи (на глаз)" },
    speed: { type: "number", default: 1, min: 0.3, max: 3, help: "темп: 1 — как в игре" },
  },
  length: (p) => { const T = TOOL[p.kind].t; return +(T[T.length - 1] / p.speed).toFixed(3); },
  evaluate(p, i, n, t) {
    const K = TOOL[p.kind], u = t * p.speed, r = keyCurve(K.t, K.r, u);
    const T = K.t, shake = K.tremor && u > T[1] && u < T[2] ? K.tremor * p.tremor * Math.sin(2 * Math.PI * p.tremorHz * (u - T[1])) : 0;
    if (i === 0) return { pitch: p.swing * r + shake };
    // локоть гнётся посреди хода и в замахе, прямой в дальней точке и в покое
    if (i === 1) return { pitch: p.bend * (r >= 0 ? 4 * r * (1 - r) : -2 * r) };
    return {};
  },
  events(p) {
    const K = TOOL[p.kind], end = K.t[K.t.length - 1] / p.speed;
    return [...K.ev.map(([t, name]) => ({ t: +(t / p.speed).toFixed(4), name })), { t: +(end - 0.04).toFixed(4), name: "window_open" }];
  },
};

export const RECIPES: Record<string, RecipeDef> = { wave, curl, "compass-step": compassStep, "waddle-walk": waddleWalk, blink, jiggle, "melee-strike": meleeStrike, "charge-release": chargeRelease, "quadruped-gait": quadrupedGait, "multileg-gait": multilegGait, "wing-flap": wingFlap, hover, "tentacle-strike": tentacleStrike, emerge, "body-ram": bodyRam, tremble, "hit-react": hitReact, "idle-glance": idleGlance, startle, "scare-pose": scarePose, "zero-g-float": zeroGFloat, "power-down": powerDown, "head-look-peck": headLookPeck, "thrust-trail": thrustTrail, "inspect-item": inspectItem, "fp-aim-arms": fpAimArms, "tool-use": toolUse };

export { QUAD, STARTLE, TOOL, glancePlan, emergeCurve, strikeCurve, flapProfile, legProfile, multilegPhase, periodic, strikePlan, strikePos, swingEase };

export function withDefaults(def: RecipeDef, params: Record<string, unknown>): Record<string, any> {
  const out: Record<string, any> = {};
  for (const [k, s] of Object.entries(def.params)) out[k] = params[k] ?? s.default;
  return out;
}
