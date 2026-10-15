// Вычисление позы: rest-поза → слои рецептов → ручной слой → постановка на пол → вторичная динамика.
// Работает одинаково в браузере и в Node.
import { evalKeys } from "./curves.ts";
import { DEG, QI, Quat, Vec3, angVel, qaxis, qinv, qmul, qnorm, qrot, qscale, vadd, vcross, vdot, vmul, vnorm, vscale, vsub } from "./math.ts";
import type { Channel, Clip, Constraint, ConstraintTarget, GaitStyle, PoseLayer, Project, RecipeLayer, SemanticAxis, Skeleton, Travel } from "./project.ts";
import { RECIPES, withDefaults, type ClipEvent } from "./recipes.ts";
import { clampRotation, decompose, limitFrame } from "./limits.ts";

export interface Rig {
  skel: Skeleton;
  index: Map<string, number>;
  parent: number[]; // индекс родителя, −1 у корня
  worldR: Quat[]; // мировой поворот узла в rest-позе
  worldT: Vec3[];
  worldS: Vec3[];
}

export function buildRig(skel: Skeleton): Rig {
  const index = new Map(skel.nodes.map((n, i) => [n.name, i]));
  const worldR: Quat[] = [], worldT: Vec3[] = [], worldS: Vec3[] = [], parent: number[] = [];
  skel.nodes.forEach((n, i) => {
    const p = n.parent == null ? -1 : index.get(n.parent)!;
    parent[i] = p;
    if (p < 0) {
      worldR[i] = n.restR;
      worldT[i] = n.restT;
      worldS[i] = n.restS;
    } else {
      // масштаб родителя растягивает сдвиг ребёнка — как в worldPose: у FBX-моделей корень часто в 0.01 (сантиметры)
      worldR[i] = qnorm(qmul(worldR[p], n.restR));
      worldT[i] = vadd(worldT[p], qrot(worldR[p], vmul(worldS[p], n.restT)));
      worldS[i] = vmul(worldS[p], n.restS);
    }
  });
  return { skel, index, parent, worldR, worldT, worldS };
}

/** Оси тела: up, forward (ортогонализованный к up), side = up × forward (у персонажа, смотрящего на +Z, это +X — влево). */
export function bodyFrame(project: Project): { up: Vec3; forward: Vec3; side: Vec3 } {
  const up = vnorm(project.up);
  const f0 = project.forward ?? [0, 0, 1];
  const forward = vnorm(vsub(f0, vscale(up, vdot(f0, up))));
  return { up, forward, side: vcross(up, forward) };
}

/** Направление одиночной кости в rest: от родителя-кости к ней (таз, грудь, голова смотрят «по ходу» скелета при любых
 * локальных осях рига), а у корня — вдоль её локальной +Y (так кости хранят Blender и Mixamo). */
function boneDir(rig: Rig, i: number): Vec3 {
  const p = rig.parent[i];
  if (p >= 0 && rig.skel.nodes[p].isJoint) {
    const d = vsub(rig.worldT[i], rig.worldT[p]);
    if (Math.hypot(...d) > 1e-6) return vnorm(d);
  }
  return vnorm(qrot(rig.worldR[i], [0, 1, 0]));
}

/** Мировые оси цепочки: lateral — изгиб вбок (вокруг «верха»), vertical — изгиб вперёд-назад/вверх-вниз (вокруг бока),
 * roll — кручение вдоль цепочки. У вертикальной цепочки (нога, спина, щупальце) «верхом» служит forward тела. */
export function chainAxes(rig: Rig, project: Project, chain: string[]): Record<SemanticAxis, Vec3> {
  const i0 = rig.index.get(chain[0])!;
  const a = rig.worldT[i0];
  const b = rig.worldT[rig.index.get(chain[chain.length - 1])!];
  const along = Math.hypot(...vsub(b, a)) > 1e-6 ? vnorm(vsub(b, a)) : boneDir(rig, i0);
  const body = bodyFrame(project);
  let up = body.up;
  if (Math.hypot(...vcross(along, up)) < 1e-3) up = body.forward;
  const side = vnorm(vcross(along, up));
  return { lateral: up, vertical: side, roll: along };
}

/** Какие руки надо опустить перед рецептами: те, что в rest отходят от «вниз» больше чем на 30° (T- и A-поза).
 * Рецепты ходьбы и ударов пишутся от висящей руки, так у любого рига мах начинается из одной и той же позы. */
export function suggestAlign(rig: Rig, project: Project, abduct = 8): { align: NonNullable<Project["align"]>; angles: Record<string, number> } {
  const f = bodyFrame(project), align: NonNullable<Project["align"]> = {}, angles: Record<string, number> = {};
  for (const name of ["arm_l", "arm_r"]) {
    const chain = project.chains[name];
    if (!chain?.length || chain.some((b) => !rig.index.has(b))) continue;
    const along = chainAxes(rig, project, chain).roll;
    const deg = Math.acos(Math.max(-1, Math.min(1, -vdot(along, f.up)))) / DEG;
    angles[name] = +deg.toFixed(1);
    if (deg > 30) align[name] = { to: "down", abduct };
  }
  return { align, angles };
}

/** Мировая ось → поворот в локальном пространстве кости (чтобы рецепт не зависел от осей конкретного рига). */
function localDelta(rig: Rig, bone: number, worldAxis: Vec3, angle: number): Quat {
  const w = rig.worldR[bone];
  return qmul(qmul(qinv(w), qaxis(worldAxis, angle)), w);
}

function chainOf(project: Project, bone: string): string[] | undefined {
  return Object.values(project.chains).find((c) => c.includes(bone));
}

/** Локальные трансформы затронутых костей. Чего нет в картах — остаётся в rest. */
export interface PoseParts {
  rot: Map<string, Quat>;
  pos: Map<string, Vec3>;
  scl: Map<string, Vec3>;
  /** кости, упёршиеся в ограничение в этот момент */
  limited?: Set<string>;
}

const vdiv = (a: Vec3, b: Vec3): Vec3 => [a[0] / b[0], a[1] / b[1], a[2] / b[2]];

/** Накопитель слоёв в мировых терминах; в локальные трансформы переводится в конце. */
class Acc {
  rot = new Map<string, Quat>(); // дельта в локальном пространстве кости
  move = new Map<string, Vec3>(); // мировой сдвиг, м
  scale = new Map<string, Vec3>(); // множители по up / forward / side
  base = new Map<string, Quat>(); // повороты после выравнивания позы покоя — от них меряются ограничения
  limited = new Set<string>();
  constructor(readonly rig: Rig, readonly project: Project) {}

  /** Ограничения проекта: каждый поворот — в свой диапазон (поверх выравнивания позы покоя). */
  /** only — только эти кости (после вторичной динамики: колени, согнутые IK пола, второй раз не трогаем). */
  applyLimits(only?: Set<string>) {
    for (const [bone, lim] of Object.entries(this.project.limits ?? {})) {
      if (only && !only.has(bone)) continue;
      const d = this.rot.get(bone);
      if (!d || !this.rig.index.has(bone)) continue;
      const r = clampRotation(this.rig, this.project, bone, lim, d, this.base.get(bone));
      if (r.hit) {
        this.rot.set(bone, r.d);
        this.limited.add(bone);
      }
    }
  }

  add(bone: string, ch: Channel, v: number, axes: () => Record<SemanticAxis, Vec3>) {
    const i = this.rig.index.get(bone);
    if (i == null || v === (ch.startsWith("scale_") ? 1 : 0)) return;
    if (ch === "lateral" || ch === "vertical" || ch === "roll" || ch === "pitch" || ch === "yaw" || ch === "bank") {
      const f = bodyFrame(this.project);
      const axis = ch === "pitch" ? f.side : ch === "yaw" ? f.up : ch === "bank" ? f.forward : axes()[ch];
      this.turn(bone, localDelta(this.rig, i, axis, v * DEG));
    } else if (ch.startsWith("move_")) {
      const f = bodyFrame(this.project);
      const dir = ch === "move_up" ? f.up : ch === "move_forward" ? f.forward : f.side;
      this.move.set(bone, vadd(this.move.get(bone) ?? [0, 0, 0], vscale(dir, v)));
    } else {
      const s = this.scale.get(bone) ?? [1, 1, 1];
      const k = ch === "scale_up" ? 0 : ch === "scale_forward" ? 1 : 2;
      s[k] *= v;
      this.scale.set(bone, s);
    }
  }

  /** Добавить поворот (дельту в локальных осях rest) ПОСЛЕ уже накопленных: следующий слой действует на результат
   * предыдущих — так выравнивание позы и мах руки идут в правильном порядке. */
  turn(bone: string, d: Quat) {
    this.rot.set(bone, qnorm(qmul(d, this.rot.get(bone) ?? QI)));
  }

  /** Задать итоговый локальный поворот кости (в дельту относительно rest). */
  setLocal(bone: string, q: Quat) {
    const rest = this.rig.skel.nodes[this.rig.index.get(bone)!].restR;
    this.rot.set(bone, qnorm(qmul(qinv(rest), q)));
  }

  parts(): PoseParts {
    const { rig } = this;
    const out: PoseParts = { rot: new Map(), pos: new Map(), scl: new Map() };
    for (const [bone, d] of this.rot) out.rot.set(bone, qnorm(qmul(rig.skel.nodes[rig.index.get(bone)!].restR, d)));
    for (const [bone, m] of this.move) {
      const i = rig.index.get(bone)!;
      const p = rig.parent[i];
      // сдвиг в осях родителя (по его rest-повороту и масштабу: у корня FBX в 0.01 метр — это 100 локальных единиц)
      const local = p < 0 ? m : vdiv(qrot(qinv(rig.worldR[p]), m), rig.worldS[p]);
      out.pos.set(bone, vadd(rig.skel.nodes[i].restT, local));
    }
    const f = bodyFrame(this.project);
    for (const [bone, s] of this.scale) {
      const i = rig.index.get(bone)!;
      const r = vmul(rig.skel.nodes[i].restS, [1, 1, 1]) as Vec3;
      // каждое направление тела — на ту локальную ось кости, что к нему ближе
      [f.up, f.forward, f.side].forEach((dir, k) => {
        if (s[k] === 1) return;
        const local = qrot(qinv(rig.worldR[i]), dir);
        const ax = [0, 1, 2].reduce((best, j) => (Math.abs(local[j]) > Math.abs(local[best]) ? j : best), 0);
        r[ax] *= s[k];
      });
      out.scl.set(bone, r);
    }
    return out;
  }
}

/** Мировые позиции и повороты всех узлов для локальной позы (прямая кинематика; масштаб родителя растягивает сдвиги детей). */
export function worldPose(rig: Rig, parts: PoseParts): { T: Vec3[]; R: Quat[] } {
  const T: Vec3[] = [], R: Quat[] = [], S: Vec3[] = [];
  rig.skel.nodes.forEach((n, i) => {
    const lt = parts.pos.get(n.name) ?? n.restT;
    const lr = parts.rot.get(n.name) ?? n.restR;
    const ls = parts.scl.get(n.name) ?? n.restS;
    const p = rig.parent[i];
    if (p < 0) {
      T[i] = lt; R[i] = lr; S[i] = ls;
    } else {
      T[i] = vadd(T[p], qrot(R[p], vmul(S[p], lt)));
      R[i] = qnorm(qmul(R[p], lr));
      S[i] = vmul(S[p], ls);
    }
  });
  return { T, R };
}

