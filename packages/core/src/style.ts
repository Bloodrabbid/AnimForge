// Стиль поверх любой походки (clip.style): разница «запись стиля − обычная запись» того же движения (100STYLE: 100
// стилей, снятых на одних и тех же шагах) — слоем поз на свой клип. Разница снимается по фазе шага: у обеих записей
// фаза — от удара пятки левой (левая стопа дальше всего впереди правой), цикл делится на PHASES точек; у своего клипа
// фаза находится так же, и разница кладётся в такт его шагам. Если у клипа шага нет (стойка, удар, поза) — кладётся
// средняя разница: остаётся поза стиля (руки зомби, руки в боки, наклон), без своего ритма.
import { qinv, qmul, qnorm, qscale, vdot, vsub, type Quat, type Vec3 } from "./math.ts";
import type { Clip, PoseKey, PoseLayer, Project } from "./project.ts";
import { bodyFrame, posePartsAt, worldPose, type Rig } from "./evaluate.ts";
import { standardNames } from "./naming.ts";

export const PHASES = 24;

/** 100 стилей 100STYLE: имя в наборе → по-русски (по описаниям Dataset_List.csv). */
export const STYLE100: Record<string, string> = {
  Aeroplane: "самолётик", Akimbo: "руки в боки", Angry: "сердито", ArmsAboveHead: "руки над головой",
  ArmsBehindBack: "руки за спиной", ArmsBySide: "руки по швам", ArmsFolded: "руки скрещены", Balance: "балансируя",
  BeatChest: "бьёт себя в грудь", BentForward: "наклонившись вперёд", BentKnees: "на согнутых коленях",
  BigSteps: "широкими шагами", BouncyLeft: "пружиня на левой", BouncyRight: "пружиня на правой", Cat: "по-кошачьи",
  Chicken: "курицей", CrossOver: "ноги накрест", Crouched: "пригнувшись", CrowdAvoidance: "в толпе, уворачиваясь",
  Depressed: "подавленно", Dinosaur: "динозавром", DragLeftLeg: "волоча левую ногу", DragRightLeg: "волоча правую ногу",
  Drunk: "пьяно", DuckFoot: "носки внутрь", Elated: "ликуя", FairySteps: "пятка к носку", Flapping: "машет крыльями",
  FlickLegs: "вскидывая голени", Followed: "оглядываясь", GracefulArms: "изящно", HandsBetweenLegs: "руки между ног",
  HandsInPockets: "руки в карманах", Heavyset: "качок", HighKnees: "высоко поднимая колени", InTheDark: "в темноте, на ощупь",
  KarateChop: "карате", Kick: "пинок на каждом шаге", LawnMower: "газонокосилка", LeanBack: "откинувшись назад",
  LeanLeft: "наклон влево", LeanRight: "наклон вправо", LeftHop: "прыжки на левой", LegsApart: "ноги врозь",
  LimpLeft: "хромая на левую", LimpRight: "хромая на правую", LookUp: "глядя вверх", Lunge: "выпадами", March: "маршем",
  Monk: "монах", Morris: "народный танец", Neutral: "обычно", Old: "старик", OnHeels: "на пятках",
  OnPhoneLeft: "с телефоном в левой", OnPhoneRight: "с телефоном в правой", OnToesBentForward: "на цыпочках наклонившись",
  OnToesCrouched: "на цыпочках пригнувшись", PendulumHands: "руки маятником", Penguin: "пингвином",
  PigeonToed: "косолапо", Proud: "гордо", Punch: "удар кулаком на каждом шаге", Quail: "семеня", RaisedLeftArm: "левая рука поднята",
  RaisedRightArm: "правая рука поднята", RightHop: "прыжки на правой", Roadrunner: "страусом", Robot: "робот",
  Rocket: "ракетой", Rushed: "второпях", ShieldedLeft: "щит в левой", ShieldedRight: "щит в правой", Skip: "вприпрыжку",
  SlideFeet: "шаркая", SpinAntiClock: "кружась против часовой", SpinClock: "кружась по часовой", Star: "звездой",
  StartStop: "с остановками", Stiff: "скованно", Strutting: "важничая", Superman: "супергерой", Swat: "спецназ с винтовкой",
  Sweep: "подметая", Swimming: "плывя брассом", SwingArmsRound: "крутя руками", SwingShoulders: "раскачивая плечами",
  Teapot: "чайником", Tiptoe: "на цыпочках", TogetherStep: "приставным шагом", TwoFootJump: "прыжки на двух",
  WalkingStickLeft: "с тростью в левой", WalkingStickRight: "с тростью в правой", Waving: "машет рукой",
  WhirlArms: "руки мельницей", WideLegs: "широко расставив ноги", WiggleHips: "виляя бёдрами", WildArms: "размахивая руками",
  WildLegs: "дрыгая ногами", Zombie: "зомби",
};

