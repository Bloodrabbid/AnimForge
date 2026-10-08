// Распознавание скелета чужой модели: какие кости — таз, грудь, голова, руки, ноги, хвост.
// Сначала по именам (Mixamo, Unreal, Unity, Blender/Rigify, 3ds Max Biped и их смеси), потом — по геометрии:
// ноги — две цепочки вниз к самым низким костям, руки — две цепочки в стороны от груди, голова — вверх.
// Результат — цепочки со стандартными именами, на которые рассчитаны рецепты и пресеты библиотеки.
import { vcross, vdot, vnorm, vscale, vsub, type Vec3 } from "./math.ts";
import type { Project, Skeleton } from "./project.ts";
import { bodyFrame, buildRig, type Rig } from "./evaluate.ts";

/** Стандартные цепочки. Ноги и руки — от основания к концу: бедро → голень (→ стопа отдельно), плечо → предплечье. */
export const STANDARD_CHAINS = ["pelvis", "spine", "chest", "neck", "head", "arm_l", "arm_r", "leg_l", "leg_r", "tail", "eye_l", "eye_r"] as const;
export type StdChain = (typeof STANDARD_CHAINS)[number];

export interface RigDetection {
  chains: Partial<Record<StdChain, string[]>>;
  feet: { l?: string; r?: string };
  hands: { l?: string; r?: string };
  method: Partial<Record<StdChain, "names" | "geometry">>;
  notes: string[];
}

// Нормализация имени: префиксы риггеров и регистр убираем, сторону вынимаем отдельно.
const PREFIX = /^(\d+[_ ]|mixamorig\d*[:_]|def[-_]|org[-_]|mch[-_]|bip\d*[ _]?|bone[_ ]?|armature[|_:]|cc_base_|rig[_:]|j_|b_|jnt_|ik_)/i;
function norm(name: string): { base: string; side: "l" | "r" | null } {
  let n = name.replace(/^[^|:]*[|:]/, "").trim(); // пространство имён: «mixamorig:», «Armature|»
  for (let k = 0; k < 3; k++) n = n.replace(PREFIX, "");
  let side: "l" | "r" | null = null;
  const sideRe: [RegExp, "l" | "r"][] = [
    [/(^|[ _.\-])(l|left)([ _.\-]|$)/i, "l"], [/(^|[ _.\-])(r|right)([ _.\-]|$)/i, "r"],
    [/^left/i, "l"], [/^right/i, "r"], [/left$/i, "l"], [/right$/i, "r"], [/[._]l$/i, "l"], [/[._]r$/i, "r"], [/^l(?=[A-Z])/, "l"], [/^r(?=[A-Z])/, "r"],
  ];
  for (const [re, s] of sideRe) if (re.test(n)) { side = s; n = n.replace(re, " "); break; }
  return { base: n.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim(), side };
}

// Синонимы ролей (после norm). Числа на конце (spine 01, spine1) учитываются как порядок.
const NAMES: Record<string, RegExp> = {
  hips: /^(hips?|pelvis|root hips|cog|center|centre|torso root)$/,
  spine: /^(spine|spine ?\d+|spine (lower|mid|middle|upper)|back ?\d*|abdomen|belly|waist|torso|chest lower)$/,
  chest: /^(chest|upper ?chest|upperchest|spine ?top|ribcage|thorax|breast)$/,
  neck: /^(neck ?\d*|neck (lower|upper))$/,
  head: /^(head|skull|head ?top)$/,
  clavicle: /^(clavicle|shoulder|collar|collarbone)$/,
  upperarm: /^(upper ?arm|arm|arm upper|humerus|upperarm)$/,
  forearm: /^(fore ?arm|lower ?arm|arm lower|elbow|forearm|lowerarm)$/,
  hand: /^(hand|wrist|palm)$/,
  thigh: /^(thigh|up ?leg|upper ?leg|upleg|leg upper|femur)$/,
  shin: /^(shin|calf|leg|lower ?leg|knee|leg lower|tibia|lowerleg)$/,
  foot: /^(foot|ankle|heel|feet)$/,
  tail: /^(tail ?\d*)$/,
  eye: /^(eye|eyeball|facial eye)$/,
};

function roleOf(base: string): { role: string; order: number } | null {
  const m = base.match(/^(.*?)[ ]?(\d+)$/);
  const order = m ? +m[2] : 0;
  for (const [role, re] of Object.entries(NAMES)) if (re.test(base) || (m && re.test(m[1]))) return { role, order };
  return null;
}

/** Куда смотрит персонаж. По меткам сторон в именах: «влево» = среднее (L − R), вперёд = влево × вверх.
 * Без меток — по стопам: носок впереди лодыжки. Иначе — +Z. */