/** Верхняя кость скелета над данной (её двигает постановка на пол). */
function skeletonRoot(rig: Rig, i: number): number {
  let r = i;
  for (let p = rig.parent[i]; p >= 0; p = rig.parent[p]) if (rig.skel.nodes[p].isJoint) r = p;
  return r;
}

const isSecondary = (l: Clip["layers"][number]) => l.type === "recipe" && !!RECIPES[l.recipe]?.secondary;

/** Высота кости над самой нижней костью скелета в rest (для рецептов, которым нужен масштаб тела). */
const SIZE = "\u0000size"; // рост скелета — в той же таблице, под именем, которого не бывает у костей
function restHeights(rig: Rig, project: Project): Map<string, number> {
  const up = bodyFrame(project).up;
  const hs = rig.skel.nodes.map((n, i) => (n.isJoint ? vdot(rig.worldT[i], up) : Infinity));
  const floor = Math.min(...hs);
  const m = new Map(rig.skel.nodes.map((n, i) => [n.name, Number.isFinite(hs[i]) ? hs[i] - floor : 0]));
  m.set(SIZE, Math.max(0, ...m.values()));
  return m;
}
const heightCache = new WeakMap<Rig, Map<string, number>>();

/** Живые связки из игры (аддон Godot): рельеф под стопами и цели констрейнов. Ядро считает с ними так же, как аддон,
 * поэтому сверка с Godot проверяет и их. */
export interface LiveOpts {
  /** высота пола (по up, в координатах модели) под стопой bone, стоящей сейчас в F; rest — её высота в позе покоя */
  floor?: (bone: string, F: Vec3, rest: number) => number;
  /** цели констрейнов по id — точка в координатах модели (взгляд на игрока, рука к рычагу) */
  targets?: Record<string, Vec3>;
}

// ── стиль походки (clip.gait) ────────────────────────────────────────────────────────────────────────────────
/** Частота шагов от скорости: speed^0.6, длина шага — speed^0.4. The Witcher, шаг → бег у 13 наборов: скорость
 * ×1.98, период ×0.65 (частота ×1.54 = 1.98^0.63), шаг ×1.32 (= 1.98^0.41) — research/directions.md. */
export const gaitCadence = (g?: GaitStyle) => (g?.speed && g.speed !== 1 ? g.speed ** 0.6 : 1);
const gaitStride = (g?: GaitStyle) => (g?.speed && g.speed !== 1 ? g.speed ** 0.4 : 1);

/** Средние за цикл повороты и сдвиги костей, которые стиль масштабирует (клип без стиля). */
const gaitCache = new WeakMap<Rig, Map<string, { rot: Map<string, Vec3>; up: Map<string, number> }>>();
const rotvec = (q: Quat): Vec3 => {
  const d: Quat = q[3] < 0 ? [-q[0], -q[1], -q[2], -q[3]] : q;
  const s = Math.hypot(d[0], d[1], d[2]);
  if (s < 1e-12) return [0, 0, 0];
  const a = 2 * Math.atan2(s, d[3]);
  return [(d[0] / s) * a, (d[1] / s) * a, (d[2] / s) * a];
};
const fromvec = (v: Vec3): Quat => { const a = Math.hypot(...v); return a < 1e-12 ? QI : qaxis(vscale(v, 1 / a), a); };

function gaitBones(project: Project) {
  const first = (c?: string[]) => (c?.length ? [c[0]] : []);
  const legs = Object.entries(project.chains).filter(([n]) => /^leg_/.test(n)).map(([, c]) => c);
  const arms = Object.entries(project.chains).filter(([n]) => /^arm_/.test(n)).map(([, c]) => c);
  return { pelvis: first(project.chains.pelvis), hips: legs.flatMap((c) => first(c)), knees: legs.flatMap((c) => (c.length > 1 ? [c[1]] : [])), arms: arms.flat() };
}

function gaitMeans(project: Project, rig: Rig, clip: Clip) {
  let cache = gaitCache.get(rig);
  if (!cache) gaitCache.set(rig, (cache = new Map()));
  const base: Clip = { ...clip, gait: undefined, travel: undefined, ground: undefined, constraints: undefined };
  const key = JSON.stringify(base);
  const hit = cache.get(key);
  if (hit) return hit;
  const b = gaitBones(project);
  const bones = [...b.pelvis, ...b.hips, ...b.knees, ...b.arms];
  const up = bodyFrame(project).up;
  const rot = new Map<string, Vec3>(bones.map((x) => [x, [0, 0, 0] as Vec3]));
  const lift = new Map<string, number>(b.pelvis.map((x) => [x, 0]));
  const N = 48;
  for (let k = 0; k < N; k++) {
    const acc = primary(project, rig, base, (base.duration * k) / N);
    for (const x of bones) rot.set(x, vadd(rot.get(x)!, vscale(rotvec(qmul(acc.rot.get(x) ?? QI, qinv(acc.base.get(x) ?? QI))), 1 / N)));
    for (const x of b.pelvis) lift.set(x, lift.get(x)! + vdot(acc.move.get(x) ?? [0, 0, 0], up) / N);
  }
  const out = { rot, up: lift };
  if (cache.size > 256) cache.clear();
  cache.set(key, out);
  return out;
}

/** Стиль походки поверх слоёв: размахи — вокруг своего среднего за цикл (подскок ×0 — таз на средней высоте),
 * постоянные — наклон, сутулость, колея, таз ниже. */
function applyGait(acc: Acc, rig: Rig, project: Project, clip: Clip, size: number) {
  const g = clip.gait!;
  const f = bodyFrame(project);
  const b = gaitBones(project);
  const mean = gaitMeans(project, rig, clip);
  // поворот кости — вокруг среднего: m' = exp(k·log(m·μ⁻¹))·μ
  const scale = (bone: string, k: number) => {
    if (k === 1 || !acc.rot.has(bone)) return;
    const base = acc.base.get(bone) ?? QI;
    const mu = fromvec(mean.rot.get(bone) ?? [0, 0, 0]);
    const m = qmul(acc.rot.get(bone)!, qinv(base));
    const dev = qmul(m, qinv(mu));
    acc.rot.set(bone, qnorm(qmul(qmul(fromvec(vscale(rotvec(dev), k)), mu), base)));
  };
  for (const x of b.pelvis) {
    scale(x, g.sway ?? 1);
    const k = g.bounce ?? 1;
    // сдвига нет — это тоже значение (подскок рецепта ровно 0 в этот миг), а не «нечего масштабировать»
    const mv = acc.move.get(x) ?? [0, 0, 0];
    if (k !== 1 && Math.abs(mean.up.get(x) ?? 0) + Math.hypot(...mv) > 1e-12) {
      const h = vdot(mv, f.up), mu = mean.up.get(x) ?? 0;
      acc.move.set(x, vadd(mv, vscale(f.up, (mu + k * (h - mu)) - h)));
    }
  }
  for (const x of b.arms) scale(x, g.arms ?? 1);
  for (const x of b.hips) scale(x, gaitStride(g));
  for (const x of b.knees) scale(x, g.lift ?? 1);
  if (g.width) {
    const pi = b.pelvis.length ? rig.index.get(b.pelvis[0]) : undefined;
    const k = Math.sign(vdot(vcross(f.forward, vscale(f.up, -1)), f.side)) || 1;
    for (const x of b.hips) {
      const i = rig.index.get(x);
      if (i == null) continue;
      const side = Math.sign(vdot(vsub(rig.worldT[i], pi != null ? rig.worldT[pi] : [0, 0, 0]), f.side)) || 1;
      acc.turn(x, localDelta(rig, i, f.forward, g.width * side * k * DEG));
    }
  }
  if (g.lower && b.pelvis.length) {
    const ri = rig.index.get(b.pelvis[0]);
    if (ri != null) acc.add(rig.skel.nodes[skeletonRoot(rig, ri)].name, "move_up", -g.lower * size, () => ({ lateral: f.up, vertical: f.up, roll: f.up }));
  }
  // наклон и сутулость — грудью (вперёд — плюс pitch: верх цепочки уходит по ходу); сутулость голова возвращает
  const chest = project.chains.chest?.[0], head = project.chains.head?.[0];
  const bend = (g.lean ?? 0) + (g.posture ?? 0);
  if (chest && bend && rig.index.has(chest)) acc.turn(chest, localDelta(rig, rig.index.get(chest)!, f.side, bend * DEG));
  if (head && g.posture && rig.index.has(head)) acc.turn(head, localDelta(rig, rig.index.get(head)!, f.side, -g.posture * DEG));
}

/** Куда идёт клип: вперёд тела, повёрнутое на travel.angle вокруг up. По нему меряются опора и скорость. */
export function travelDir(project: Project, clip: Clip): Vec3 {
  const f = bodyFrame(project);
  return clip.travel?.angle ? vnorm(qrot(qaxis(f.up, clip.travel.angle * DEG), f.forward)) : f.forward;
}

const isAncestor = (rig: Rig, a: number, i: number) => { for (let p = rig.parent[i]; p >= 0; p = rig.parent[p]) if (p === a) return true; return false; };

/** Ход под углом (Travel): таз к ходу, грудь и голова — обратно к цели; у каждой ноги (цепочки leg_*) мах её
 * основания поворачивается вокруг вертикали (сопряжение: R·m·R⁻¹ — ось маха вертится, колено гнётся как было),
 * потом стопа доворачивается по ходу и нога отводится вбок. Углы итоговые: плоскость маха = angle, стопы = feet —
 * с учётом того, что ноги — дети таза и уже повернулись вместе с ним. */