/** Стопы: по стандартным именам (foot_l/foot_r), иначе — конец цепочки ноги. */
function feet(project: Project, rig: Rig): [number, number] | undefined {
  const std = new Map([...standardNames(project, rig, "unreal")].map(([b, n]) => [n, b]));
  const f = (s: "l" | "r") => std.get(`foot_${s}`) ?? project.chains[`leg_${s}`]?.at(-1);
  const l = f("l"), r = f("r");
  return l && r && rig.index.has(l) && rig.index.has(r) ? [rig.index.get(l)!, rig.index.get(r)!] : undefined;
}

/** Фаза шага в моменты times: удар пятки левой — 0, следующий — 1. Шага нет (меньше двух ударов или ноги почти не
 * расходятся) — undefined. */
export function gaitPhase(project: Project, rig: Rig, clip: Clip, times: number[]): number[] | undefined {
  const ft = feet(project, rig);
  if (!ft || times.length < 8) return undefined;
  const fwd = bodyFrame(project).forward;
  const s = times.map((t) => {
    const T = worldPose(rig, posePartsAt(project, rig, clip, t)).T;
    return vdot(vsub(T[ft[0]], T[ft[1]]), fwd);
  });
  const amp = Math.max(...s) - Math.min(...s);
  const legs = project.chains.leg_l?.map((b) => rig.index.get(b)!).filter((i) => i != null) ?? [];
  const legLen = legs.length > 1 ? Math.hypot(...vsub(rig.worldT[legs[0]], rig.worldT[ft[0]])) : 1;
  if (amp < 0.15 * legLen) return undefined; // ноги почти не расходятся — это не шаг
  const hi = Math.min(...s) + 0.6 * amp;
  // удары пятки — вершины выше 60 % размаха; соседние вершины одного пика сливаются. У петли кадры идут по кругу
  // (последний момент = первый), и период — длительность, делённая на число ударов
  const loop = clip.loop && clip.duration > 0;
  const n = loop && Math.abs(times[times.length - 1] - times[0] - clip.duration) < 1e-6 ? s.length - 1 : s.length;
  const at = (k: number) => s[loop ? ((k % n) + n) % n : k];
  const peaks: number[] = [];
  for (let k = loop ? 0 : 1; k < (loop ? n : n - 1); k++) {
    if (s[k] < hi || s[k] < at(k - 1) || s[k] < at(k + 1)) continue;
    const last = peaks[peaks.length - 1];
    if (peaks.length && times[k] - times[last] < 0.25) {
      if (s[k] > s[last]) peaks[peaks.length - 1] = k;
    } else peaks.push(k);
  }
  // у петли вершина в самом конце и в самом начале — один и тот же удар
  if (loop && peaks.length > 1 && times[peaks[0]] + clip.duration - times[peaks[peaks.length - 1]] < 0.25) peaks.pop();
  if (peaks.length < (loop ? 1 : 2)) return undefined;
  const hits = peaks.map((k) => times[k]);
  const period = loop ? clip.duration / peaks.length : (hits[hits.length - 1] - hits[0]) / (hits.length - 1);
  // у петли за последним ударом идёт первый следующего круга
  if (loop) hits.push(hits[0] + clip.duration);
  return times.map((t) => {
    if (loop) t = hits[0] + ((((t - hits[0]) % clip.duration) + clip.duration) % clip.duration);
    const i = hits.findIndex((x, j) => t >= x && (j === hits.length - 1 || t < hits[j + 1]));
    if (i < 0) return ((((t - hits[0]) / period) % 1) + 1) % 1;
    const next = hits[i + 1] ?? hits[i] + period;
    return ((t - hits[i]) / (next - hits[i])) % 1;
  });
}

/** Средний поворот (знаки выровнены к первому), сдвиг — среднее. */
function meanQ(qs: Quat[]): Quat {
  if (!qs.length) return [0, 0, 0, 1];
  const a = qs[0];
  const s = qs.reduce((m, q) => { const k = a[0] * q[0] + a[1] * q[1] + a[2] * q[2] + a[3] * q[3] < 0 ? -1 : 1; return m.map((x, i) => x + k * q[i]) as Quat; }, [0, 0, 0, 0] as Quat);
  return qnorm(s);
}

interface Table { rot: Map<string, Quat[]>; up: number[] }

