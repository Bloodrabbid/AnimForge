// Перенос клипа на другой скелет (clip.copy): тот же рецепт, ключи, позы и цели — на кости другой модели.
// Слои рецептов адресуют цепочки по ролям (leg_l, arm_r…) и считают махи в осях тела — им переносить нечего.
// Кости в ключах, позах, целях и на полу сопоставляются по ролям: цепочка с тем же именем — кость с тем же местом в
// ней (у разной длины — пропорционально), стопа, кисть, носок и root — по стандартным именам (standardNames),
// остальное — по совпадающему имени. Сдвиги в метрах масштабируются по росту, направления — по осям тела.
import { qinv, qmul, qnorm, qrot, vadd, vscale, vsub, vdot, type Quat, type Vec3 } from "./math.ts";
import type { Clip, Constraint, ConstraintTarget, Layer, Project } from "./project.ts";
import { bodyFrame, type Rig } from "./evaluate.ts";
import { standardNames } from "./naming.ts";

export interface Side {
  project: Project;
  rig: Rig;
}

/** Карта костей «источник → цель» по ролям. */
export function boneMap(src: Side, dst: Side): Map<string, string> {
  const map = new Map<string, string>();
  for (const [name, sb] of Object.entries(src.project.chains)) {
    const db = dst.project.chains[name];
    if (!db?.length || !sb.length) continue;
    sb.forEach((b, k) => {
      if (map.has(b)) return;
      const j = sb.length === 1 ? 0 : Math.round((k * (db.length - 1)) / (sb.length - 1));
      map.set(b, db[j]);
    });
  }
  const ss = standardNames(src.project, src.rig, "unreal");
  const ds = new Map([...standardNames(dst.project, dst.rig, "unreal")].map(([b, n]) => [n, b]));
  for (const [b, n] of ss) if (!map.has(b) && ds.has(n)) map.set(b, ds.get(n)!);
  for (const n of src.rig.skel.nodes) if (!map.has(n.name) && dst.rig.index.has(n.name)) map.set(n.name, n.name);
  return map;
}

/** Поворот, переводящий оси тела источника (бок, верх, вперёд) в оси тела цели. */
function bodyTurn(src: Project, dst: Project): Quat {
  const a = bodyFrame(src), b = bodyFrame(dst);
  // матрица M = Σ b_i a_iᵀ — столбцы: куда уходят мировые x, y, z источника
  const m = [0, 1, 2].map((r) => [0, 1, 2].map((c) => b.side[r] * a.side[c] + b.up[r] * a.up[c] + b.forward[r] * a.forward[c]));
  return quatFromMatrix(m);
}

function quatFromMatrix(m: number[][]): Quat {
  const tr = m[0][0] + m[1][1] + m[2][2];
  let q: Quat;
  if (tr > 0) {
    const s = Math.sqrt(tr + 1) * 2;
    q = [(m[2][1] - m[1][2]) / s, (m[0][2] - m[2][0]) / s, (m[1][0] - m[0][1]) / s, s / 4];
  } else if (m[0][0] > m[1][1] && m[0][0] > m[2][2]) {
    const s = Math.sqrt(1 + m[0][0] - m[1][1] - m[2][2]) * 2;
    q = [s / 4, (m[0][1] + m[1][0]) / s, (m[0][2] + m[2][0]) / s, (m[2][1] - m[1][2]) / s];
  } else if (m[1][1] > m[2][2]) {
    const s = Math.sqrt(1 + m[1][1] - m[0][0] - m[2][2]) * 2;
    q = [(m[0][1] + m[1][0]) / s, s / 4, (m[1][2] + m[2][1]) / s, (m[0][2] - m[2][0]) / s];
  } else {
    const s = Math.sqrt(1 + m[2][2] - m[0][0] - m[1][1]) * 2;
    q = [(m[0][2] + m[2][0]) / s, (m[1][2] + m[2][1]) / s, s / 4, (m[1][0] - m[0][1]) / s];
  }
  return qnorm(q);
}

/** Рост скелета (по up, от нижнего сустава до верхнего) и точка пола под тазом — опора для переноса точек. */
function measure(s: Side): { height: number; base: Vec3 } {
  const up = bodyFrame(s.project).up;
  const js = s.rig.skel.nodes.flatMap((n, i) => (n.isJoint ? [i] : []));
  const hs = js.map((i) => vdot(s.rig.worldT[i], up));
  const lo = Math.min(...hs), hi = Math.max(...hs);
  const p = s.project.chains.pelvis?.[0];
  const pi = p != null && s.rig.index.has(p) ? s.rig.index.get(p)! : js[hs.indexOf(lo)];
  const pt = s.rig.worldT[pi];
  return { height: Math.max(hi - lo, 1e-6), base: vsub(pt, vscale(up, vdot(pt, up) - lo)) };
}