function applyTravel(acc: Acc, rig: Rig, project: Project, tr: Travel) {
  const f = bodyFrame(project);
  const hips = tr.hips ?? 0, feet = tr.feet ?? 0;
  const pelvis = project.chains.pelvis?.[0], chest = project.chains.chest?.[0], head = project.chains.head?.[0];
  const pi = pelvis != null ? rig.index.get(pelvis) : undefined;
  const ci = chest != null ? rig.index.get(chest) : undefined;
  const hi = head != null ? rig.index.get(head) : undefined;
  const under = (i: number | undefined) => (pi != null && i != null && isAncestor(rig, pi, i) ? 1 : 0);
  if (pi != null && hips) acc.turn(pelvis!, localDelta(rig, pi, f.up, hips * DEG));
  // плечи на цель: грудь гасит долю поворота таза, голова — долю оставшегося
  const chestBack = (tr.chest ?? 0) * hips * under(ci);
  if (ci != null && chestBack) acc.turn(chest!, localDelta(rig, ci, f.up, -chestBack * DEG));
  const rest = hips * under(hi) - (ci != null && hi != null && isAncestor(rig, ci, hi) ? chestBack : 0);
  if (hi != null && tr.look && rest) acc.turn(head!, localDelta(rig, hi, f.up, -(tr.look ?? 0) * rest * DEG));
  for (const [name, chain] of Object.entries(project.chains)) {
    if (!/^leg_/.test(name) || !chain.length) continue;
    const i = rig.index.get(chain[0]);
    if (i == null) continue;
    const bone = chain[0];
    const base = acc.base.get(bone) ?? QI;
    const m = qscale(qmul(acc.rot.get(bone) ?? QI, qinv(base)), tr.stride ?? 1);
    // мах — в плоскость angle: стопы потом довернутся на (feet − то, что дал таз), и плоскость повернётся с ними
    const A = localDelta(rig, i, f.up, ((tr.swing ?? tr.angle) - feet) * DEG);
    acc.rot.set(bone, qnorm(qmul(qmul(qmul(A, m), qinv(A)), base)));
    const twist = feet - hips * under(i);
    if (twist) acc.turn(bone, localDelta(rig, i, f.up, twist * DEG));
    if (tr.width) {
      // отвести наружу: в какую сторону от таза нога, туда и стопа (знак — от того, куда поворот вокруг forward уводит низ)
      const side = Math.sign(vdot(vsub(rig.worldT[i], pi != null ? rig.worldT[pi] : [0, 0, 0]), f.side)) || 1;
      const k = Math.sign(vdot(vcross(f.forward, vscale(f.up, -1)), f.side)) || 1;
      acc.turn(bone, localDelta(rig, i, f.forward, tr.width * side * k * DEG));
    }
  }
}

/** Среднее кривых рецепта за период — для размаха layer.shape.amount (48 отсчётов, как в аддоне Godot). */
const shapeCache = new Map<string, Record<string, number>>();
function shapeMean(recipe: string, p: Record<string, unknown>, i: number, n: number, per: number, hc: { height: number; size: number }): Record<string, number> {
  const key = `${recipe}|${JSON.stringify(p)}|${i}|${n}|${per}|${hc.height}|${hc.size}`;
  let m = shapeCache.get(key);
  if (m) return m;
  m = {};
  const N = 48;
  for (let k = 0; k < N; k++) for (const [ch, v] of Object.entries(RECIPES[recipe].evaluate(p as never, i, n, (per * k) / N, hc))) m[ch] = (m[ch] ?? 0) + (v as number) / N;
  if (shapeCache.size > 512) shapeCache.clear();
  shapeCache.set(key, m);
  return m;
}

/** Основные слои (без вторичной динамики) и постановка на пол. */
function primary(project: Project, rig: Rig, clip: Clip, t: number, opts: LiveOpts = {}): Acc {
  const tClip = t; // фиксация стопы — по времени клипа, как её план (реверс уже внутри плана)
  if (clip.travel?.reverse) t = clip.duration - t;
  // стиль походки: быстрее — слои идут быстрее, клип (его длину clip.gait уже поделил) — вмещает те же шаги
  const cad = gaitCadence(clip.gait);
  const src = clip;
  if (cad !== 1) { t *= cad; clip = { ...clip, duration: clip.duration * cad }; }
  const acc = new Acc(rig, project);
  let heights = heightCache.get(rig);
  if (!heights) heightCache.set(rig, (heights = restHeights(rig, project)));
  if (project.align) alignRest(acc, rig, project);
  for (const [b, q] of acc.rot) acc.base.set(b, q);
  for (const layer of clip.layers) {
    if (isSecondary(layer)) continue;
    if (layer.type === "recipe") {
      const def = RECIPES[layer.recipe];
      const chain = project.chains[layer.target.chain];
      if (!def || !chain) continue;
      const p = withDefaults(def, layer.params);
      let axes: Record<SemanticAxis, Vec3> | undefined;
      const getAxes = () => (axes ??= chainAxes(rig, project, chain));
      const w = layer.weight ?? 1;
      const sh = layer.shape;
      // правка кривой (layer.shape): late и step — в долях периода рецепта (у разовых — длины клипа)
      const per = typeof p.period === "number" ? p.period : clip.duration;
      chain.forEach((bone, i) => {
        const hc = { height: heights!.get(bone) ?? 0, size: heights!.get(SIZE) ?? 0 };
        let tt = t;
        if (sh?.late || sh?.step) {
          tt = t - ((sh.late ?? 0) + (sh.step ?? 0) * i) * per;
          if (!clip.loop) tt = Math.max(0, tt);
        }
        const out = def.evaluate(p, i, chain.length, tt, hc);
        const mean = sh?.amount != null && sh.amount !== 1 ? shapeMean(layer.recipe, p, i, chain.length, per, hc) : undefined;
        for (const [ch, v0] of Object.entries(out)) {
          // размах (amount) — вокруг среднего этой кривой за период: подъём колена остаётся, качание растёт
          const m = mean?.[ch] ?? 0;
          const v = mean ? m + sh!.amount! * ((v0 as number) - m) : (v0 as number);
          // вес слоя: для углов и сдвигов — множитель, для масштаба — доля пути от 1 до значения
          const val = ch.startsWith("scale_") ? 1 + (v - 1) * w : v * w;
          acc.add(bone, ch as Channel, val, getAxes);
        }
      });
    } else if (layer.type === "pose") {
      applyPose(acc, layer, t, clip);
    } else {
      for (const tr of layer.tracks) {
        const chain = chainOf(project, tr.bone) ?? [tr.bone];
        const v = evalKeys(tr.keys, t, clip.loop, clip.duration);
        acc.add(tr.bone, tr.axis, tr.axis.startsWith("scale_") ? 1 + v : v, () => chainAxes(rig, project, chain.length > 1 ? chain : [tr.bone]));
      }
    }
  }
  if (src.gait) applyGait(acc, rig, project, src, heights.get(SIZE) ?? 1);
  clip = src;
  if (clip.travel) applyTravel(acc, rig, project, clip.travel);
  // ограничения — до постановки на пол: ноги встают на пол уже в разрешённой позе
  if (project.limits) acc.applyLimits();
  const g = clip.ground;
  if (g?.bones.length) {
    // рельеф: пол под каждой стопой выше или ниже покоя на off; тело опускается к самой низкой опоре,
    // остальные стопы поднимает IK — как в играх (Unreal foot placement)
    const off = opts.floor ? terrain(acc, rig, project, g, opts.floor) : undefined;
    // contact: сначала опустить тело до касания, потом IK поднимает провалившиеся ступни; floor: наоборот
    if (g.mode === "contact") ground(acc, rig, project, g, off);
    if (g.ik) for (const b of g.bones) footIK(acc, rig, project, b, off?.get(b) ?? 0);
    if (g.mode === "floor") ground(acc, rig, project, g, off);
    if (g.flat) for (const b of g.bones) flatFoot(acc, rig, project, b, off?.get(b) ?? 0);
    if (g.lock && clip.loop) footLock(acc, rig, project, clip, tClip, off);
  }
  if (clip.constraints?.some((c) => !c.muted)) {
    for (const c of clip.constraints) if (!c.muted) solveConstraint(acc, rig, project, clip, c, t, opts.targets);
    if (project.limits) acc.applyLimits(); // взгляд и IK — тоже в анатомических пределах
  }
  return acc;
}

/** Слой поз в момент t: между ключами — сферическая интерполяция поворотов и линейная сдвигов (smooth — с плавным
 * разгоном и торможением). Кость, которой нет в ключе, в нём без добавки. */
export function samplePose(layer: PoseLayer, t: number, clip: Clip): { rot: Record<string, Quat>; move: Record<string, Vec3> } {
  const out = { rot: {} as Record<string, Quat>, move: {} as Record<string, Vec3> };
  const ks = [...layer.keys].sort((a, b) => a.t - b.t);
  if (!ks.length) return out;
  if (clip.loop && clip.duration > 0) t = ((t % clip.duration) + clip.duration) % clip.duration;
  let a = ks[0], b = ks[0], u = 0;
  if (t >= ks[ks.length - 1].t) a = b = ks[ks.length - 1];
  else if (t > ks[0].t) {
    let i = 0;
    while (ks[i + 1].t < t) i++;
    (a = ks[i]), (b = ks[i + 1]);
    u = (t - a.t) / (b.t - a.t);
    const mode = a.interp ?? "smooth";
    u = mode === "step" ? 0 : mode === "linear" ? u : u * u * (3 - 2 * u);
  }
  for (const bone of new Set([...Object.keys(a.rot ?? {}), ...Object.keys(b.rot ?? {})])) {
    const qa = a.rot?.[bone] ?? QI, qb = b.rot?.[bone] ?? QI;
    out.rot[bone] = qnorm(qmul(qscale(qmul(qb, qinv(qa)), u), qa));
  }
  for (const bone of new Set([...Object.keys(a.move ?? {}), ...Object.keys(b.move ?? {})])) {
    const va = a.move?.[bone] ?? [0, 0, 0], vb = b.move?.[bone] ?? [0, 0, 0];
    out.move[bone] = vadd(va, vscale(vsub(vb, va), u));
  }
  return out;
}

/** Добавить к ключу позы в момент t добавки reach (ключа нет — создаётся с тем, что там было по интерполяции,
 * слоя нет — создаётся). Меняет clip. */
export function addPoseDelta(clip: Clip, t: number, r: { rot: Record<string, Quat>; move: Record<string, Vec3> }) {
  let l = clip.layers.find((l) => l.type === "pose") as PoseLayer | undefined;
  if (!l) clip.layers.push((l = { id: "pose", type: "pose", keys: [] }));
  let k = l.keys.find((k) => Math.abs(k.t - t) < 1e-6);
  if (!k) {
    const cur = samplePose(l, t, clip);
    k = { t };
    if (Object.keys(cur.rot).length) k.rot = cur.rot;
    if (Object.keys(cur.move).length) k.move = cur.move;
    l.keys.push(k);
    l.keys.sort((x, y) => x.t - y.t);
  }
  for (const [b, q] of Object.entries(r.rot)) (k.rot ??= {})[b] = qnorm(qmul(q, k.rot?.[b] ?? QI));
  for (const [b, v] of Object.entries(r.move)) (k.move ??= {})[b] = vadd(k.move?.[b] ?? [0, 0, 0], v);
  return k;
}

function applyPose(acc: Acc, layer: PoseLayer, t: number, clip: Clip) {
  const p = samplePose(layer, t, clip);
  for (const [bone, q] of Object.entries(p.rot)) if (acc.rig.index.has(bone)) acc.turn(bone, q);
  for (const [bone, v] of Object.entries(p.move)) if (acc.rig.index.has(bone)) acc.move.set(bone, vadd(acc.move.get(bone) ?? [0, 0, 0], v));
}

/** IK цепочки любой длины (CCD): от кости у кончика к основанию каждая поворачивается так, чтобы кончик шёл
 * к цели, и сразу укладывается в свои пределы — поэтому, если локоть упёрся, догибает плечо и корпус, а не
 * обрезает позу после. chain — кости от основания к последней сгибаемой; effector — где сейчас кончик. */