export function detectForward(skel: Skeleton, up: Vec3 = [0, 1, 0]): { forward: Vec3; by: "names" | "toes" | "default" } {
  const rig = buildRig(skel);
  const U = vnorm(up);
  const flat = (v: Vec3) => vsub(v, vscale(U, vdot(v, U)));
  const bySide = new Map<string, { l?: number; r?: number }>();
  skel.nodes.forEach((n, i) => {
    if (!n.isJoint) return;
    const { base, side } = norm(n.name);
    if (!side || !base) return;
    const e = bySide.get(base) ?? {};
    e[side] = i;
    bySide.set(base, e);
  });
  let left: Vec3 = [0, 0, 0];
  let pairs = 0;
  for (const e of bySide.values()) if (e.l != null && e.r != null) { left = [0, 1, 2].map((k) => left[k] + rig.worldT[e.l!][k] - rig.worldT[e.r!][k]) as Vec3; pairs++; }
  if (pairs >= 2 && Math.hypot(...flat(left)) > 1e-6) return { forward: vnorm(vcross(vnorm(flat(left)), U)), by: "names" };
  // стопы: два самых низких листа; их родитель — лодыжка, носок — впереди неё
  const joints = skel.nodes.map((n, i) => i).filter((i) => skel.nodes[i].isJoint);
  const leaves = joints.filter((i) => !joints.some((j) => rig.parent[j] === i)).sort((a, b) => vdot(rig.worldT[a], U) - vdot(rig.worldT[b], U)).slice(0, 2);
  let f: Vec3 = [0, 0, 0];
  for (const i of leaves) if (rig.parent[i] >= 0) f = [0, 1, 2].map((k) => f[k] + rig.worldT[i][k] - rig.worldT[rig.parent[i]][k]) as Vec3;
  if (Math.hypot(...flat(f)) > 1e-4) return { forward: vnorm(flat(f)), by: "toes" };
  return { forward: [0, 0, 1], by: "default" };
}

