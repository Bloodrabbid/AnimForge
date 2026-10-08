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
    return { i, role: r?.role, order: r?.order ?? 0, side: side ?? (Math.abs(S(i)) > 1e-4 ? (S(i) > 0 ? "l" : "r") : null) };
  });
  const pick = (role: string, side?: "l" | "r") => tagged.filter((t) => t.role === role && (!side || t.side === side)).sort((a, b) => a.order - b.order || H(a.i) - H(b.i));

  const hips = pick("hips").sort((a, b) => depth(rig, a.i) - depth(rig, b.i))[0];
  if (hips) { det.chains.pelvis = [name(hips.i)]; det.method.pelvis = "names"; }
  const spines = pick("spine").filter((t) => !hips || isAncestor(hips.i, t.i)).map((t) => t.i);
  const chestT = pick("chest")[0];
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
  let pelvis = hips?.i;
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
        const hand = leaves.filter((i) => trunkBelow.some((t) => isAncestor(t, i)) && !isAncestor(rig.index.get(det.chains[`leg_${s}`]?.[0] ?? "")!, i) && H(i) - floor > 0.3 * height)
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

function depth(rig: Rig, i: number) { let d = 0; for (let p = rig.parent[i]; p >= 0; p = rig.parent[p]) d++; return d; }

export type { Vec3 };