function ccd(acc: Acc, rig: Rig, project: Project, chain: number[], effector: (w: { T: Vec3[]; R: Quat[] }) => Vec3, P: Vec3, iterations = 200) {
  // считаем только по цепочке: мировые повороты костей и смещения до следующей кости (и до кончика) в их осях —
  // остальной скелет на кончик не влияет, полный пересчёт позы на каждом шаге не нужен
  const n = chain.length;
  const w = worldPose(rig, acc.parts());
  const p0 = rig.parent[chain[0]];
  const Rbase = p0 >= 0 ? w.R[p0] : QI, J0 = w.T[chain[0]];
  const names = chain.map((i) => rig.skel.nodes[i].name);
  const rest = chain.map((i) => rig.skel.nodes[i].restR);
  const d = names.map((nm) => acc.rot.get(nm) ?? QI);
  const E0 = effector(w);
  const offs = chain.map((i, k) => qrot(qinv(w.R[i]), vsub(k + 1 < n ? w.T[chain[k + 1]] : E0, w.T[i])));
  const W: Quat[] = new Array(n), J: Vec3[] = new Array(n + 1);
  const forward = (from = 0) => {
    for (let k = from; k < n; k++) {
      W[k] = qnorm(qmul(qmul(k ? W[k - 1] : Rbase, rest[k]), d[k]));
      J[k + 1] = vadd(k ? J[k] : J0, qrot(W[k], offs[k]));
      if (k === 0) J[0] = J0;
    }
  };
  J[0] = J0;
  forward();
  const scale = Math.max(1e-9, ...offs.map((o) => Math.hypot(...o)));
  for (let it = 0; it < iterations; it++) {
    for (let k = n - 1; k >= 0; k--) {
      const q = qbetween(vsub(J[n], J[k]), vsub(P, J[k]));
      const Wp = k ? W[k - 1] : Rbase;
      // новый мировой поворот q·W → дельта к позе покоя, сразу в пределы сустава
      let dk = qnorm(qmul(qinv(rest[k]), qmul(qinv(Wp), qmul(q, W[k]))));
      const lim = project.limits?.[names[k]];
      if (lim) dk = clampRotation(rig, project, names[k], lim, dk, acc.base.get(names[k])).d;
      d[k] = dk;
      forward(k);
    }
    if (Math.hypot(...vsub(J[n], P)) < 1e-6 * scale) break;
  }
  names.forEach((nm, k) => acc.rot.set(nm, d[k]));
}

/** Кости IK: от кончика вверх length штук (у end — считая саму tip). */
function ikChain(rig: Rig, tip: number, length: number, end: boolean): number[] {
  const out: number[] = [];
  let i = end ? tip : rig.parent[tip];
  while (i >= 0 && out.length < length && rig.skel.nodes[i].isJoint) {
    out.unshift(i);
    i = rig.parent[i];
  }
  return out;
}

/** Где цель констрейна в момент t (мировые координаты модели). */
export function targetAt(rig: Rig, parts: PoseParts | null, clip: Clip, tg: ConstraintTarget, t: number): Vec3 | null {
  let p: Vec3 | null = null;
  if (tg.keys?.length) {
    const ks = tg.keys;
    p = [0, 1, 2].map((k) => evalKeys(ks.map((x) => ({ t: x.t, v: x.pos[k], interp: x.interp })), t, clip.loop, clip.duration)) as Vec3;
  } else if (tg.bone) {
    const i = rig.index.get(tg.bone);
    if (i == null) return null;
    p = parts ? worldPose(rig, parts).T[i] : rig.worldT[i];
  } else if (tg.pos) p = tg.pos;
  if (!p) return null;
  return tg.offset ? vadd(p, tg.offset) : p;
}

function solveConstraint(acc: Acc, rig: Rig, project: Project, clip: Clip, c: Constraint, t: number, targets?: Record<string, Vec3>) {
  if (c.type === "copy") return copyRotation(acc, rig, project, c.bones, c.source, c.weight ?? 1, !!c.mirror);
  const P = targets?.[c.id] ?? targetAt(rig, c.target.bone ? acc.parts() : null, clip, c.target, t);
  if (!P) return;
  const w = Math.max(0, Math.min(1, c.weight ?? 1));
  if (w === 0) return;
  if (c.type === "ik") {
    const len = c.length ?? 2;
    const fi = rig.index.get(c.tip);
    if (fi == null) return;
    const chain = ikChain(rig, fi, len, !!c.end);
    const limited = chain.some((i) => project.limits?.[rig.skel.nodes[i].name]);
    // рука или нога без пределов — точная формула; иначе (длиннее или с пределами) — CCD, с формулы как начала
    if (len === 2 && !limited) return twoBoneIK(acc, rig, project, c.tip, P, c.pole, w, !!c.end);
    const before = new Map(chain.map((i) => [i, acc.rot.get(rig.skel.nodes[i].name) ?? QI]));
    solveLimited(acc, rig, project, chain, fi, !!c.end, P, c.pole);
    if (w < 1)
      for (const [i, q0] of before) {
        const n = rig.skel.nodes[i].name, q1 = acc.rot.get(n) ?? QI;
        acc.rot.set(n, qnorm(qmul(qscale(qmul(q1, qinv(q0)), w), q0)));
      }
    return;
  }
  else aim(acc, rig, project, c.bones, P, w);
}

/** Копия поворота: движение источника (дельта к позе покоя и выравниванию) в мировых осях позы покоя —
 * той же оси и на тот же угол·weight поворачивается кость (поверх её собственной анимации). */
function copyRotation(acc: Acc, rig: Rig, project: Project, bones: string[], source: string[], weight: number, mirror: boolean) {
  const side = bodyFrame(project).side;
  bones.forEach((bone, k) => {
    const src = source[k], i = rig.index.get(bone), j = src ? rig.index.get(src) : undefined;
    if (i == null || j == null) return;
    const d = acc.rot.get(src) ?? QI;
    let m = qmul(qmul(rig.worldR[j], qmul(d, qinv(acc.base.get(src) ?? QI))), qinv(rig.worldR[j]));
    if (mirror) {
      // отражение через плоскость с нормалью side: ось отражается, угол меняет знак
      const v: Vec3 = [m[0], m[1], m[2]];
      const r = vsub(v, vscale(side, 2 * vdot(v, side)));
      m = [-r[0], -r[1], -r[2], m[3]];
    }
    const add = qscale(m, weight);
    acc.turn(bone, qnorm(qmul(qmul(qinv(rig.worldR[i]), add), rig.worldR[i])));
  });
}

const HINGE = Symbol("hinge");
type HingeSeed = { axis: Vec3; range: [number, number]; k: number; fr: ReturnType<typeof limitFrame> };

/** Точное начало для шарнира (локоть, колено с пределом): сгибаем среднюю кость вокруг её оси сгиба — той, по
 * которой разрешён широкий диапазон, — ровно настолько, чтобы расстояние основание→кончик стало как до цели
 * (угол ищем перебором внутри диапазона), потом поворачиваем основание, чтобы кончик лёг в цель. Формула
 * twoBoneIK гнёт в своей плоскости и у шарнира с поперечной осью упирается в предел. */
function hingeIK(acc: Acc, rig: Rig, project: Project, chain: number[], eff: (w: { T: Vec3[]; R: Quat[] }) => Vec3, P: Vec3, h: HingeSeed) {
  const [ti, si] = chain;
  const w = worldPose(rig, acc.parts());
  const H = w.T[ti], K = w.T[si], F = eff(w);
  const d = Math.hypot(...vsub(P, H));
  const name = rig.skel.nodes[si].name;
  const now = decompose(qmul(acc.rot.get(name) ?? QI, qinv(acc.base.get(name) ?? QI)), h.fr.axes)[h.k];
  const at = (deg: number) => vadd(K, qrot(qaxis(h.axis, (deg - now) * DEG), vsub(F, K)));
  const cost = (deg: number) => Math.abs(Math.hypot(...vsub(at(deg), H)) - d);
  let bestDeg = now, bestCost = cost(now);
  const [lo, hi] = [Math.min(...h.range), Math.max(...h.range)];
  for (let k = 0; k <= 96; k++) {
    const g = lo + ((hi - lo) * k) / 96, c = cost(g);
    if (c < bestCost) (bestCost = c), (bestDeg = g);
  }
  // уточнение золотым сечением вокруг лучшей точки
  let a = Math.max(lo, bestDeg - (hi - lo) / 96), b = Math.min(hi, bestDeg + (hi - lo) / 96);
  for (let it = 0; it < 40; it++) {
    const m1 = b - (b - a) / 1.618, m2 = a + (b - a) / 1.618;
    if (cost(m1) < cost(m2)) b = m2;
    else a = m1;
  }
  const deg = (a + b) / 2;
  const q1 = qaxis(h.axis, (deg - now) * DEG);
  const F1 = vadd(K, qrot(q1, vsub(F, K)));
  let q2 = qbetween(vsub(F1, H), vsub(P, H));
  // поворот вокруг линии основание → цель свободен: берём тот, где локоть ближе всего к тому, где он был
  // в анимации, — иначе локоть может уйти за спину
  const ax = vnorm(vsub(P, H));
  const flat = (v: Vec3) => vsub(v, vscale(ax, vdot(v, ax)));
  const kNow = flat(qrot(q2, vsub(K, H))), kWas = flat(vsub(K, H));
  // локоть почти на линии (рука вытянута к недостижимой цели, сгиб меньше ≈0.6°) — направления у него нет,
  // кручение не трогаем: иначе его задают последние разряды, и в ядре и в Godot (float32) плечо крутится по-разному
  const off = 1e-2 * Math.hypot(...vsub(K, H));
  if (Math.hypot(...kNow) > off && Math.hypot(...kWas) > off) {
    const ang = Math.acos(Math.max(-1, Math.min(1, vdot(vnorm(kNow), vnorm(kWas)))));
    const s = Math.sign(vdot(vcross(kNow, kWas), ax)) || 1;
    q2 = qmul(qaxis(ax, s * ang), q2);
  }
  setTwo(acc, rig, w, ti, si, q2, q1);
}

/** IK цепочки с пределами. У сустава, который гнётся в одну сторону (колено, локоть), CCD легко застревает,
 * если начал сгибать не туда: предел обнуляет сгиб, и выхода нет. Поэтому у руки/ноги пробуем несколько начал —
 * точную формулу со сгибом в разные стороны тела — и берём позу, где кончик ближе к цели (при равенстве — первую:
 * заданный pole или текущая плоскость сгиба). */