/** Поза записи по фазам: для каждой из PHASES точек — средний поворот кости и высота таза по кадрам, попавшим в неё. */
function phaseTable(project: Project, layer: PoseLayer, phase: number[] | undefined): Table {
  const up = bodyFrame(project).up, pelvis = project.chains.pelvis?.[0];
  const bins: PoseKey[][] = Array.from({ length: PHASES }, () => []);
  layer.keys.forEach((k, i) => bins[phase ? Math.floor(phase[i] * PHASES) % PHASES : 0].push(k));
  // без фазы (стойка) — одна точка на все фазы
  if (!phase) for (let b = 1; b < PHASES; b++) bins[b] = bins[0];
  const bones = new Set(layer.keys.flatMap((k) => Object.keys(k.rot ?? {})));
  const rot = new Map<string, Quat[]>();
  for (const bone of bones) rot.set(bone, bins.map((ks) => meanQ(ks.map((k) => k.rot?.[bone] ?? ([0, 0, 0, 1] as Quat)))));
  const h = bins.map((ks) => (ks.length && pelvis ? ks.reduce((m, k) => m + vdot(k.move?.[pelvis] ?? [0, 0, 0], up), 0) / ks.length : 0));
  return { rot, up: h };
}

export interface StyleSource {
  /** записи на скелете цели (clip.import в памяти): обычная и стиль, одно и то же движение */
  neutral: Clip;
  style: Clip;
}

/** Слой стиля для клипа: ключ на кадр (fps) — разница «стиль − обычная» в фазе шага клипа; без шага — средняя.
 * amount — доля разницы (1 — как в записи). */
export function styleLayer(project: Project, rig: Rig, clip: Clip, src: StyleSource, amount = 1, fps = 30): { layer: PoseLayer; phased: boolean } {
  const base = (c: Clip) => c.layers.find((l): l is PoseLayer => l.type === "pose")!;
  const times = (c: Clip) => (base(c).keys.map((k) => k.t));
  const pn = gaitPhase(project, rig, src.neutral, times(src.neutral));
  const ps = gaitPhase(project, rig, src.style, times(src.style));
  const N = phaseTable(project, base(src.neutral), pn);
  const S = phaseTable(project, base(src.style), ps);
  const phased = !!(pn && ps);
  // разница по фазам: d = обычная⁻¹ · стиль — поворот от обычной позы кости к стилевой в её же осях (на Xbot
  // предплечья зомби вперёд на 0,84/0,79 против 0,79/0,71 у порядка «стиль · обычная⁻¹»)
  const diff = new Map<string, Quat[]>();
  for (const [bone, sq] of S.rot) {
    const nq = N.rot.get(bone) ?? sq.map(() => [0, 0, 0, 1] as Quat);
    diff.set(bone, sq.map((q, b) => qnorm(qmul(qinv(nq[b]), q))));
  }
  const dUp = S.up.map((h, b) => h - N.up[b]);
  const n = Math.max(2, Math.round(clip.duration * fps) + 1);
  const ts = Array.from({ length: n }, (_, k) => +((clip.duration * k) / (n - 1)).toFixed(5));
  const pc = phased ? gaitPhase(project, rig, clip, ts) : undefined;
  const pelvis = project.chains.pelvis?.[0];
  const up = bodyFrame(project).up;
  const avg = (bone: string) => meanQ(diff.get(bone)!);
  const avgUp = dUp.reduce((a, b) => a + b, 0) / PHASES;
  const keys: PoseKey[] = ts.map((t, i) => {
    const key: PoseKey = { t, interp: "linear", rot: {} };
    const ph = pc ? pc[i] * PHASES : undefined;
    for (const bone of diff.keys()) {
      let q: Quat;
      if (ph == null) q = avg(bone);
      else {
        const a = Math.floor(ph) % PHASES, b = (a + 1) % PHASES, u = ph - Math.floor(ph);
        const qa = diff.get(bone)![a], qb = diff.get(bone)![b];
        q = qnorm(qmul(qscale(qmul(qb, qinv(qa)), u), qa));
      }
      if (amount !== 1) q = qscale(q, amount);
      if (1 - Math.abs(q[3]) > 1e-7) key.rot![bone] = q.map((x) => Math.round(x * 1e5) / 1e5) as Quat;
    }
    if (pelvis) {
      const h = ph == null ? avgUp : dUp[Math.floor(ph) % PHASES] * (1 - (ph % 1)) + dUp[(Math.floor(ph) + 1) % PHASES] * (ph % 1);
      if (Math.abs(h) > 1e-5) key.move = { [pelvis]: up.map((x) => Math.round(x * h * amount * 1e5) / 1e5) as Vec3 };
    }
    return key;
  });
  const source = base(src.style).source;
  return { layer: { id: "style", type: "pose", keys, ...(source ? { source } : {}) }, phased: !!pc };
}
