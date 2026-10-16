// Импорт готового клипа (clip.import): анимация чужого скелета (Mixamo, Unreal, Quaternius, свой glb) — основой
// клипа, поверх которой работают рецепты, ключи и цели. Клип ложится слоем поз «base» с ключом на каждый кадр
// (linear) — его считает тот же код, что и ручные позы, в редакторе и в аддоне Godot.
//
// Перенос — по мировым поворотам относительно покоя: кость источника в кадре повёрнута в мире на D от своей позы
// покоя; кость цели получает тот же поворот, переведённый в оси тела цели (A·D·A⁻¹). Разницу поз покоя (T-поза
// источника и A-поза цели, иначе согнутый локоть) снимает поправка O — поворот, который ставит кость цели в покое
// по направлению кости источника. Итог: W_цели = A·D·A⁻¹ · O · W_покоя_цели — направления костей в кадре совпадают
// с источником при любых осях костей у обоих скелетов. Таз получает и сдвиг: путь таза источника в осях тела цели,
// масштабированный по росту. Кости над тазом (root) остаются в покое: их поворот и ход уходят в таз.
import { qaxis, qinv, qmul, qnorm, qrot, vadd, vdot, vscale, vsub, type Quat, type Vec3 } from "./math.ts";

const vlen = (v: Vec3) => Math.hypot(v[0], v[1], v[2]);
import type { Clip, PoseKey, PoseLayer } from "./project.ts";
import { bodyFrame, qbetween, restAlign, type Rig } from "./evaluate.ts";
import { bodyTurn, boneMap, measure, type Side } from "./retarget.ts";
import { standardNames } from "./naming.ts";
import { fingersOf } from "./hands.ts";

/** Кадр источника: локальные повороты и сдвиги узлов (абсолютные, как в glTF); узла нет — он в покое. */
export interface SourceFrame {
  t: number;
  rot: Record<string, Quat>;
  pos: Record<string, Vec3>;
}

const QI: Quat = [0, 0, 0, 1];
const r5 = (x: number) => Math.round(x * 1e5) / 1e5;

function fk(rig: Rig, f: SourceFrame): { R: Quat[]; T: Vec3[] } {
  const R: Quat[] = [], T: Vec3[] = [], S: Vec3[] = [];
  rig.skel.nodes.forEach((n, i) => {
    const lr = f.rot[n.name] ?? n.restR, lt = f.pos[n.name] ?? n.restT, ls = n.restS;
    const p = rig.parent[i];
    if (p < 0) { R[i] = lr; T[i] = lt; S[i] = ls; return; }
    R[i] = qnorm(qmul(R[p], lr));
    T[i] = qrot(R[p], [S[p][0] * lt[0], S[p][1] * lt[1], S[p][2] * lt[2]]).map((v, k) => v + T[p][k]) as Vec3;
    S[i] = [S[p][0] * ls[0], S[p][1] * ls[1], S[p][2] * ls[2]];
  });
  return { R, T };
}

const ancestors = (rig: Rig, i: number) => {
  const out = new Set<number>();
  for (let p = rig.parent[i]; p >= 0; p = rig.parent[p]) out.add(p);
  return out;
};

/** Пары «кость цели ← кость источника» и поправка покоя O для каждой. */
/** Ручное сопоставление: кость источника → кость цели (null — не переносить). Перекрывает найденное само. */
export type BoneOverrides = Record<string, string | null>;