function solveLimited(acc: Acc, rig: Rig, project: Project, chain: number[], fi: number, end: boolean, P: Vec3, pole?: Vec3, endLength?: number) {
  const names = chain.map((i) => rig.skel.nodes[i].name);
  const start = names.map((n) => acc.rot.get(n) ?? QI);
  const eff = effectorOf(rig, fi, end, endLength);
  const tip = rig.skel.nodes[fi].name;
  const err = () => Math.hypot(...vsub(eff(worldPose(rig, acc.parts())), P));
  let seeds: (Vec3 | undefined | null | typeof HINGE)[] = [null]; // null — без формулы, просто CCD с текущей позы
  let hingeSeed: HingeSeed | null = null;
  if (chain.length === 2) {
    const w = worldPose(rig, acc.parts());
    const K = w.T[chain[1]], L = Math.hypot(...vsub(w.T[chain[1]], w.T[chain[0]]));
    const f = bodyFrame(project);
    const dirs: Vec3[] = [f.forward, f.up, f.side];
    // шарнир: ось с самым широким диапазоном — сгиб ровно вокруг неё (полюс поперёк оси и кости) пробуем первым
    const lim = project.limits?.[names[1]];
    if (lim) {
      const body = Object.keys(lim).some((k) => k === "pitch" || k === "yaw" || k === "bank");
      const fr = limitFrame(rig, project, names[1], body);
      let best = -1, wide = -1;
      fr.names.forEach((nm, k) => {
        const r = lim[nm];
        const width = nm === "roll" || nm === "yaw" ? -1 : r ? r[1] - r[0] : 360;
        if (k > 0 && width > wide) (wide = width), (best = k);
      });
      if (best > 0) {
        const hinge = qrot(w.R[chain[1]], fr.axes[best]);
        const along = vsub(w.T[chain[1]], w.T[chain[0]]);
        const perp = vcross(hinge, along);
        if (Math.hypot(...perp) > 1e-9) dirs.unshift(vnorm(perp));
        hingeSeed = { axis: hinge, range: lim[fr.names[best]] ?? [-180, 180], k: best, fr };
      }
    }
    seeds = [pole, ...dirs.flatMap((d) => [vadd(K, vscale(d, L)), vadd(K, vscale(d, -L))]), null];
    if (hingeSeed) seeds.unshift(HINGE);
  }
  let best: Quat[] | null = null, bestErr = Infinity;
  // ничья — с допуском от длины цепочки: недостижимую цель все начала дают с одной ошибкой (рука вытянута,
  // отличается лишь кручение), и выбор по шуму последних разрядов давал бы разную позу в ядре и в Godot (float32)
  const span = Math.max(1e-9, Math.hypot(...vsub(rig.worldT[fi], rig.worldT[chain[0]])));
  for (const sd of seeds) {
    names.forEach((n, k) => acc.rot.set(n, start[k]));
    if (sd === HINGE) hingeIK(acc, rig, project, chain, eff, P, hingeSeed!);
    else if (sd !== null) twoBoneIK(acc, rig, project, tip, P, sd, 1, end);
    ccd(acc, rig, project, chain, eff, P);
    const e = err();
    if (e < bestErr - 1e-6 * span) (bestErr = e), (best = names.map((n) => acc.rot.get(n) ?? QI));
    if (bestErr < 1e-5 * span) break;
  }
  names.forEach((n, k) => acc.rot.set(n, best![k]));
}

/** Кончик IK в позе: сама кость или (end) её конец — продолжение на длину родителя. */
export function effectorOf(rig: Rig, fi: number, end: boolean, endLength?: number) {
  const pi = rig.parent[fi];
  let len = pi >= 0 ? vsub(rig.worldT[fi], rig.worldT[pi]) : ([0, 0, 0] as Vec3);
  // длина конца известна (редактор мерит её по коже) — направление то же, длина своя
  if (endLength != null && Math.hypot(...len) > 1e-12) len = vscale(vnorm(len), endLength);
  return (w: { T: Vec3[]; R: Quat[] }): Vec3 => (end ? vadd(w.T[fi], qrot(qmul(w.R[fi], qinv(rig.worldR[fi])), len)) : w.T[fi]);
}

/** Позинг: кость bone тянут в точку P в момент t. Сгибаются length костей над ней (с пределами); length 0 или
 * корень — тело переносится целиком. Возвращает добавки для ключа позы (повороты — как у acc.turn, сдвиги — мир). */
export function reach(project: Project, rig: Rig, clip: Clip, t: number, bone: string, P: Vec3, length = 2, end = false, endLength?: number): { rot: Record<string, Quat>; move: Record<string, Vec3> } {
  const fi = rig.index.get(bone);
  if (fi == null) throw new Error(`нет кости «${bone}»`);
  const acc = primary(project, rig, clip, t);
  // end — тянут конец кости-листа (кисть-варежка, кончик хвоста): сгибается и она сама
  const chain = length > 0 ? ikChain(rig, fi, length, end) : [];
  if (!chain.length) {
    const w = worldPose(rig, acc.parts());
    return { rot: {}, move: { [bone]: vsub(P, w.T[fi]) } };
  }
  const before = new Map(chain.map((i) => [rig.skel.nodes[i].name, acc.rot.get(rig.skel.nodes[i].name) ?? QI]));
  solveLimited(acc, rig, project, chain, fi, end, P, undefined, endLength);
  const rot: Record<string, Quat> = {};
  for (const [n, q0] of before) rot[n] = qnorm(qmul(acc.rot.get(n) ?? QI, qinv(q0)));
  return { rot, move: {} };
}

/** Взгляд: «вперёд» последней кости — на цель; каждая кость от основания берёт свою долю оставшегося поворота. */
function aim(acc: Acc, rig: Rig, project: Project, bones: string[], P: Vec3, weight: number) {
  const idx = bones.map((b) => rig.index.get(b)).filter((i): i is number => i != null);
  if (!idx.length) return;
  const fwd = bodyFrame(project).forward;
  const tip = idx[idx.length - 1];
  for (let k = 0; k < idx.length; k++) {
    const i = idx[k];
    const wp = worldPose(rig, acc.parts());
    const cur = qrot(qmul(wp.R[tip], qinv(rig.worldR[tip])), fwd);
    const want = vsub(P, wp.T[tip]);
    if (Math.hypot(...want) < 1e-9) return;
    // вес: у каждой кости доля weight/(сколько осталось) — при весе 1 последняя доводит взгляд точно на цель
    const q = qscale(qbetween(cur, want), weight / (idx.length - k));
    const pi = rig.parent[i];
    const Rp = pi >= 0 ? wp.R[pi] : QI;
    acc.setLocal(rig.skel.nodes[i].name, qnorm(qmul(qinv(Rp), qmul(q, wp.R[i]))));
  }
}

/** Двухзвенная IK: кончик tip — в точку P (если дотягивается; иначе рука вытягивается к ней). Сгибаются родитель
 * и дед кончика. pole — куда смотрит сгиб; без неё — текущая плоскость сгиба (у прямой — колено вперёд). */
function twoBoneIK(acc: Acc, rig: Rig, project: Project, tip: string, P: Vec3, pole: Vec3 | undefined, weight: number, end = false) {
  const fi = rig.index.get(tip);
  if (fi == null) return;
  // end: кончик — конец самой tip (продолжение на длину родителя), сгибаются tip и родитель
  const si = end ? fi : rig.parent[fi], ti = si >= 0 ? rig.parent[si] : -1;
  if (si < 0 || ti < 0) return;
  const { forward } = bodyFrame(project);
  const w = worldPose(rig, acc.parts());
  const H = w.T[ti], K = w.T[si];
  const F = end ? vadd(K, qrot(qmul(w.R[si], qinv(rig.worldR[si])), vsub(rig.worldT[si], rig.worldT[ti]))) : w.T[fi];
  const a = Math.hypot(...vsub(K, H)), b = Math.hypot(...vsub(F, K));
  if (a < 1e-9 || b < 1e-9) return;
  const d = Math.min(a + b - 1e-6, Math.max(Math.abs(a - b) + 1e-6, Math.hypot(...vsub(P, H))));
  const angle = (x: Vec3, y: Vec3) => Math.acos(Math.max(-1, Math.min(1, vdot(vnorm(x), vnorm(y)))));
  const cur = angle(vsub(H, K), vsub(F, K));
  const want = Math.acos(Math.max(-1, Math.min(1, (a * a + b * b - d * d) / (2 * a * b))));
  let n = vcross(vsub(H, K), vsub(F, K));
  if (Math.hypot(...n) < 1e-6 * a * b) n = vcross(forward, vsub(H, K));
  n = vnorm(n);
  const q1 = qaxis(n, want - cur); // средняя кость: угол сгиба cur → want
  const F1 = vadd(K, qrot(q1, vsub(F, K)));
  let q2 = qbetween(vsub(F1, H), vsub(P, H)); // основание: кончик на линию к цели
  if (pole) {
    // поворот вокруг оси основание → цель, чтобы сгиб смотрел на pole
    const ax = vnorm(vsub(P, H));
    const K2 = vadd(H, qrot(q2, vsub(K, H)));
    const flat = (v: Vec3) => vsub(v, vscale(ax, vdot(v, ax)));
    const kv = flat(vsub(K2, H)), pv = flat(vsub(pole, H));
    // колено на линии (нога вытянута) — сгиб никуда не смотрит, полюс не крутит
    if (Math.hypot(...kv) > 1e-2 * a && Math.hypot(...pv) > 1e-9) {
      const s = Math.sign(vdot(vcross(kv, pv), ax)) || 1;
      q2 = qmul(qaxis(ax, s * angle(kv, pv)), q2);
    }
  }
  // вес < 1 — часть пути от анимации к цели
  setTwo(acc, rig, w, ti, si, qscale(q2, weight), qscale(q1, weight));
}

function setTwo(acc: Acc, rig: Rig, w: { R: Quat[] }, ti: number, si: number, qRoot: Quat, qMid: Quat) {
  const pt = rig.parent[ti];
  const Rp = pt >= 0 ? w.R[pt] : QI;
  const Rt = qmul(qRoot, w.R[ti]);
  acc.setLocal(rig.skel.nodes[ti].name, qnorm(qmul(qinv(Rp), Rt)));
  // средняя кость: сначала свой сгиб (в мире до поворота основания), потом едет вместе с основанием
  acc.setLocal(rig.skel.nodes[si].name, qnorm(qmul(qinv(w.R[ti]), qmul(qMid, w.R[si]))));
}

/** Поворот, переводящий направление a в направление b (кратчайший). */
export function qbetween(a: Vec3, b: Vec3): Quat {
  const u = vnorm(a), v = vnorm(b);
  const c = vdot(u, v);
  if (c > 1 - 1e-12) return QI;
  if (c < -1 + 1e-12) {
    const ax = Math.abs(u[0]) < 0.9 ? vnorm(vcross(u, [1, 0, 0])) : vnorm(vcross(u, [0, 1, 0]));
    return [ax[0], ax[1], ax[2], 0];
  }
  const x = vcross(u, v);
  return qnorm([x[0], x[1], x[2], 1 + c]);
}

/** Двухзвенная IK: ступня (её родитель — голень, дед — бедро) не уходит под пол — колено сгибается ровно настолько,
 * чтобы ступня встала на высоту покоя. Плоскость сгиба сохраняется; у прямой ноги колено идёт вперёд по телу. */