export function detectRig(skel: Skeleton, project: Pick<Project, "up" | "forward">): RigDetection {
  const rig = buildRig(skel);
  const { up, side: leftDir } = bodyFrame(project as Project);
  const joints = skel.nodes.map((n, i) => ({ n, i })).filter((x) => x.n.isJoint);
  const det: RigDetection = { chains: {}, feet: {}, hands: {}, method: {}, notes: [] };
  const H = (i: number) => vdot(rig.worldT[i], up);
  // > 0 — левая сторона персонажа; от центра скелета (модель может стоять не в нуле)
  const center = joints.reduce((acc, j) => acc + vdot(rig.worldT[j.i], leftDir), 0) / Math.max(1, joints.length);
  const S = (i: number) => vdot(rig.worldT[i], leftDir) - center;
  const children = (i: number) => joints.filter((j) => rig.parent[j.i] === i).map((j) => j.i);
  const name = (i: number) => skel.nodes[i].name;
  const isAncestor = (a: number, b: number) => { for (let p = rig.parent[b]; p >= 0; p = rig.parent[p]) if (p === a) return true; return false; };

  // ── 1. имена ──
  const tagged = joints.map(({ n, i }) => {
    const { base, side } = norm(n.name);
    const r = roleOf(base);
    // сторону без явной метки берём из геометрии (только для парных ролей)
    return { i, role: r?.role, order: r?.order ?? 0, side: side ?? (Math.abs(S(i)) > 1e-4 ? (S(i) > 0 ? "l" : "r") : null), named: !!side };
  });
  const pick = (role: string, side?: "l" | "r") => tagged.filter((t) => t.role === role && (!side || t.side === side)).sort((a, b) => a.order - b.order || H(a.i) - H(b.i));

  const hips = pick("hips").sort((a, b) => depth(rig, a.i) - depth(rig, b.i))[0];
  if (hips) { det.chains.pelvis = [name(hips.i)]; det.method.pelvis = "names"; }
  const spines = pick("spine").filter((t) => !hips || isAncestor(hips.i, t.i)).map((t) => t.i);
  // грудь — кость по середине тела: CC_Base_R_Breast (грудь как мягкая ткань, со стороной в имени) — не она
  const chestT = pick("chest").find((t) => !t.named);
  if (spines.length) { det.chains.spine = spines.map(name); det.method.spine = "names"; }
  const chestBone = chestT?.i ?? spines[spines.length - 1];
  if (chestBone != null) { det.chains.chest = [name(chestBone)]; det.method.chest = "names"; }
  const necks = pick("neck").map((t) => t.i);
  if (necks.length) { det.chains.neck = necks.map(name); det.method.neck = "names"; }
  const head = pick("head")[0];
  if (head) { det.chains.head = [name(head.i)]; det.method.head = "names"; }
  for (const s of ["l", "r"] as const) {
    const uas = pick("upperarm", s);
    // «arm_0, arm_1» без отдельного предплечья — две кости одной руки по порядку
    const ua = uas[0], fa = pick("forearm", s)[0] ?? (uas[1] && isAncestor(uas[0].i, uas[1].i) ? uas[1] : undefined), hand = pick("hand", s)[0];
    if (ua && fa) { det.chains[`arm_${s}`] = [name(ua.i), name(fa.i)]; det.method[`arm_${s}`] = "names"; }
    if (hand) det.hands[s] = name(hand.i);
    const th = pick("thigh", s).filter((t) => !pick("upperarm", s).some((u) => u.i === t.i))[0];
    // «leg» у Mixamo — голень (LeftUpLeg → LeftLeg), у других — бедро; решаем по иерархии
    const shins = pick("shin", s).filter((t) => !th || isAncestor(th.i, t.i));
    const foot = pick("foot", s)[0];
    if (th && shins[0]) { det.chains[`leg_${s}`] = [name(th.i), name(shins[0].i)]; det.method[`leg_${s}`] = "names"; }
    else if (!th && shins.length >= 2) { det.chains[`leg_${s}`] = [name(shins[0].i), name(shins[1].i)]; det.method[`leg_${s}`] = "names"; }
    if (foot) det.feet[s] = name(foot.i);
  }
  for (const s of ["l", "r"] as const) {
    const eye = pick("eye", s)[0];
    if (eye) { det.chains[`eye_${s}`] = [name(eye.i)]; det.method[`eye_${s}`] = "names"; }
  }
  const tails = pick("tail").map((t) => t.i);
  if (tails.length) { det.chains.tail = tails.map(name); det.method.tail = "names"; }

  // ── 2. геометрия: что не нашлось по именам ──
  const leaves = joints.filter((j) => children(j.i).length === 0).map((j) => j.i);
  const pathUp = (leaf: number, stop: number) => { const p: number[] = []; for (let c = leaf; c >= 0 && c !== stop; c = rig.parent[c]) p.unshift(c); return p; };
  const lowest = [...leaves].sort((a, b) => H(a) - H(b));
  const floor = lowest.length ? H(lowest[0]) : 0;
  const height = Math.max(...joints.map((j) => H(j.i))) - floor || 1;

  // таз: общий предок двух самых низких листьев по разные стороны
  let pelvis: number | undefined = hips?.i;
  const footL = det.feet.l ? rig.index.get(det.feet.l)! : lowest.find((i) => S(i) > 0.01 * height);
  const footR = det.feet.r ? rig.index.get(det.feet.r)! : lowest.find((i) => S(i) < -0.01 * height);
  if (pelvis == null && footL != null && footR != null) {
    const anc = new Set<number>(); for (let p = footL; p >= 0; p = rig.parent[p]) anc.add(p);
    for (let p = footR; p >= 0; p = rig.parent[p]) if (anc.has(p)) { pelvis = p; break; }
    if (pelvis != null) { det.chains.pelvis = [name(pelvis)]; det.method.pelvis = "geometry"; }
  }
  for (const [s, leaf] of [["l", footL], ["r", footR]] as const) {
    if (leaf == null || pelvis == null) continue;
    // по пути таз → нижний лист: лодыжка — первая кость ниже 12 % роста, голень — перед ней, бедро — первая после таза
    const path = pathUp(leaf, pelvis);
    const ankle = det.feet[s] ? rig.index.get(det.feet[s]!)! : path.find((i) => H(i) - floor < 0.12 * height) ?? path[path.length - 1];
    if (!det.feet[s]) det.feet[s] = name(ankle);
    if (det.chains[`leg_${s}`]) continue;
    const before = path.slice(0, path.indexOf(ankle));
    if (before.length >= 2) {
      det.chains[`leg_${s}`] = [name(before[0]), name(before[before.length - 1])];
      det.method[`leg_${s}`] = "geometry";
    }
  }
  // ноги по геометрии — только настоящие: путь от таза к стопе идёт в основном вниз (опускание ≥ 0.6 длины).
  // Нижние плавники рыбы и ласты черепахи тоже «самые низкие листья по сторонам», но идут вбок или назад
  // (замерено на авториге: люди и птица 0.78–0.94, ласты 0.39, плавники 0.03–0.13) — такое тело разбирает detectFins
  const pathLen = (from: number, to: number) => { let L = 0; for (let c = to; c >= 0 && c !== from && rig.parent[c] >= 0; c = rig.parent[c]) L += Math.hypot(...vsub(rig.worldT[c], rig.worldT[rig.parent[c]])); return L; };
  if (pelvis != null && det.method.pelvis === "geometry") {
    const sideways = (["l", "r"] as const).some((s) => {
      if (det.method[`leg_${s}`] !== "geometry" || !det.feet[s]) return false;
      const f = rig.index.get(det.feet[s]!)!;
      return H(pelvis!) - H(f) < 0.6 * pathLen(pelvis!, f);
    });
    if (sideways) {
      for (const s of ["l", "r"] as const) { delete det.chains[`leg_${s}`]; delete det.method[`leg_${s}`]; delete det.feet[s]; }
      delete det.chains.pelvis; delete det.method.pelvis;
      det.notes.push("нижние ветки идут вбок, а не вниз — не ноги (плавники, ласты?)");
      pelvis = undefined;
    }
  }
  // голова и руки: от таза вверх по самой «высокой» ветке; руки — ветки в стороны выше середины роста
  if (pelvis != null && (!det.chains.head || !det.chains.arm_l || !det.chains.arm_r || !det.chains.chest)) {
    const top = [...leaves].filter((i) => isAncestor(pelvis!, i)).sort((a, b) => H(b) - H(a))[0];
    if (top != null) {
      const trunk = pathUp(top, pelvis);
      // голова — последняя кость ствола выше 80 % роста, у которой родитель ниже (не кончик волос/ушей)
      const headI = det.chains.head ? rig.index.get(det.chains.head[0])! : [...trunk].reverse().find((i) => H(i) - floor < 0.95 * height && H(i) - floor > 0.7 * height) ?? trunk[trunk.length - 1];
      if (!det.chains.head) { det.chains.head = [name(headI)]; det.method.head = "geometry"; }
      const trunkBelow = trunk.filter((i) => isAncestor(i, headI));
      if (!det.chains.spine && trunkBelow.length) { det.chains.spine = trunkBelow.map(name); det.method.spine = "geometry"; }
      for (const s of ["l", "r"] as const) {
        if (det.chains[`arm_${s}`]) continue;
        const sign = s === "l" ? 1 : -1;
        // кисть — лист дальше всех в свою сторону среди потомков ствола (не ноги)
        // у птицы без имён крылья растут прямо из таза (развилка ног и крыльев одна) — таз тоже годится
        const hand = leaves.filter((i) => [pelvis!, ...trunkBelow].some((t) => isAncestor(t, i)) && !isAncestor(rig.index.get(det.chains[`leg_${s}`]?.[0] ?? "")!, i) && H(i) - floor > 0.3 * height)
          .sort((a, b) => sign * (S(b) - S(a)))[0];
        if (hand == null || sign * S(hand) < 0.1 * height) continue;
        const branch = pathUp(hand, pelvis).filter((i) => !trunk.includes(i));
        // плечо — первая кость ветки, заметно отошедшая вбок от ствола; предплечье — следующая
        const sh = branch.findIndex((i) => sign * S(i) > 0.08 * height);
        if (sh >= 0 && branch[sh + 1] != null) {
          det.chains[`arm_${s}`] = [name(branch[sh]), name(branch[sh + 1])];
          det.method[`arm_${s}`] = "geometry";
          if (!det.hands[s]) det.hands[s] = name(branch[Math.min(sh + 2, branch.length - 1)]);
        }
        const clav = branch[sh - 1];
        if (!det.chains.chest && clav != null && rig.parent[clav] >= 0) { det.chains.chest = [name(rig.parent[clav])]; det.method.chest = "geometry"; }
      }
      if (!det.chains.chest && trunkBelow.length) { det.chains.chest = [name(trunkBelow[trunkBelow.length - 1])]; det.method.chest = "geometry"; }
    }
  }
  for (const c of ["pelvis", "chest", "head", "arm_l", "arm_r", "leg_l", "leg_r"] as const) if (!det.chains[c]) det.notes.push(`не найдено: ${c}`);
  if (det.chains.leg_l && det.chains.leg_r && S(rig.index.get(det.chains.leg_l[0])!) < S(rig.index.get(det.chains.leg_r[0])!)) det.notes.push("левая нога оказалась правее правой — проверь project.forward");
  return det;
}