export function importPlan(src: Side, dst: Side, overrides: BoneOverrides = {}) {
  const map = boneMap(src, dst);
  const sp = src.project.chains.pelvis?.[0], dp = dst.project.chains.pelvis?.[0];
  const sAbove = sp && src.rig.index.has(sp) ? ancestors(src.rig, src.rig.index.get(sp)!) : new Set<number>();
  const dAbove = dp && dst.rig.index.has(dp) ? ancestors(dst.rig, dst.rig.index.get(dp)!) : new Set<number>();
  // цель ← источник. Кандидаты: то же имя (лучше всего), то же стандартное имя (стопа, кисть), место в цепочке.
  // Если цепочки разной длины, на одну кость цели приходят несколько — побеждает лучший признак, из равных —
  // самая дальняя кость источника (её мировой поворот вбирает предыдущие).
  const cand: [number, number, number][] = []; // [источник, цель, приоритет]
  for (const [b, d] of map) cand.push([src.rig.index.get(b)!, dst.rig.index.get(d)!, 2]);
  const ds = new Map([...standardNames(dst.project, dst.rig, "unreal")].map(([b, n]) => [n, b]));
  for (const [b, n] of standardNames(src.project, src.rig, "unreal")) if (ds.has(n)) cand.push([src.rig.index.get(b)!, dst.rig.index.get(ds.get(n)!)!, 1]);
  for (const n of src.rig.skel.nodes) if (dst.rig.index.has(n.name)) cand.push([src.rig.index.get(n.name)!, dst.rig.index.get(n.name)!, 0]);
  // пальцы — по имени пальца (у безымянных — по порядку) и месту в пальце; ключица — кость между грудью и плечом
  const sStd = new Map([...standardNames(src.project, src.rig, "unreal")].map(([b, n]) => [n, b]));
  const body = (s: Side) => new Set(["pelvis", "spine", "chest", "neck", "head"].flatMap((c) => s.project.chains[c] ?? []));
  const sBody = body(src), dBody = body(dst);
  for (const side of ["l", "r"] as const) {
    const fs = fingersOf(src.project, src.rig, side), fd = fingersOf(dst.project, dst.rig, side);
    if (fs && fd) {
      fs.fingers.forEach((f, n) => {
        const g = fd.fingers.find((x) => x.name === f.name && f.name !== "other") ?? (f.name === "other" ? fd.fingers[n] : undefined);
        if (!g) return;
        f.bones.forEach((b, k) => {
          const j = f.bones.length === 1 ? 0 : Math.round((k * (g.bones.length - 1)) / (f.bones.length - 1));
          cand.push([src.rig.index.get(b)!, dst.rig.index.get(g.bones[j])!, 1]);
        });
      });
    }
    const clav = (s: Side, std: Map<string, string>, bodySet: Set<string>) => {
      const up = std.get(`upperarm_${side}`);
      if (!up) return undefined;
      const p = s.rig.parent[s.rig.index.get(up)!];
      return p >= 0 && s.rig.skel.nodes[p].isJoint && !bodySet.has(s.rig.skel.nodes[p].name) ? p : undefined;
    };
    const cs = clav(src, sStd, sBody), cd = clav(dst, ds, dBody);
    if (cs != null && cd != null) cand.push([cs, cd, 1]);
  }
  const from = new Map<number, number>(), prio = new Map<number, number>();
  for (const [i, j, pr] of cand) {
    if (i == null || j == null || !src.rig.skel.nodes[i].isJoint || !dst.rig.skel.nodes[j].isJoint || sAbove.has(i) || dAbove.has(j)) continue;
    const prev = from.get(j), pp = prio.get(j) ?? 9;
    if (prev == null || pr < pp || (pr === pp && ancestors(src.rig, i).has(prev))) { from.set(j, i); prio.set(j, pr); }
  }
  // продолжение: у сопоставленной пары единственный свободный ребёнок-кость с обеих сторон — тоже пара (кончики пальцев)
  const kidsOf = (r: Rig, i: number) => r.parent.flatMap((p, k) => (p === i && r.skel.nodes[k].isJoint ? [k] : []));
  for (let changed = true; changed; ) {
    changed = false;
    const used = new Set(from.values());
    for (const [j, i] of [...from]) {
      const ks = kidsOf(src.rig, i).filter((k) => !used.has(k)), kd = kidsOf(dst.rig, j).filter((k) => !from.has(k));
      if (ks.length === 1 && kd.length === 1 && kidsOf(src.rig, i).length === 1 && kidsOf(dst.rig, j).length === 1) {
        from.set(kd[0], ks[0]);
        used.add(ks[0]);
        changed = true;
      }
    }
  }
  // кость цели, у которой источник — тот же, что у её предка в той же роли, повторила бы его поворот дважды
  for (const [j, i] of [...from]) {
    for (let p = dst.rig.parent[j]; p >= 0; p = dst.rig.parent[p]) if (from.get(p) === i) { from.delete(j); break; }
  }
  // ручные пары — поверх найденного: кость цели берёт указанный источник, «null» снимает источник отовсюду
  for (const [b, d] of Object.entries(overrides)) {
    const i = src.rig.index.get(b);
    if (i == null) throw new Error(`в источнике нет кости «${b}»`);
    for (const [j, x] of [...from]) if (x === i) from.delete(j);
    if (d == null) continue;
    const j = dst.rig.index.get(d);
    if (j == null) throw new Error(`у модели нет кости «${d}»`);
    from.set(j, i);
  }
  const A = bodyTurn(src.project, dst.project);
  const side = bodyFrame(dst.project).side;
  const to = new Map([...from].map(([j, i]) => [i, j]));
  // поправка покоя: направление кости — к ближайшему сопоставленному потомку, из нескольких — к самому «срединному»
  // (у таза — позвоночник, а не бедро; у груди — шея, а не плечо)
  const O = new Map<number, Quat>();
  for (const [j, i] of from) {
    const dAnc = (k: number) => ancestors(dst.rig, k).has(j);
    let best: { dirS: Vec3; dirD: Vec3; lat: number } | undefined;
    const walk = (c: number) => {
      for (let k = 0; k < src.rig.parent.length; k++) {
        if (src.rig.parent[k] !== c) continue;
        const jj = to.get(k);
        if (jj != null && dAnc(jj)) {
          const dirS = qrot(A, vsub(src.rig.worldT[k], src.rig.worldT[i]));
          const dirD = vsub(dst.rig.worldT[jj], dst.rig.worldT[j]);
          const lat = Math.abs(vdot(dirD, side)) / (vlen(dirD) || 1);
          if (vlen(dirS) > 1e-6 && vlen(dirD) > 1e-6 && (!best || lat < best.lat)) best = { dirS, dirD, lat };
        } else walk(k);
      }
    };
    walk(i);
    O.set(j, best ? qbetween(best.dirD, best.dirS) : QI);
  }
  return { from, O, A, map };
}