/** Клип источника на скелете цели. dropped — что не нашло себе места (кость или цепочка, которых у цели нет). */
export function retargetClip(src: Side, dst: Side, clip: Clip, name = clip.name): { clip: Clip; map: Record<string, string>; scale: number; dropped: string[] } {
  const map = boneMap(src, dst);
  const A = bodyTurn(src.project, dst.project);
  const ms = measure(src), md = measure(dst);
  const k = md.height / ms.height;
  const dropped = new Set<string>();
  const bone = (b: string) => {
    const d = map.get(b);
    if (!d) dropped.add(`кость ${b}`);
    return d;
  };
  const vec = (v: Vec3): Vec3 => vscale(qrot(A, v), k);
  const point = (p: Vec3): Vec3 => vadd(md.base, vec(vsub(p, ms.base)));
  // добавочный поворот в локальных осях покоя: через мир покоя источника, оси тела — в мир покоя цели
  const rot = (b: string, d: string, q: Quat): Quat => {
    const ws = src.rig.worldR[src.rig.index.get(b)!], wd = dst.rig.worldR[dst.rig.index.get(d)!];
    const world = qmul(qmul(ws, q), qinv(ws));
    return qnorm(qmul(qmul(qinv(wd), qmul(qmul(A, world), qinv(A))), wd));
  };
  const target = (t: ConstraintTarget): ConstraintTarget | undefined => {
    const out: ConstraintTarget = {};
    if (t.bone) {
      const d = bone(t.bone);
      if (!d) return undefined;
      out.bone = d;
    }
    if (t.pos) out.pos = t.bone ? vec(t.pos) : point(t.pos);
    if (t.offset) out.offset = vec(t.offset);
    if (t.keys) out.keys = t.keys.map((x) => ({ ...x, pos: t.bone ? vec(x.pos) : point(x.pos) }));
    return out;
  };

  const c: Clip = structuredClone(clip);
  c.name = name;
  c.layers = clip.layers.flatMap((l): Layer[] => {
    if (l.type === "recipe") {
      if (!dst.project.chains[l.target.chain]?.length) {
        dropped.add(`слой ${l.id} (нет цепочки ${l.target.chain})`);
        return [];
      }
      return [structuredClone(l)];
    }
    if (l.type === "keys") {
      const tracks = l.tracks.flatMap((tr) => {
        const d = bone(tr.bone);
        if (!d) return [];
        const m = tr.axis.startsWith("move_") ? k : 1;
        return [{ ...tr, bone: d, keys: tr.keys.map((x) => ({ ...x, v: x.v * m })) }];
      });
      return tracks.length ? [{ ...l, tracks }] : [];
    }
    const keys = l.keys.map((pk) => {
      const out = { ...pk, rot: undefined as Record<string, Quat> | undefined, move: undefined as Record<string, Vec3> | undefined };
      for (const [b, q] of Object.entries(pk.rot ?? {})) {
        const d = bone(b);
        if (d) (out.rot ??= {})[d] = rot(b, d, q);
      }
      for (const [b, v] of Object.entries(pk.move ?? {})) {
        const d = bone(b);
        if (d) (out.move ??= {})[d] = vec(v);
      }
      if (!out.rot) delete out.rot;
      if (!out.move) delete out.move;
      return out;
    });
    return [{ ...l, keys }];
  });
  if (clip.ground) {
    const bones = clip.ground.bones.flatMap((b) => bone(b) ?? []);
    if (bones.length) c.ground = { ...clip.ground, bones };
    else delete c.ground;
  }
  if (clip.constraints) {
    c.constraints = clip.constraints.flatMap((x): Constraint[] => {
      if (x.type === "copy") {
        const bones = x.bones.map(bone), source = x.source.map(bone);
        if (bones.some((b) => !b) || source.some((b) => !b)) return [];
        return [{ ...x, bones: bones as string[], source: source as string[] }];
      }
      const t = target(x.target);
      if (!t) return [];
      if (x.type === "aim") {
        const bones = x.bones.map(bone);
        return bones.some((b) => !b) ? [] : [{ ...x, bones: bones as string[], target: t }];
      }
      // кончик-варежка (end) у цели с кистью — тянется кисть; кисть источника у цели-варежки — конец предплечья
      let tip = map.get(x.tip), end = x.end;
      if (tip && end) {
        const ti = dst.rig.index.get(tip)!;
        const kid = dst.rig.parent.findIndex((p, j) => p === ti && dst.rig.skel.nodes[j].isJoint);
        if (kid >= 0) { tip = dst.rig.skel.nodes[kid].name; end = undefined; }
      }
      if (!tip && !end) {
        const si = src.rig.index.get(x.tip)!, up = src.rig.skel.nodes[src.rig.parent[si]]?.name;
        if (up && map.get(up)) { tip = map.get(up); end = true; }
      }
      if (!tip) { bone(x.tip); return []; }
      const ik = { ...x, tip, target: t, ...(x.pole ? { pole: point(x.pole) } : {}) };
      if (end) ik.end = true; else delete ik.end;
      return [ik];
    });
    if (!c.constraints.length) delete c.constraints;
  }
  const used = new Set<string>();
  const walk = (b: string) => map.has(b) && used.add(b);
  for (const l of clip.layers) {
    if (l.type === "keys") l.tracks.forEach((t) => walk(t.bone));
    if (l.type === "pose") l.keys.forEach((pk) => [...Object.keys(pk.rot ?? {}), ...Object.keys(pk.move ?? {})].forEach(walk));
  }
  clip.ground?.bones.forEach(walk);
  return { clip: c, map: Object.fromEntries([...used].map((b) => [b, map.get(b)!])), scale: +k.toFixed(4), dropped: [...dropped] };
}