/** Четвероногое по геометрии (имена не нужны): внизу четыре лапы, у каждой свой корень — самая высокая кость, под которой
 * все нижние концы лежат кучкой (пальцы одной лапы). Передняя пара — та, что ближе к голове (самому высокому концу вне лап).
 * Цепочки — как у двуногих, чтобы рецепты и пресеты работали без переименований: передние лапы — arm_l/arm_r,
 * задние — leg_l/leg_r, таз — место крепления задних лап, грудь — передних, между ними spine, дальше neck/head и tail.
 * Лапа — весь путь от корня до нижнего конца (у собаки это плечо → предплечье → пясть → палец). null — не четвероногое. */
/** Ноги по геометрии: нижние концы скелета кучками (пальцы одной лапы), корень ноги — самая высокая кость, под которой
 * остаётся одна кучка. Отсев служебных костей на полу: нога должна доходить до тела. */
function findLegs(skel: Skeleton, up: Vec3) {
  const rig = buildRig(skel);
  const U = vnorm(up);
  const H = (i: number) => vdot(rig.worldT[i], U);
  const flat = (v: Vec3) => vsub(v, vscale(U, vdot(v, U)));
  const joints = skel.nodes.map((_, i) => i).filter((i) => skel.nodes[i].isJoint);
  const kids = new Map<number, number[]>();
  for (const i of joints) if (rig.parent[i] >= 0) kids.set(rig.parent[i], [...(kids.get(rig.parent[i]) ?? []), i]);
  const leaves = joints.filter((i) => !kids.has(i));
  const floor = Math.min(...joints.map(H)), height = Math.max(...joints.map(H)) - floor || 1;
  const low = leaves.filter((i) => H(i) - floor < 0.15 * height);
  const name = (i: number) => skel.nodes[i].name;
  const below = (a: number): number[] => (kids.get(a) ?? []).flatMap((c) => [c, ...below(c)]);
  const lowUnder = (a: number) => [a, ...below(a)].filter((i) => low.includes(i));
  const spread = (ids: number[]) => Math.max(0, ...ids.flatMap((a) => ids.map((b) => Math.hypot(...flat(vsub(rig.worldT[a], rig.worldT[b]))))));
  const roots = new Set<number>();
  for (const leaf of low) {
    let r = leaf;
    while (rig.parent[r] >= 0 && skel.nodes[rig.parent[r]].isJoint && spread(lowUnder(rig.parent[r])) < 0.08 * height) r = rig.parent[r];
    roots.add(r);
  }
  const legs = [...roots].map((r) => {
    const paw = lowUnder(r).sort((a, b) => H(a) - H(b))[0];
    const path: number[] = [];
    for (let c = paw; c !== rig.parent[r]; c = rig.parent[c]) path.unshift(c);
    return { root: r, paw, path, at: rig.parent[r], pos: rig.worldT[paw] };
  });
  // нога должна доходить до тела: служебные кости на полу (у April 02_b2) — не ноги
  const len = (path: number[]) => path.slice(1).reduce((a, c) => a + Math.hypot(...vsub(rig.worldT[c], rig.worldT[rig.parent[c]])), 0);
  const ok = !legs.some((l) => H(l.root) - floor < 0.25 * height || len(l.path) < 0.2 * height);
  return { rig, U, H, flat, leaves, floor, height, name, legs: ok ? legs : [] };
}
type Leg = ReturnType<typeof findLegs>["legs"][number];