/** Клип цели из кадров источника: слой поз «base» с ключом на кадр. */
/** Замкнуть цикл записи: мокап никогда не сходится точно, остаток «начало − конец» каждой кости раскладывается по
 * клипу долей t/T — последний кадр равен первому, шва нет, а за секунды движения поправка не видна. Ход таза вперёд и
 * вбок не трогаем (это ход клипа: in place или root motion), только по высоте. */
export function closeLoop(keys: PoseKey[], up: Vec3): void {
  const a = keys[0], b = keys[keys.length - 1], T = b.t - a.t;
  if (T <= 0) return;
  const bones = new Set([...Object.keys(a.rot ?? {}), ...Object.keys(b.rot ?? {})]);
  for (const bone of bones) {
    const err = qnorm(qmul(qinv(b.rot?.[bone] ?? [0, 0, 0, 1]), a.rot?.[bone] ?? [0, 0, 0, 1]));
    const e: Quat = err[3] < 0 ? (err.map((x) => -x) as Quat) : err;
    const ang = 2 * Math.acos(Math.min(1, e[3]));
    if (ang < 1e-7) continue;
    const axis = vscale([e[0], e[1], e[2]], 1 / Math.sin(ang / 2));
    for (const k of keys) {
      const q = k.rot?.[bone] ?? ([0, 0, 0, 1] as Quat);
      (k.rot ??= {})[bone] = qnorm(qmul(q, qaxis(axis, (ang * (k.t - a.t)) / T))).map(r5) as Quat;
    }
  }
  for (const bone of Object.keys(a.move ?? {})) {
    const m0 = a.move![bone], m1 = b.move?.[bone];
    if (!m1) continue;
    const dz = vdot(vsub(m0, m1), up);
    for (const k of keys) if (k.move?.[bone]) k.move[bone] = vadd(k.move[bone], vscale(up, (dz * (k.t - a.t)) / T)).map(r5) as Vec3;
  }
}