function footIK(acc: Acc, rig: Rig, project: Project, foot: string, off = 0) {
  const fi = rig.index.get(foot);
  if (fi == null) return;
  const si = rig.parent[fi], ti = si >= 0 ? rig.parent[si] : -1;
  if (si < 0 || ti < 0) return;
  const { up, forward } = bodyFrame(project);
  const w = worldPose(rig, acc.parts());
  const H = w.T[ti], K = w.T[si], F = w.T[fi];
  const floor = vdot(rig.worldT[fi], up) + off;
  const h = vdot(F, up);
  if (h >= floor - 1e-9) return;
  const P = vadd(F, vscale(up, floor - h));
  const a = Math.hypot(...vsub(K, H)), b = Math.hypot(...vsub(F, K));
  const d = Math.min(a + b - 1e-6, Math.max(Math.abs(a - b) + 1e-6, Math.hypot(...vsub(P, H))));
  const angle = (x: Vec3, y: Vec3) => Math.acos(Math.max(-1, Math.min(1, vdot(vnorm(x), vnorm(y)))));
  const cur = angle(vsub(H, K), vsub(F, K));
  const want = Math.acos(Math.max(-1, Math.min(1, (a * a + b * b - d * d) / (2 * a * b))));
  let n = vcross(vsub(H, K), vsub(F, K));
  const straight = Math.hypot(...n) < 1e-6 * a * b;
  // у прямой ноги ось сгиба — бок тела; знак выбираем так, чтобы колено ушло вперёд
  if (straight) n = vcross(forward, vsub(H, K));
  n = vnorm(n);
  const q1 = qaxis(n, want - cur); // голень вокруг колена: угол в колене cur → want
  const F1 = vadd(K, qrot(q1, vsub(F, K)));
  const q2 = qbetween(vsub(F1, H), vsub(P, H)); // бедро вокруг таза: ступня в цель
  const pt = rig.parent[ti];
  const Rp = pt >= 0 ? w.R[pt] : QI;
  acc.setLocal(rig.skel.nodes[ti].name, qnorm(qmul(qinv(Rp), qmul(q2, w.R[ti]))));
  acc.setLocal(rig.skel.nodes[si].name, qnorm(qmul(qinv(w.R[ti]), qmul(q1, w.R[si]))));
}

/** Опорная стопа плоско: у пола (не выше 2 % роста бедра над своей высотой покоя) наклон стопы относительно пола
 * снимается — её «верх» из позы покоя снова смотрит вверх, разворот вокруг вертикали остаётся. Выше — плавно
 * отпускается до половины к 6 %: в переносе стопа гнётся вдвое меньше, чем по рецепту. */
function flatFoot(acc: Acc, rig: Rig, project: Project, foot: string, off = 0) {
  const fi = rig.index.get(foot);
  if (fi == null) return;
  const { up } = bodyFrame(project);
  const w = worldPose(rig, acc.parts());
  const hip = rig.parent[rig.parent[fi] ?? -1] ?? -1;
  const leg = hip >= 0 ? Math.max(1e-6, vdot(rig.worldT[hip], up) - vdot(rig.worldT[fi], up)) : 1;
  const lift = (vdot(w.T[fi], up) - vdot(rig.worldT[fi], up) - off) / leg;
  // в переносе — наполовину: носок, опущенный на 40–60° маха ноги, иначе чиркает по полу
  const k = lift <= 0.02 ? 1 : lift >= 0.06 ? 0.5 : 1 - (0.5 * (lift - 0.02)) / 0.04;
  // «верх» стопы — то её направление, что в позе покоя смотрело вверх мира
  const localUp = qrot(qinv(rig.worldR[fi]), up);
  const nowUp = qrot(w.R[fi], localUp);
  const fixQ = qscale(qbetween(nowUp, up), k);
  const pf = rig.parent[fi];
  const Rp = pf >= 0 ? w.R[pf] : QI;
  acc.setLocal(rig.skel.nodes[fi].name, qnorm(qmul(qinv(Rp), qmul(fixQ, w.R[fi]))));
}

/** Выравнивание позы покоя: первая кость цепочки разворачивается так, чтобы цепочка смотрела вниз (с отведением abduct). */
function alignRest(acc: Acc, rig: Rig, project: Project) {
  const f = bodyFrame(project);
  for (const [chainName, a] of Object.entries(project.align ?? {})) {
    const chain = project.chains[chainName];
    if (!chain?.length) continue;
    const i0 = rig.index.get(chain[0]);
    if (i0 == null) continue;
    const axes = chainAxes(rig, project, chain);
    const along = axes.roll;
    // сторона цепочки: куда она отходит от тела по боку (у левой руки — +side)
    const s = Math.sign(vdot(along, f.side)) || 1;
    const ab = (a.abduct ?? 0) * DEG;
    const target = vnorm(vadd(vscale(f.up, -Math.cos(ab)), vscale(f.side, s * Math.sin(ab))));
    const q = qbetween(along, target);
    const w = rig.worldR[i0];
    acc.turn(chain[0], qmul(qmul(qinv(w), q), w));
  }
}

function ground(acc: Acc, rig: Rig, project: Project, g: NonNullable<Clip["ground"]>, off?: Map<string, number>) {
  const idx = g.bones.map((b) => rig.index.get(b)).filter((i): i is number => i != null);
  if (!idx.length) return;
  const up = bodyFrame(project).up;
  const w = worldPose(rig, acc.parts());
  const rest = Math.min(...idx.map((i) => vdot(rig.worldT[i], up)));
  // на рельефе высота стопы меряется от пола под ней
  const now = Math.min(...idx.map((i) => vdot(w.T[i], up) - (off?.get(rig.skel.nodes[i].name) ?? 0)));
  let d = rest - now;
  if (g.mode === "floor") d = Math.max(0, d);
  if (Math.abs(d) < 1e-9) return;
  const root = rig.skel.nodes[skeletonRoot(rig, idx[0])].name;
  acc.add(root, "move_up", d, () => ({ lateral: up, vertical: up, roll: up }));
}

/** Рельеф: насколько пол под каждой стопой выше покоя; тело сразу сдвигается к самой низкой опоре. */
function terrain(acc: Acc, rig: Rig, project: Project, g: NonNullable<Clip["ground"]>, floor: NonNullable<LiveOpts["floor"]>): Map<string, number> {
  const up = bodyFrame(project).up;
  const w = worldPose(rig, acc.parts());
  const off = new Map<string, number>();
  for (const b of g.bones) {
    const i = rig.index.get(b);
    if (i == null) continue;
    const rest = vdot(rig.worldT[i], up);
    off.set(b, floor(b, w.T[i], rest) - rest);
  }
  if (!off.size) return off;
  const d = Math.min(...off.values());
  const i0 = rig.index.get(g.bones.find((b) => off.has(b))!)!;
  if (Math.abs(d) > 1e-9) acc.add(rig.skel.nodes[skeletonRoot(rig, i0)].name, "move_up", d, () => ({ lateral: up, vertical: up, roll: up }));
  return off;
}

/** Опора походки по кадрам: в каждом кадре опорная — самая низкая стопа (если она на полу: не выше 2 % роста над
 * самой низкой точкой клипа). k — кадр, j — стопа, v — с какой скоростью она уезжает назад относительно тела,
 * p — где она (координаты модели). */
function stance(project: Project, rig: Rig, clip: Clip, steps: number) {
  const out: { k: number; j: number; v: number; p: Vec3 }[] = [];
  const g = clip.ground;
  if (!clip.loop || !g?.bones.length || clip.duration <= 0) return { frames: out, dt: 0, size: 1 };
  const f = bodyFrame(project);
  const idx = g.bones.map((b) => rig.index.get(b)).filter((i): i is number => i != null);
  const size = (heightCache.get(rig) ?? restHeights(rig, project)).get(SIZE) ?? 1;
  const dt = clip.duration / steps;
  if (!idx.length) return { frames: out, dt, size };
  const P = Array.from({ length: steps + 1 }, (_, k) => {
    const w = worldPose(rig, posePartsAt(project, rig, clip, k * dt));
    return idx.map((i) => w.T[i]);
  });
  const hmin = Math.min(...P.flatMap((row) => row.map((p) => vdot(p, f.up))));
  const dir = travelDir(project, clip);
  for (let k = 0; k < steps; k++) {
    const hs = P[k].map((p) => vdot(p, f.up));
    const j = hs.indexOf(Math.min(...hs));
    if (hs[j] - hmin > 0.02 * size) continue;
    out.push({ k, j, v: -vdot(vsub(P[k + 1][j], P[k][j]), dir) / dt, p: P[k][j] });
  }
  return { frames: out, dt, size };
}

/** Естественная скорость походки, единиц модели в секунду: с какой скоростью опорная стопа уезжает назад
 * относительно тела (медиана по кадрам опоры). Если персонаж в игре идёт с этой скоростью, ноги не скользят; иначе
 * клип ускоряют (AnimForgeLive.move_speed). 0 — у клипа нет пола, он не цикл или опора едет вперёд (походка
 * «лунная» — подгонять нечего, её надо чинить). */
export function naturalSpeed(project: Project, rig: Rig, clip: Clip, steps = 96): number {
  const v = stance(project, rig, clip, steps).frames.map((s) => s.v);
  if (!v.length) return 0;
  v.sort((x, y) => x - y);
  return Math.max(0, v[Math.floor(v.length / 2)]);
}

// ── фиксация опорной стопы (ground.lock) ────────────────────────────────────────────────────────────────────────
// Персонаж идёт в игре со скоростью клипа v — значит, опорная стопа в клипе на месте должна уезжать назад ровно
// со скоростью v, по прямой. Рецепт так не умеет: стопа в опоре идёт по дуге (мах — поворот бедра) и с переменной
// скоростью, отсюда скольжение. План на клип: для каждого шага — прямая «как надо» (наименьшие квадраты к тому, где
// стопа есть), поправка до неё в опоре; в переносе поправка плавно переходит от конца одного шага к началу
// следующего (как у ActionForge Motion Lab: «сдвиг раздаётся по фазе переноса»). Если с поправкой нога не
// дотягивается (длиннее 0.97 своей длины — колено в замок), таз опускается на сколько нужно, со сглаживанием.
const LOCK_N = 96;
const lockCache = new WeakMap<Rig, Map<string, { T: Vec3[][]; drop: number[] }>>();