export function detectQuadruped(skel: Skeleton, up: Vec3 = [0, 1, 0]): (RigDetection & { forward: Vec3; paws: string[] }) | null {
  const { rig, U, H, flat, leaves, height, name, legs } = findLegs(skel, up);
  if (legs.length !== 4) return null;
  // пары — по месту крепления (две лапы на одной кости или рядом); иначе по расстоянию
  const attach = [...new Set(legs.map((l) => l.at))];
  let pairs: (typeof legs)[];
  if (attach.length === 2) pairs = attach.map((a) => legs.filter((l) => l.at === a));
  else {
    const [a] = legs; const rest = legs.slice(1).sort((x, y) => Math.hypot(...flat(vsub(x.pos, a.pos))) - Math.hypot(...flat(vsub(y.pos, a.pos))));
    // ближайшая к первой лапе — её пара по другую сторону тела, если поперёк ближе, чем вдоль
    pairs = [[a, rest[0]], [rest[1], rest[2]]];
  }
  if (pairs.some((p) => p.length !== 2)) return null;
  const mid = (p: typeof legs) => vscale([0, 1, 2].map((k) => p[0].pos[k] + p[1].pos[k]) as Vec3, 0.5);
  const legSet = new Set(legs.flatMap((l) => l.path));
  const head = leaves.filter((i) => !legSet.has(i)).sort((a, b) => H(b) - H(a))[0];
  if (head == null) return null;
  const axis = flat(vsub(mid(pairs[0]), mid(pairs[1])));
  if (Math.hypot(...axis) < 1e-6 * height) return null; // пары в одном месте — направления нет
  const toHead = vdot(flat(vsub(rig.worldT[head], mid(pairs[1]))), axis) - vdot(flat(vsub(mid(pairs[0]), mid(pairs[1]))), axis) / 2;
  const [fore, hind] = toHead > 0 ? [pairs[0], pairs[1]] : [pairs[1], pairs[0]];
  const forward = vnorm(toHead > 0 ? axis : vscale(axis, -1));
  const left = vcross(U, forward);
  const sides = (p: typeof legs) => (vdot(p[0].pos, left) > vdot(p[1].pos, left) ? [["l", p[0]], ["r", p[1]]] : [["r", p[0]], ["l", p[1]]]) as ["l" | "r", (typeof legs)[number]][];
  const det: RigDetection & { forward: Vec3; paws: string[] } = { chains: {}, feet: {}, hands: {}, method: {}, notes: ["четвероногое: передние лапы — arm_l/arm_r, задние — leg_l/leg_r"], forward, paws: legs.map((l) => name(l.paw)) };
  for (const [s, l] of sides(fore)) { det.chains[`arm_${s}`] = l.path.map(name); det.hands[s] = name(l.paw); det.method[`arm_${s}`] = "geometry"; }
  for (const [s, l] of sides(hind)) { det.chains[`leg_${s}`] = l.path.map(name); det.feet[s] = name(l.paw); det.method[`leg_${s}`] = "geometry"; }
  // таз и грудь — места крепления (если лапы одной пары крепятся к разным костям — их общий предок)
  const common = (a: number, b: number) => { const s1 = new Set<number>(); for (let p = a; p >= 0; p = rig.parent[p]) s1.add(p); for (let p = b; p >= 0; p = rig.parent[p]) if (s1.has(p)) return p; return -1; };
  const pelvis = common(hind[0].at, hind[1].at), chest = common(fore[0].at, fore[1].at);
  if (pelvis < 0 || chest < 0) return null;
  const pathDown = (from: number, to: number) => { const p: number[] = []; for (let c = to; c >= 0 && c !== from; c = rig.parent[c]) p.unshift(c); return p; };
  det.chains.pelvis = [name(pelvis)];
  det.chains.chest = [name(chest)];
  const sp = pathDown(pelvis, chest);
  if (sp.length) det.chains.spine = sp.map(name); // от таза к груди, грудь — последняя
  const isUnder = (a: number, b: number) => { for (let p = b; p >= 0; p = rig.parent[p]) if (p === a) return true; return false; };
  if (isUnder(chest, head)) {
    const nh = pathDown(chest, head);
    // голова — кость с именем «head» на пути, иначе предпоследняя (последняя — кончик: ухо, челюсть)
    const hi = nh.findIndex((i) => roleOf(norm(name(i)).base)?.role === "head");
    const h = hi >= 0 ? hi : Math.max(0, nh.length - (nh.length > 2 ? 2 : 1));
    if (h > 0) det.chains.neck = nh.slice(0, h).map(name);
    det.chains.head = [name(nh[h])];
  }
  // хвост — самая длинная ветка таза вне лап и спины
  const tailLeaf = leaves.filter((i) => isUnder(pelvis, i) && !legSet.has(i) && !isUnder(chest, i) && i !== chest)
    .sort((a, b) => pathDown(pelvis, b).length - pathDown(pelvis, a).length)[0];
  if (tailLeaf != null) {
    const tp = pathDown(pelvis, tailLeaf).filter((i) => !sp.includes(i));
    if (tp.length) det.chains.tail = tp.map(name);
  }
  for (const c of ["pelvis", "chest", "neck", "head", "tail"] as const) det.method[c] = "geometry";
  return det;
}