export function importClip(
  src: Side,
  dst: Side,
  frames: SourceFrame[],
  opts: { name: string; loop: boolean; fps?: number; source?: PoseLayer["source"]; map?: BoneOverrides },
): { clip: Clip; mapped: Record<string, string>; scale: number; unmapped: string[] } {
  const { from, O, A } = importPlan(src, dst, opts.map);
  const ms = measure(src), md = measure(dst);
  const k = md.height / ms.height;
  const align = restAlign(dst.project, dst.rig);
  const sp = src.project.chains.pelvis?.[0], dp = dst.project.chains.pelvis?.[0];
  const spi = sp != null ? src.rig.index.get(sp) : undefined, dpi = dp != null ? dst.rig.index.get(dp) : undefined;
  const Ai = qinv(A);
  // пол записи: у BVH, где поза покоя стоит тазом в нуле (100STYLE), высота таза зашита в ход корня, и клип висит на
  // рост таза над полом. Нижний сустав за клип против нижнего в покое: разошлись больше чем на четверть роста — это не
  // прыжок, а другой ноль; опускаем на пол покоя
  const ups = bodyFrame(src.project).up;
  const joints = src.rig.skel.nodes.flatMap((n, i) => (n.isJoint ? [i] : []));
  const restLow = Math.min(...joints.map((i) => vdot(src.rig.worldT[i], ups)));
  let low = Infinity;
  for (let fi = 0; fi < frames.length; fi += Math.max(1, Math.floor(frames.length / 60))) {
    const T = fk(src.rig, frames[fi]).T;
    for (const i of joints) low = Math.min(low, vdot(T[i], ups));
  }
  const lift: Vec3 = Number.isFinite(low) && Math.abs(restLow - low) > 0.25 * ms.height ? vscale(ups, restLow - low) : [0, 0, 0];
  const keys: PoseKey[] = frames.map((f) => {
    const s = fk(src.rig, f);
    const W: Quat[] = [];
    const key: PoseKey = { t: r5(f.t), interp: "linear" };
    dst.rig.skel.nodes.forEach((n, j) => {
      const p = dst.rig.parent[j];
      const i = from.get(j);
      if (i != null) {
        const D = qmul(s.R[i], qinv(src.rig.worldR[i]));
        W[j] = qnorm(qmul(qmul(qmul(qmul(A, D), Ai), O.get(j)!), dst.rig.worldR[j]));
      } else W[j] = p < 0 ? n.restR : qnorm(qmul(W[p], n.restR));
      const L = p < 0 ? W[j] : qmul(qinv(W[p]), W[j]);
      // дельта слоя поз: итог кости = restR · дельта · выравнивание покоя
      const d = qnorm(qmul(qmul(qinv(n.restR), L), qinv(align.get(n.name) ?? QI)));
      if (1 - Math.abs(d[3]) > 1e-9) (key.rot ??= {})[n.name] = d.map(r5) as Quat;
    });
    if (spi != null && dpi != null) {
      const v = qrot(A, vadd(vsub(s.T[spi], src.rig.worldT[spi]), lift));
      key.move = { [dp!]: v.map((x) => r5(x * k)) as Vec3 };
    }
    return key;
  });
  const duration = frames.length ? frames[frames.length - 1].t : 0;
  // запись начинается где угодно в зале захвата (100STYLE — в метрах от центра): клип — от начала координат по
  // горизонтали, высота как есть
  const up = bodyFrame(dst.project).up;
  const m0 = dp ? keys[0]?.move?.[dp] : undefined;
  if (m0) {
    const h = vsub(m0, vscale(up, vdot(m0, up)));
    for (const key of keys) if (key.move?.[dp!]) key.move[dp!] = vsub(key.move[dp!], h).map(r5) as Vec3;
  }
  if (opts.loop && keys.length > 2) closeLoop(keys, up);
  const layer: PoseLayer = { id: "base", type: "pose", keys, ...(opts.source ? { source: opts.source } : {}) };
  const clip: Clip = { name: opts.name, duration: r5(Math.max(duration, 1 / (opts.fps ?? 30))), fps: opts.fps ?? 30, loop: opts.loop, layers: [layer] };
  const mapped: Record<string, string> = {};
  for (const [j, i] of from) mapped[src.rig.skel.nodes[i].name] = dst.rig.skel.nodes[j].name;
  const used = new Set(from.values());
  const unmapped = src.rig.skel.nodes.flatMap((n, i) => (n.isJoint && !used.has(i) && Object.keys(frames[0]?.rot ?? {}).includes(n.name) ? [n.name] : []));
  return { clip, mapped, scale: +k.toFixed(4), unmapped };
}