export function lockPlan(project: Project, rig: Rig, clip: Clip) {
  let cache = lockCache.get(rig);
  if (!cache) lockCache.set(rig, (cache = new Map()));
  const key = JSON.stringify(clip);
  const hit = cache.get(key);
  if (hit) return hit;
  const g = clip.ground!;
  const base: Clip = { ...clip, ground: { ...g, lock: false } };
  const f = bodyFrame(project);
  const N = LOCK_N, dt = clip.duration / N;
  const idx = g.bones.map((b) => rig.index.get(b)).filter((i): i is number => i != null);
  const hipOf = (fi: number) => rig.parent[rig.parent[fi]];
  const size = (heightCache.get(rig) ?? restHeights(rig, project)).get(SIZE) ?? 1;
  const W = Array.from({ length: N }, (_, k) => worldPose(rig, posePartsAt(project, rig, base, k * dt)));
  const P = W.map((w) => idx.map((i) => w.T[i]));
  const hmin = Math.min(...P.flatMap((r) => r.map((p) => vdot(p, f.up))));
  const d = travelDir(project, base);
  const flat = (x: Vec3) => vsub(x, vscale(f.up, vdot(x, f.up)));
  // у пола: самая низкая стопа кадра (или почти вровень — двойная опора)
  const low = P.map((r) => { const hs = r.map((p) => vdot(p, f.up)); const lo = Math.min(...hs); return hs.map((h) => h - hmin <= 0.02 * size && h - lo <= 0.005 * size); });
  const back = (k: number, j: number) => vdot(vsub(P[(k + 1) % N][j], P[(k - 1 + N) % N][j]), d) < 0;
  // скорость опоры — среднее по кадрам опоры (не медиана, как naturalSpeed: у медианы соседние значения далеко,
  // и шум float32 в аддоне Godot сдвигает её на 2 % — а с ней все прямые «как надо»). После фиксации naturalSpeed
  // клипа равна ей: стопа в опоре едет ровно с этой скоростью
  let vs = 0, vn = 0;
  for (let k = 0; k < N; k++) for (let j = 0; j < idx.length; j++) if (low[k][j] && back(k, j)) { vs -= vdot(vsub(P[(k + 1) % N][j], P[(k - 1 + N) % N][j]), d) / (2 * dt); vn++; }
  const v = vn ? vs / vn : 0;
  const tol = 0.015 * size, clear = 0.012 * size;
  const T: Vec3[][] = P.map((r) => r.map((p) => [...p] as Vec3));
  const drop = new Array(N).fill(0);
  idx.forEach((fi, j) => {
    // опора стопы — у пола и уезжает назад. Стопа, что у пола ещё едет вперёд, — это конец переноса, который
    // рецепт провёл ниже пола (IK пола тащит её по полу): её приподнимаем, касание — там, где она остановилась
    const on = Array.from({ length: N }, (_, k) => v > 0 && low[k][j] && back(k, j));
    const c: (Vec3 | null)[] = new Array(N).fill(null);
    if (on.some(Boolean) && !on.every(Boolean)) {
      const start = on.findIndex((x, k) => x && !on[(k - 1 + N) % N]);
      let k = start;
      do {
        const seg: number[] = [];
        while (on[k % N] && seg.length < N) { seg.push(k); k++; }
        // прямая «как надо»: q(t) = A − d·v·t, A — среднее (p + d·v·t) по шагу (наименьшие квадраты)
        let A: Vec3 = [0, 0, 0];
        for (const s of seg) A = vadd(A, vadd(flat(P[s % N][j]), vscale(d, v * s * dt)));
        A = vscale(A, 1 / seg.length);
        for (const s of seg) c[s % N] = vsub(vsub(A, vscale(d, v * s * dt)), flat(P[s % N][j]));
        while (!on[k % N]) k++;
      } while (k % N !== start);
    }
    if (on.some(Boolean) && !on.every(Boolean)) {
      // перенос: поправка плавно от конца шага к началу следующего, и стопа над полом хотя бы на clear·sin(πu)^¼
      const floorH = vdot(rig.worldT[fi], f.up);
      for (let k0 = 0; k0 < N; k0++) {
        if (on[k0] || !on[(k0 - 1 + N) % N]) continue;
        let k1 = k0;
        while (!on[k1 % N]) k1++;
        const a = c[(k0 - 1 + N) % N]!, b = c[k1 % N]!, n = k1 - k0 + 1;
        for (let k2 = k0; k2 < k1; k2++) {
          const u = (k2 - k0 + 1) / n, sm = u * u * (3 - 2 * u);
          // профиль — почти полка: у рецептов конец переноса часто идёт ниже пола (IK пола тащит стопу по нему
          // вперёд) — стопа должна быть в воздухе до самого касания, а не только в середине переноса
          const lift = Math.max(0, floorH + clear * Math.sin(Math.PI * u) ** 0.25 - vdot(P[k2 % N][j], f.up));
          c[k2 % N] = vadd(vadd(vscale(a, 1 - sm), vscale(b, sm)), vscale(f.up, lift));
        }
      }
    }
    for (let k = 0; k < N; k++) {
      if (c[k]) T[k][j] = vadd(P[k][j], c[k]!);
      // дотянется ли нога: бедро → цель не длиннее 0.97 ноги, иначе таз вниз на δ
      const hi = hipOf(fi);
      if (hi < 0) continue;
      const L = Math.hypot(...vsub(rig.worldT[rig.parent[fi]], rig.worldT[hi])) + Math.hypot(...vsub(rig.worldT[fi], rig.worldT[rig.parent[fi]]));
      const H = W[k].T[hi], D = vsub(H, T[k][j]);
      const vd = vdot(D, f.up), hd = Math.hypot(...flat(D)), R = 0.97 * L;
      if (Math.hypot(vd, hd) > R) drop[k] = Math.max(drop[k], hd < R ? vd - Math.sqrt(R * R - hd * hd) : vd);
    }
  });
  // таз — плавно: сначала максимум по окну (опустить не меньше нужного), потом среднее по тому же окну
  const w = Math.max(1, Math.round(0.06 * N));
  const mx = drop.map((_, k) => Math.max(...Array.from({ length: 2 * w + 1 }, (_, q) => drop[(k + q - w + N) % N])));
  // и не ниже 1 % роста: у коротких толстых ног (рабочий) таз ниже — бедро уходит в пол (провал 1.9 % при полном
  // опускании, 0.9 % при 1 %, 0.3 % без него — а скольжение 0.5 / 0.6 / 1.3 %)
  const sm = mx.map((_, k) => Math.min(0.01 * size, Array.from({ length: 2 * w + 1 }, (_, q) => mx[(k + q - w + N) % N]).reduce((a, x) => a + x, 0) / (2 * w + 1)));
  const plan = { T, drop: sm };
  if (cache.size > 256) cache.clear();
  cache.set(key, plan);
  return plan;
}

function footLock(acc: Acc, rig: Rig, project: Project, clip: Clip, t: number, off?: Map<string, number>) {
  const g = clip.ground!;
  const plan = lockPlan(project, rig, clip);
  const N = LOCK_N;
  const x = ((((t / clip.duration) % 1) + 1) % 1) * N;
  const k0 = Math.floor(x) % N, k1 = (k0 + 1) % N, u = x - Math.floor(x);
  const up = bodyFrame(project).up;
  const drop = plan.drop[k0] * (1 - u) + plan.drop[k1] * u;
  const idx = g.bones.map((b) => rig.index.get(b)).filter((i): i is number => i != null);
  if (drop > 1e-9 && idx.length) acc.add(rig.skel.nodes[skeletonRoot(rig, idx[0])].name, "move_up", -drop, () => ({ lateral: up, vertical: up, roll: up }));
  g.bones.filter((b) => rig.index.has(b)).forEach((b, j) => {
    const P = vadd(vadd(vscale(plan.T[k0][j], 1 - u), vscale(plan.T[k1][j], u)), vscale(up, off?.get(b) ?? 0));
    twoBoneIK(acc, rig, project, b, P, undefined, 1);
  });
  if (g.flat) for (const b of g.bones) flatFoot(acc, rig, project, b, off?.get(b) ?? 0);
}

/** Куда на самом деле идёт походка, ° от вперёд (+ — влево, как Travel.angle): против хода стоп по полу, пока они
 * на полу. Вес стопы плавный — 1 у самой низкой точки клипа и 0 на 2 % роста выше, и у самой низкой в кадре больше
 * (размытый минимум): жёсткий выбор «опорной» прыгает от кадра к кадру, угол шумит на ±3°, и подбор плоскости маха
 * по нему не сходится. NaN — у клипа нет опоры. */
export function gaitHeading(project: Project, rig: Rig, clip: Clip, steps = 96): number {
  const g = clip.ground;
  if (!clip.loop || !g?.bones.length || clip.duration <= 0) return NaN;
  const f = bodyFrame(project);
  const idx = g.bones.map((b) => rig.index.get(b)).filter((i): i is number => i != null);
  if (!idx.length) return NaN;
  const size = (heightCache.get(rig) ?? restHeights(rig, project)).get(SIZE) ?? 1;
  const dt = clip.duration / steps;
  const P = Array.from({ length: steps + 1 }, (_, k) => { const w = worldPose(rig, posePartsAt(project, rig, clip, k * dt)); return idx.map((i) => w.T[i]); });
  const hmin = Math.min(...P.flatMap((row) => row.map((p) => vdot(p, f.up))));
  const S: { w: number; x: number; y: number }[] = [];
  for (let k = 0; k < steps; k++) {
    // опора — самая низкая стопа кадра, но мягко: вторая стопа, почти вровень, тоже весит (переход шага плавный);
    // перенос низко над полом (короткие ноги вразвалку) — не опора, иначе быстрая стопа в воздухе перевешивает
    const hs = P[k].map((p) => vdot(p, f.up));
    const lo = Math.min(...hs);
    for (let j = 0; j < idx.length; j++) {
      const w = Math.max(0, 1 - (hs[j] - hmin) / (0.02 * size)) * Math.exp(-(hs[j] - lo) / (0.005 * size));
      if (w < 1e-6) continue;
      const d = vsub(P[k][j], P[k + 1][j]); // тело идёт против стопы
      S.push({ w, x: vdot(d, f.forward), y: vdot(d, f.side) });
    }
  }
  // стопа, что едет по полу не туда (в двойной опоре одна держит, другую IK тащит по полу вперёд), — меньшинство:
  // направление большинства — по медиане, потом среднее только по согласным с ним
  const med = (a: number[]) => { const b = [...a].sort((p, q) => p - q); return b.length ? b[Math.floor(b.length / 2)] : 0; };
  const core = S.filter((s) => s.w >= 0.25);
  const mx = med(core.map((s) => s.x)), my = med(core.map((s) => s.y));
  let x = 0, y = 0;
  for (const s of S) if (s.x * mx + s.y * my > 0) { x += s.w * s.x; y += s.w * s.y; }
  return x || y ? (Math.atan2(y, x) * 180) / Math.PI : NaN;
}

/** Скольжение походки: персонаж идёт в игре с естественной скоростью — на сколько каждая опорная стопа проезжает
 * по полу за свой шаг (наибольший разнос её точек на полу), в долях роста; mean — в среднем по шагам, max — худший.
 * backward — доля кадров опоры, где стопа уезжает назад, как надо. null — у клипа нет походки. */
