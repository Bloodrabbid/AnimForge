// Вычисление позы: rest-поза → слои рецептов → ручной слой → постановка на пол → вторичная динамика.
// Работает одинаково в браузере и в Node.
import { evalKeys } from "./curves.ts";
import { DEG, QI, Quat, Vec3, angVel, qaxis, qinv, qmul, qnorm, qrot, qscale, vadd, vcross, vdot, vmul, vnorm, vscale, vsub } from "./math.ts";
import type { Channel, Clip, Constraint, ConstraintTarget, Project, RecipeLayer, SemanticAxis, Skeleton } from "./project.ts";
import { RECIPES, withDefaults, type ClipEvent } from "./recipes.ts";
import { clampRotation } from "./limits.ts";

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
  applyLimits() {
    for (const [bone, lim] of Object.entries(this.project.limits ?? {})) {
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

/** Основные слои (без вторичной динамики) и постановка на пол. */
function primary(project: Project, rig: Rig, clip: Clip, t: number): Acc {
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
      chain.forEach((bone, i) => {
        const out = def.evaluate(p, i, chain.length, t, { height: heights!.get(bone) ?? 0, size: heights!.get(SIZE) ?? 0 });
        for (const [ch, v] of Object.entries(out)) {
          // вес слоя: для углов и сдвигов — множитель, для масштаба — доля пути от 1 до значения
          const val = ch.startsWith("scale_") ? 1 + ((v as number) - 1) * w : (v as number) * w;
          acc.add(bone, ch as Channel, val, getAxes);
        }
      });
    } else {
      for (const tr of layer.tracks) {
        const chain = chainOf(project, tr.bone) ?? [tr.bone];
        const v = evalKeys(tr.keys, t, clip.loop, clip.duration);
        acc.add(tr.bone, tr.axis, tr.axis.startsWith("scale_") ? 1 + v : v, () => chainAxes(rig, project, chain.length > 1 ? chain : [tr.bone]));
      }
    }
  }
  // ограничения — до постановки на пол: ноги встают на пол уже в разрешённой позе
  if (project.limits) acc.applyLimits();
  const g = clip.ground;
  if (g?.bones.length) {
    // contact: сначала опустить тело до касания, потом IK поднимает провалившиеся ступни; floor: наоборот
    if (g.mode === "contact") ground(acc, rig, project, g);
    if (g.ik) for (const b of g.bones) footIK(acc, rig, project, b);
    if (g.mode === "floor") ground(acc, rig, project, g);
  }
  if (clip.constraints?.some((c) => !c.muted)) {
    for (const c of clip.constraints) if (!c.muted) solveConstraint(acc, rig, project, clip, c, t);
    if (project.limits) acc.applyLimits(); // взгляд и IK — тоже в анатомических пределах
  }
  return acc;
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

function solveConstraint(acc: Acc, rig: Rig, project: Project, clip: Clip, c: Constraint, t: number) {
  const P = targetAt(rig, c.target.bone ? acc.parts() : null, clip, c.target, t);
  if (!P) return;
  const w = Math.max(0, Math.min(1, c.weight ?? 1));
  if (w === 0) return;
  if (c.type === "ik") twoBoneIK(acc, rig, project, c.tip, P, c.pole, w, !!c.end);
  else aim(acc, rig, project, c.bones, P, w);
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
    if (Math.hypot(...kv) > 1e-9 && Math.hypot(...pv) > 1e-9) {
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
function footIK(acc: Acc, rig: Rig, project: Project, foot: string) {
  const fi = rig.index.get(foot);
  if (fi == null) return;
  const si = rig.parent[fi], ti = si >= 0 ? rig.parent[si] : -1;
  if (si < 0 || ti < 0) return;
  const { up, forward } = bodyFrame(project);
  const w = worldPose(rig, acc.parts());
  const H = w.T[ti], K = w.T[si], F = w.T[fi];
  const floor = vdot(rig.worldT[fi], up);
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

function ground(acc: Acc, rig: Rig, project: Project, g: NonNullable<Clip["ground"]>) {
  const idx = g.bones.map((b) => rig.index.get(b)).filter((i): i is number => i != null);
  if (!idx.length) return;
  const up = bodyFrame(project).up;
  const w = worldPose(rig, acc.parts());
  const rest = Math.min(...idx.map((i) => vdot(rig.worldT[i], up)));
  const now = Math.min(...idx.map((i) => vdot(w.T[i], up)));
  let d = rest - now;
  if (g.mode === "floor") d = Math.max(0, d);
  if (Math.abs(d) < 1e-9) return;
  const root = rig.skel.nodes[skeletonRoot(rig, idx[0])].name;
  acc.add(root, "move_up", d, () => ({ lateral: up, vertical: up, roll: up }));
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

/** Полная поза в момент t: повороты, сдвиги и масштабы затронутых костей (в локальных осях, как в glTF). */
export function posePartsAt(project: Project, rig: Rig, clip: Clip, t: number): PoseParts {
  const acc = primary(project, rig, clip, t);
  if (clip.layers.some(isSecondary)) {
    addSecondary(acc, project, rig, clip, t);
    if (project.limits) acc.applyLimits(); // хвост и уши после пружины — тоже в своих пределах
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
    if (project.limits) acc.applyLimits();
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