/** Многоногое (6 и больше ног: насекомое, паук, сколопендра). Ноги — leg_l0, leg_r0 (передняя пара), leg_l1… —
 * по порядку от головы. Ось тела — главное направление, вдоль которого стоят основания ног; перёд — по именам
 * (голова, усики, челюсти) или по стороне, где больше концов вне ног. spine — от последнего крепления ног к первому. */
export function detectMultiLeg(skel: Skeleton, up: Vec3 = [0, 1, 0]): (RigDetection & { forward: Vec3; paws: string[]; legCount: number }) | null {
  const { rig, U, flat, leaves, name, legs } = findLegs(skel, up);
  if (legs.length < 6) return null;
  // ось тела — главное направление костей тела (не ног): у паука основания ног сидят кучно, а тело вытянуто
  const legSet = new Set(legs.flatMap((l) => l.path));
  const bodyJ = skel.nodes.map((_, i) => i).filter((i) => skel.nodes[i].isJoint && !legSet.has(i));
  const base = (bodyJ.length >= 2 ? bodyJ : legs.map((l) => l.root)).map((i) => flat(rig.worldT[i]));
  const c = vscale(base.reduce((a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]] as Vec3, [0, 0, 0] as Vec3), 1 / base.length);
  const C = [0, 1, 2].map((i) => [0, 1, 2].map((j) => base.reduce((a, b) => a + (b[i] - c[i]) * (b[j] - c[j]), 0)));
  let axis: Vec3 = vnorm(flat([0.31, 0.17, 0.23]));
  for (let it = 0; it < 60; it++) axis = vnorm(flat([0, 1, 2].map((i) => C[i][0] * axis[0] + C[i][1] * axis[1] + C[i][2] * axis[2]) as Vec3));
  const others = leaves.filter((i) => !legSet.has(i));
  const along = (i: number) => vdot(vsub(flat(rig.worldT[i]), c), axis);
  const FRONT = /head|antenn|mandib|jaw|eye|fang|chelic|pedipalp|mouth/i, BACK = /tail|abdom|sting|spinner|telson|cerc/i;
  let score = 0;
  for (const i of others) { // концы вне ног: «головные» имена — за перёд, «хвостовые» — за зад; без имён — просто голос стороны
    const sgn = Math.sign(along(i)), nm = name(i);
    let p: number[] = [];
    for (let q = i; q >= 0; q = rig.parent[q]) p.push(q);
    const tag = p.some((q) => FRONT.test(name(q))) ? 2 : p.some((q) => BACK.test(name(q))) ? -2 : 0;
    score += sgn * (tag || 0.5) * (nm ? 1 : 1);
  }
  if (score < 0) axis = vscale(axis, -1);
  const forward = axis, left = vcross(U, forward);
  const det: RigDetection & { forward: Vec3; paws: string[]; legCount: number } = { chains: {}, feet: {}, hands: {}, method: {}, notes: [`многоногое: ${legs.length} ног, leg_l0/leg_r0 — передняя пара`], forward, paws: legs.map((l) => name(l.paw)), legCount: legs.length };
  for (const side of ["l", "r"] as const) {
    const mine = legs.filter((l) => (vdot(vsub(flat(rig.worldT[l.root]), c), left) > 0) === (side === "l")).sort((a, b) => along(b.root) - along(a.root));
    mine.forEach((l, k) => { det.chains[`leg_${side}${k}` as StdChain] = l.path.map(name); det.method[`leg_${side}${k}` as StdChain] = "geometry"; });
  }
  // ось тела: от самого заднего крепления ног к самому переднему
  const ats = [...new Set(legs.map((l) => l.at))].sort((a, b) => along(a) - along(b));
  const isUnder = (a: number, b: number) => { for (let p = b; p >= 0; p = rig.parent[p]) if (p === a) return true; return false; };
  const [back, front] = [ats[0], ats[ats.length - 1]];
  const pathBetween = (a: number, b: number) => { const p: number[] = []; for (let q = b; q >= 0 && q !== a; q = rig.parent[q]) p.unshift(q); return p; };
  if (back !== front) {
    const sp = isUnder(back, front) ? [back, ...pathBetween(back, front)] : isUnder(front, back) ? [front, ...pathBetween(front, back)].reverse() : [];
    if (sp.length > 1) { det.chains.spine = sp.map(name); det.method.spine = "geometry"; }
  }
  det.chains.pelvis = [name(isUnder(back, front) ? back : front)];
  // голова: кость с именем head/cephal на пути от переднего конца; без имени — первая развилка (голова с усиками)
  const frontLeaf = others.filter((i) => along(i) > 0).sort((a, b) => along(b) - along(a))[0];
  const attachSet = new Set(legs.map((l) => l.at));
  if (frontLeaf != null) {
    const up_: number[] = [];
    for (let q = frontLeaf; q >= 0 && !attachSet.has(q); q = rig.parent[q]) up_.push(q);
    const kidsN = (q: number) => skel.nodes.filter((n) => n.parent === name(q) && n.isJoint).length;
    const hb = up_.find((q) => /head|cephal/i.test(name(q))) ?? up_.find((q) => kidsN(q) >= 2) ?? up_[Math.min(1, up_.length - 1)];
    if (hb != null) { det.chains.head = [name(hb)]; det.method.head = "geometry"; }
  }
  // хвост/брюшко: от заднего конца вверх до места крепления ног или спины
  const tailLeaf = others.filter((i) => along(i) < 0).sort((a, b) => along(a) - along(b))[0];
  if (tailLeaf != null) {
    const stop = new Set([...attachSet, ...(det.chains.spine ?? []).map((n) => rig.index.get(n)!)]);
    const tp: number[] = [];
    for (let q = tailLeaf; q >= 0 && !stop.has(q) && !legSet.has(q) && skel.nodes[q].isJoint; q = rig.parent[q]) tp.unshift(q);
    // у сколопендры задний конец — сам хвостовой сегмент (он же крепление): хвоста нет
    if (tp.length) { det.chains.tail = tp.map(name); det.method.tail = "geometry"; }
  }
  return det;
}