export function gaitSlide(project: Project, rig: Rig, clip: Clip, steps = 96): { speed: number; mean: number; max: number; backward: number } | null {
  const { frames, dt, size } = stance(project, rig, clip, steps);
  if (!frames.length) return null;
  const speed = naturalSpeed(project, rig, clip, steps);
  const f = bodyFrame(project);
  const backward = frames.filter((s) => s.v > 0).length / frames.length;
  // шаги — подряд идущие кадры опоры одной стопы; на полу стопа там, где она в теле, плюс путь тела
  const segs: Vec3[][] = [];
  frames.forEach((s, n) => {
    const onFloor = vadd(s.p, vscale(travelDir(project, clip), speed * s.k * dt));
    const flat = vsub(onFloor, vscale(f.up, vdot(onFloor, f.up)));
    const prev = frames[n - 1];
    if (prev && prev.j === s.j && prev.k === s.k - 1) segs[segs.length - 1].push(flat);
    else segs.push([flat]);
  });
  const spread = segs.map((pts) => Math.max(0, ...pts.flatMap((a) => pts.map((b) => Math.hypot(...vsub(a, b))))) / size);
  return { speed, mean: spread.reduce((a, x) => a + x, 0) / spread.length, max: Math.max(...spread), backward };
}

// ── вторичная динамика ──────────────────────────────────────────────────────────────────────────────────────────
// Цепочка — маятник с пружиной к позе покоя. Её раскачивают ускорение основания и вращение родителя:
//   θ'' = (1 − inert)·(−α_родителя − (d × A)/L) − 2ζω₀θ' − ω₀²θ,   по осям lateral и vertical цепочки.
// Всё считается в осях родителя (в rest-ориентации), поэтому поворот самого родителя не «уносит» ответ.
const DT = 1 / 240;
const secCache = new WeakMap<Rig, Map<string, { lat: Float64Array; ver: Float64Array; dur: number }>>();

function secondaryCurve(project: Project, rig: Rig, clip: Clip, layer: RecipeLayer, chain: string[], p: Record<string, any>) {
  let cache = secCache.get(rig);
  if (!cache) secCache.set(rig, (cache = new Map()));
  const base = { ...clip, layers: clip.layers.filter((l) => !isSecondary(l)) };
  const key = JSON.stringify([base, project.chains, project.up, project.forward, chain, p]);
  const hit = cache.get(key);
  if (hit) return hit;

  const i0 = rig.index.get(chain[0])!;
  const par = rig.parent[i0];
  const axes = chainAxes(rig, project, chain);
  const last = rig.index.get(chain[chain.length - 1])!;
  const L = Math.max(0.03, Math.hypot(...vsub(rig.worldT[last], rig.worldT[i0])) + (chain.length === 1 ? 0.1 : 0)) * p.length;
  const d = axes.roll;
  const restPar = par >= 0 ? rig.worldR[par] : QI;
  const w0 = 2 * Math.PI * p.hz;

  // движение основания и родителя, в осях родителя
  const steps = Math.max(2, Math.round(clip.duration / DT));
  const h = clip.duration / steps;
  const sample = (t: number) => {
    const tt = clip.loop ? ((t % clip.duration) + clip.duration) % clip.duration : Math.min(Math.max(t, 0), clip.duration);
    const w = worldPose(rig, primary(project, rig, base, tt).parts());
    const R = par >= 0 ? qmul(w.R[par], qinv(restPar)) : QI; // поворот родителя относительно rest
    return { R, T: w.T[i0] };
  };
  const frames = Array.from({ length: steps + 3 }, (_, k) => sample((k - 1) * h)); // с запасом по кадру с каждой стороны
  const drive = (k: number): { lat: number; ver: number } => {
    const f0 = frames[k], f1 = frames[k + 1], f2 = frames[k + 2];
    const inv = qinv(f1.R);
    const om0 = qrot(inv, angVel(f0.R, f1.R, h));
    const om1 = qrot(inv, angVel(f1.R, f2.R, h));
    const alpha = vscale(vsub(om1, om0), 1 / h);
    const A = qrot(inv, vscale(vadd(vsub(f2.T, vscale(f1.T, 2)), f0.T), 1 / (h * h)));
    const torque = vadd(vscale(alpha, -1), vscale(vcross(d, A), -1 / L));
    const g = (1 - p.inert) * p.gain;
    return { lat: g * vdot(torque, axes.lateral), ver: g * vdot(torque, axes.vertical) };
  };
  const lat = new Float64Array(steps + 1), ver = new Float64Array(steps + 1);
  let x = [0, 0], v = [0, 0];
  const cycles = clip.loop ? 5 : 1;
  for (let c = 0; c < cycles; c++) {
    for (let k = 0; k <= steps; k++) {
      if (c === cycles - 1) { lat[k] = x[0]; ver[k] = x[1]; }
      if (k === steps) break;
      const dr = drive(k);
      [dr.lat, dr.ver].forEach((a, j) => {
        v[j] += (a - 2 * p.damping * w0 * v[j] - w0 * w0 * x[j]) * h; // полунеявный Эйлер
        x[j] += v[j] * h;
      });
    }
  }
  const res = { lat, ver, dur: clip.duration };
  if (cache.size > 64) cache.clear();
  cache.set(key, res);
  return res;
}

function addSecondary(acc: Acc, project: Project, rig: Rig, clip: Clip, t: number) {
  for (const layer of clip.layers) {
    if (!isSecondary(layer) || layer.type !== "recipe") continue;
    const chain = project.chains[layer.target.chain];
    if (!chain) continue;
    const p = withDefaults(RECIPES[layer.recipe], layer.params);
    const c = secondaryCurve(project, rig, clip, layer, chain, p);
    const n = c.lat.length - 1;
    const tt = clip.loop ? ((t % c.dur) + c.dur) % c.dur : Math.min(Math.max(t, 0), c.dur);
    const f = (tt / c.dur) * n, k = Math.min(n - 1, Math.floor(f)), u = f - k;
    const lat = (c.lat[k] + (c.lat[k + 1] - c.lat[k]) * u) / DEG;
    const ver = (c.ver[k] + (c.ver[k + 1] - c.ver[k]) * u) / DEG;
    // отклонение распределяется по цепочке с ростом к кончику, сумма = θ
    let sum = 0;
    for (let j = 0; j < chain.length; j++) sum += (j + 1) / chain.length;
    const axes = chainAxes(rig, project, chain);
    const w = layer.weight ?? 1;
    chain.forEach((bone, j) => {
      const share = ((j + 1) / chain.length / sum) * w;
      acc.add(bone, "lateral", lat * share, () => axes);
      acc.add(bone, "vertical", ver * share, () => axes);
    });
  }
}

/** Кости, которые двигает вторичная динамика клипа. */
function secondaryBones(project: Project, clip: Clip): Set<string> {
  return new Set(clip.layers.flatMap((l) => (isSecondary(l) && l.type === "recipe" ? (project.chains[l.target.chain] ?? []) : [])));
}

/** Полная поза в момент t: повороты, сдвиги и масштабы затронутых костей (в локальных осях, как в glTF). */
export function posePartsAt(project: Project, rig: Rig, clip: Clip, t: number, opts?: LiveOpts): PoseParts {
  const acc = primary(project, rig, clip, t, opts);
  if (clip.layers.some(isSecondary)) {
    addSecondary(acc, project, rig, clip, t);
    if (project.limits) acc.applyLimits(secondaryBones(project, clip)); // хвост и уши после пружины — тоже в своих пределах
  }
  const parts = acc.parts();
  if (acc.limited.size) parts.limited = acc.limited;
  return parts;
}

/** Повороты костей как дельты к позе покоя и база выравнивания — для ограничений (limit.fit, подсказки редактора). */
export function motionAt(project: Project, rig: Rig, clip: Clip, t: number): { rot: Map<string, Quat>; base: Map<string, Quat>; limited: Set<string> } {
  const acc = primary(project, rig, clip, t);
  if (clip.layers.some(isSecondary)) {
    addSecondary(acc, project, rig, clip, t);
    if (project.limits) acc.applyLimits(secondaryBones(project, clip));
  }
  return { rot: acc.rot, base: acc.base, limited: acc.limited };
}

/** Только повороты — для старого кода и проверок. */
export function poseAt(project: Project, rig: Rig, clip: Clip, t: number): Map<string, Quat> {
  return posePartsAt(project, rig, clip, t).rot;
}

export interface Baked {
  times: number[];
  rotations: Map<string, Quat[]>;
  translations: Map<string, Vec3[]>;
  scales: Map<string, Vec3[]>;
}

/** Моменты кадров: строго через 1/fps (так пересэмплирует импорт Godot), последний — ровно в конце клипа. */
export function frameTimes(clip: Clip): number[] {
  const full = Math.floor(clip.duration * clip.fps + 1e-6);
  const times = Array.from({ length: full + 1 }, (_, k) => k / clip.fps);
  if (clip.duration - times[full] > 1e-6) times.push(clip.duration);
  return times;
}

/** Запекание клипа в ключи с частотой fps. Для цикла последний кадр совпадает с первым. */
export function bakeClip(project: Project, rig: Rig, clip: Clip): Baked {
  const times = frameTimes(clip);
  const n = times.length - 1;
  const out: Baked = { times, rotations: new Map(), translations: new Map(), scales: new Map() };
  const put = <T>(m: Map<string, T[]>, bone: string, k: number, v: T) => {
    if (!m.has(bone)) m.set(bone, []);
    m.get(bone)![k] = v;
  };
  times.forEach((t, k) => {
    const pose = posePartsAt(project, rig, clip, clip.loop && k === n ? 0 : t);
    for (const [b, q] of pose.rot) put(out.rotations, b, k, q);
    for (const [b, v] of pose.pos) put(out.translations, b, k, v);
    for (const [b, v] of pose.scl) put(out.scales, b, k, v);
  });
  // кость могла быть неподвижной в части кадров — дозаполняем rest-позой
  const fill = <T>(m: Map<string, T[]>, rest: (i: number) => T) => {
    for (const [bone, arr] of m) {
      const r = rest(rig.index.get(bone)!);
      for (let k = 0; k <= n; k++) arr[k] ??= r;
    }
  };
  fill(out.rotations, (i) => rig.skel.nodes[i].restR);
  fill(out.translations, (i) => rig.skel.nodes[i].restT);
  fill(out.scales, (i) => rig.skel.nodes[i].restS);
  return out;
}

/** События клипа от рецептов (без повторов: роли одного удара дают одни и те же события). Вне клипа — отбрасываются. */
export function clipEvents(clip: Clip): (ClipEvent & { layer: string })[] {
  const seen = new Set<string>();
  const out: (ClipEvent & { layer: string })[] = [];
  for (const l of clip.layers) {
    if (l.type !== "recipe") continue;
    const def = RECIPES[l.recipe];
    if (!def?.events) continue;
    for (const e of def.events(withDefaults(def, l.params))) {
      const key = `${e.t.toFixed(4)}|${e.name}`;
      if (seen.has(key) || e.t < 0 || e.t > clip.duration + 1e-6) continue;
      seen.add(key);
      out.push({ ...e, layer: l.id });
    }
  }
  return out.sort((a, b) => a.t - b.t);
}