/** Крылья: «руки», размах которых больше 1.6 роста (у человека в T-позе размах ≈ рост). Крыло — вся ветка от плеча
 * до самого дальнего конца (плечо → предплечье → кисть → перья). null — не крылатое. */
export function detectWings(skel: Skeleton, up: Vec3, det: RigDetection): { wing_l: string[]; wing_r: string[]; span: number } | null {
  if (!det.chains.arm_l || !det.chains.arm_r) return null;
  const rig = buildRig(skel);
  const U = vnorm(up);
  const H = (i: number) => vdot(rig.worldT[i], U);
  const flat = (v: Vec3) => vsub(v, vscale(U, vdot(v, U)));
  const joints = skel.nodes.map((_, i) => i).filter((i) => skel.nodes[i].isJoint);
  const height = Math.max(...joints.map(H)) - Math.min(...joints.map(H)) || 1;
  const branch = (root: number) => {
    // самый дальний от корня потомок; путь до него — крыло
    let best = root, bd = 0;
    const walk = (i: number) => { for (const j of joints) if (rig.parent[j] === i) { const d = Math.hypot(...vsub(rig.worldT[j], rig.worldT[root])); if (d > bd) { bd = d; best = j; } walk(j); } };
    walk(root);
    const p: number[] = [];
    for (let q = best; q >= 0 && q !== rig.parent[root]; q = rig.parent[q]) p.unshift(q);
    return p;
  };
  const l = branch(rig.index.get(det.chains.arm_l[0])!), r = branch(rig.index.get(det.chains.arm_r[0])!);
  const span = Math.hypot(...flat(vsub(rig.worldT[l[l.length - 1]], rig.worldT[r[r.length - 1]])));
  if (span < 1.6 * height) return null;
  return { wing_l: l.map((i) => skel.nodes[i].name), wing_r: r.map((i) => skel.nodes[i].name), span };
}

/** Ласты и плавники: у тела без ног ищем зеркальные пары веток в стороны (черепаха, рыба с грудными плавниками, скат).
 * Пара — две сестринские кости, отражающиеся друг в друга через плоскость симметрии тела. Передняя пара — wing_l/wing_r
 * (гребок wing-flap), следующая — leg_l/leg_r; таз — общий предок пар; голова и хвост — непарные ветки вперёд и назад. */
export function detectFins(skel: Skeleton, up: Vec3 = [0, 1, 0]): (Omit<RigDetection, "chains"> & { chains: RigDetection["chains"] & { wing_l?: string[]; wing_r?: string[] }; forward: Vec3; pairs: number }) | null {
  const rig = buildRig(skel);
  const U = vnorm(up);
  const flat = (v: Vec3) => vsub(v, vscale(U, vdot(v, U)));
  const len = (v: Vec3) => Math.hypot(...v);
  const joints = skel.nodes.map((_, i) => i).filter((i) => skel.nodes[i].isJoint);
  const kids = (i: number) => joints.filter((j) => rig.parent[j] === i);
  const subtree = (i: number): number[] => [i, ...kids(i).flatMap(subtree)];
  const lo = joints.map((i) => rig.worldT[i]);
  const size = Math.max(...[0, 1, 2].map((k) => Math.max(...lo.map((v) => v[k])) - Math.min(...lo.map((v) => v[k])))) || 1;
  // пары сестёр-отражений
  const pairs: { a: number; b: number; L: Vec3 }[] = [];
  const parents = [...new Set(joints.map((j) => rig.parent[j]))];
  for (const p of parents) {
    const c = joints.filter((j) => rig.parent[j] === p);
    const P = p >= 0 ? rig.worldT[p] : rig.worldT[c[0]];
    for (let x = 0; x < c.length; x++)
      for (let y = x + 1; y < c.length; y++) {
        const a = c[x], b = c[y];
        const ab = flat(vsub(rig.worldT[a], rig.worldT[b]));
        if (len(ab) < 0.04 * size) continue; // в одной точке — не пара
        const L = vnorm(ab);
        const da = vsub(rig.worldT[a], P), db = vsub(rig.worldT[b], P);
        const mirror = vsub(da, vscale(L, 2 * vdot(da, L)));
        if (len(vsub(mirror, db)) > 0.2 * Math.max(len(da), len(db), 1e-6)) continue;
        if (subtree(a).length !== subtree(b).length) continue;
        pairs.push({ a, b, L });
      }
  }
  // вложенные пары (средние звенья того же ласта) отбрасываем
  const top = pairs.filter((q) => !pairs.some((o) => o !== q && (subtree(o.a).includes(q.a) || subtree(o.b).includes(q.a))));
  if (!top.length) return null;
  // ось «вбок» — средняя по парам, «вперёд» — перпендикуляр; знак — по detectForward (имена, носки) или к непарной ветке-голове
  let lat: Vec3 = [0, 0, 0];
  for (const q of top) lat = vdot(lat, q.L) < 0 ? vsub(lat, q.L) : ([0, 1, 2].map((k) => lat[k] + q.L[k]) as Vec3);
  lat = vnorm(lat);
  let F = vnorm(vcross(lat, U));
  const inPair = new Set(top.flatMap((q) => [...subtree(q.a), ...subtree(q.b)]));
  const free = joints.filter((i) => !inPair.has(i));
  const named = free.find((i) => /head|skull|neck|nose|jaw|mouth/i.test(skel.nodes[i].name));
  const fw = detectForward(skel, up);
  if (named != null) {
    const c = top.map((q) => vscale([0, 1, 2].map((k) => rig.worldT[q.a][k] + rig.worldT[q.b][k]) as Vec3, 0.5));
    const mid = vscale(c.reduce((s, v) => [s[0] + v[0], s[1] + v[1], s[2] + v[2]] as Vec3, [0, 0, 0] as Vec3), 1 / c.length);
    if (vdot(vsub(rig.worldT[named], mid), F) < 0) F = vscale(F, -1);
  } else if (vdot(fw.forward, F) < 0) F = vscale(F, -1);
  const left = vcross(U, F);
  const along = (i: number) => vdot(rig.worldT[i], F);
  const sorted = [...top].sort((p, q) => along(q.a) + along(q.b) - along(p.a) - along(p.b));
  const branch = (root: number) => {
    let best = root, bd = 0;
    for (const j of subtree(root)) { const d = len(vsub(rig.worldT[j], rig.worldT[root])); if (d > bd) { bd = d; best = j; } }
    const path: number[] = [];
    for (let q = best; q >= 0 && q !== rig.parent[root]; q = rig.parent[q]) path.unshift(q);
    return path.map((i) => skel.nodes[i].name);
  };
  const lr = (q: { a: number; b: number }) => (vdot(vsub(rig.worldT[q.a], rig.worldT[q.b]), left) > 0 ? [q.a, q.b] : [q.b, q.a]);
  const chains: RigDetection["chains"] & { wing_l?: string[]; wing_r?: string[] } = {};
  const [fl, fr] = lr(sorted[0]);
  chains.wing_l = branch(fl);
  chains.wing_r = branch(fr);
  if (sorted[1]) {
    const [hl, hr] = lr(sorted[1]);
    chains.leg_l = branch(hl);
    chains.leg_r = branch(hr);
  }
  // таз — ближайший общий предок оснований пар (сустав скина)
  const anc = (i: number) => { const a: number[] = []; for (let q = rig.parent[i]; q >= 0; q = rig.parent[q]) a.push(q); return a; };
  const common = anc(sorted[0].a).find((x) => sorted.every((q) => anc(q.a).includes(x)) && skel.nodes[x].isJoint);
  if (common != null) {
    chains.pelvis = [skel.nodes[common].name];
    // голова и хвост — непарные листья, дальше всего вперёд и назад от таза
    const leaves = free.filter((i) => i !== common && anc(i).includes(common) && !kids(i).some((k) => !inPair.has(k)));
    const toward = (sgn: number) => leaves.filter((i) => sgn * (along(i) - along(common)) > 0.05 * size).sort((a, b) => sgn * (along(b) - along(a)))[0];
    const path = (leaf: number | undefined) => {
      if (leaf == null) return undefined;
      const p: number[] = [];
      for (let q = leaf; q >= 0 && q !== common; q = rig.parent[q]) if (!inPair.has(q)) p.unshift(q);
      return p.map((i) => skel.nodes[i].name);
    };
    const head = path(toward(1)), tail = path(toward(-1));
    if (head?.length) chains.head = head;
    if (tail?.length) chains.tail = tail;
  }
  const method = Object.fromEntries(Object.keys(chains).map((k) => [k, "geometry"])) as RigDetection["method"];
  return { chains, feet: {}, hands: {}, method, notes: [`ласты/плавники: пар ${top.length}, передняя — wing_l/wing_r${sorted[1] ? ", задняя — leg_l/leg_r" : ""}`], forward: F, pairs: top.length };
}

function depth(rig: Rig, i: number) { let d = 0; for (let p = rig.parent[i]; p >= 0; p = rig.parent[p]) d++; return d; }

export type { Vec3 };
