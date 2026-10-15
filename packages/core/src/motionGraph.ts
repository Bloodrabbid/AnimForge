// График движения: клип сэмплируется ядром (posePartsAt → worldPose) и по каждой цепочке рига получаются кривые
// во времени — где конец цепочки (стопа, кисть, голова, кончик хвоста; у таза — сам таз), как высоко стопа над
// полом и насколько согнут главный сустав (колено, локоть); плюс размах каждой величины за клип. Ничего не пишет —
// только меряет; редактор рисует по этому график амплитуд и следы во вьюпорте.
import { bodyFrame, effectorOf, posePartsAt, worldPose, type Rig } from "./evaluate.ts";
import { Quat, Vec3, qinv, qmul, vdot, vsub } from "./math.ts";
import type { Clip, Project } from "./project.ts";

/** Что это за конечность — от этого зависит, какая точка — «конец» и какие величины осмысленны. */
export type LimbKind = "pelvis" | "body" | "head" | "hand" | "foot" | "tail" | "other";

export interface LimbCurve {
  chain: string;
  kind: LimbKind;
  /** чья точка меряется: кость (её сустав) или «кость>» — конец кости-листа */
  tip: string;
  /** главный сустав, по которому считается сгиб (колено, локоть); у цепочки из одной кости — она сама */
  joint: string;
  /** "bend" — сгиб сустава между соседними костями, "turn" — поворот одиночной кости от позы покоя */
  bendKind: "bend" | "turn";
  /** точка конца в мировых координатах модели, по кадрам */
  pos: Vec3[];
  /** смещение конца от его среднего за клип по осям тела: вверх, вперёд, вбок (влево +), единицы модели */
  up: number[];
  forward: number[];
  side: number[];
  /** только у стоп: высота над полом — над своей высотой в позе покоя (0 — стоит, как в rest) */
  lift?: number[];
  /** сгиб главного сустава, градусы (0 — прямая нога/рука; у одиночной кости — поворот от позы покоя) */
  bend: number[];
  /** опора стопы — интервалы времени [от, до], с, где она опорная (stance ядра: самая низкая и у пола) */
  stance?: [number, number][];
  /** размах за клип (пик-пик): смещения — в см (единицы модели × 100), углы — в градусах */
  amp: { up: number; forward: number; side: number; x: number; y: number; z: number; lift?: number; bend: number };
}

export interface MotionGraph {
  clip: string;
  times: number[];
  /** рост скелета в позе покоя, единицы модели */
  size: number;
  limbs: LimbCurve[];
}

const CM = 100; // единицы модели — метры (glTF), у FBX масштаб корня уже учтён в worldPose

export function limbKind(chain: string): LimbKind {
  const c = chain.toLowerCase();
  if (/^(pelvis|hips?)$/.test(c)) return "pelvis";
  if (/^(leg|foot|hindleg|paw)/.test(c)) return "foot";
  if (/^(arm|hand|foreleg)/.test(c)) return "hand";
  if (/^(head|neck)/.test(c)) return "head";
  if (/^tail/.test(c)) return "tail";
  if (/^(spine|chest|torso|body)/.test(c)) return "body";
  return "other";
}

/** Конец цепочки: стопа под последней костью (кость пола или единственный сустав-ребёнок вне цепочек), конец
 * кости-листа (варежка, кончик хвоста), иначе — сама последняя кость (таз, грудь, голова с глазами-детьми). */
function chainTip(project: Project, rig: Rig, clip: Clip, chain: string[]): { name: string; at: (w: { T: Vec3[]; R: Quat[] }) => Vec3; index: number } {
  const last = rig.index.get(chain[chain.length - 1])!;
  // кость пола — сама последняя (лапа четвероногого): её сустав и есть стопа
  if (clip.ground?.bones.includes(chain[chain.length - 1])) return { name: chain[chain.length - 1], at: (w) => w.T[last], index: last };
  const kids = rig.skel.nodes.map((n, i) => ({ n, i })).filter(({ n, i }) => n.isJoint && rig.parent[i] === last);
  const inChains = new Set(Object.values(project.chains).flat());
  const ground = clip.ground?.bones ?? [];
  const pick = kids.find(({ n }) => ground.includes(n.name)) ?? (kids.length === 1 && !inChains.has(kids[0].n.name) ? kids[0] : undefined);
  if (pick) return { name: pick.n.name, at: (w) => w.T[pick.i], index: pick.i };
  const pi = rig.parent[last];
  if (!kids.length && pi >= 0 && rig.skel.nodes[pi].isJoint) {
    const e = effectorOf(rig, last, true);
    return { name: chain[chain.length - 1] + ">", at: e, index: last };
  }
  return { name: chain[chain.length - 1], at: (w) => w.T[last], index: last };
}

const ptp = (a: number[]) => (a.length ? Math.max(...a) - Math.min(...a) : 0);
const deg = (r: number) => (r * 180) / Math.PI;
const angleBetween = (a: Vec3, b: Vec3) => {
  const la = Math.hypot(...a), lb = Math.hypot(...b);
  if (la < 1e-9 || lb < 1e-9) return 0;
  return deg(Math.acos(Math.max(-1, Math.min(1, vdot(a, b) / (la * lb)))));
};
const qangle = (q: Quat) => deg(2 * Math.acos(Math.min(1, Math.abs(q[3]))));

/** Сколько кадров сэмплировать: по fps клипа, но не меньше 24 и не больше 240. */
export const graphSteps = (clip: Clip) => Math.max(24, Math.min(240, Math.round(clip.duration * (clip.fps || 30))));

/** Кривые движения всех цепочек клипа. steps — сколько отрезков (кадров на 1 больше: последний — конец клипа). */
export function motionGraph(project: Project, rig: Rig, clip: Clip, steps = graphSteps(clip)): MotionGraph {
  const f = bodyFrame(project);
  const dt = clip.duration / steps;
  const times = Array.from({ length: steps + 1 }, (_, k) => k * dt);
  const W = times.map((t) => worldPose(rig, posePartsAt(project, rig, clip, t)));
  const hs = rig.skel.nodes.map((n, i) => (n.isJoint ? vdot(rig.worldT[i], f.up) : NaN)).filter((h) => !Number.isNaN(h));
  const size = hs.length ? Math.max(...hs) - Math.min(...hs) || 1 : 1;

  // опора стоп — по правилу фиксации опоры ядра (lockPlan, «у пола»): стопа не выше 2 % роста над самой низкой
  // точкой стоп клипа и почти вровень (0.5 %) с самой низкой стопой кадра — в двойной опоре опорные обе
  const groundIdx = (clip.ground?.bones ?? []).filter((b) => rig.index.has(b));
  const gi = groundIdx.map((b) => rig.index.get(b)!);
  const GH = W.map((w) => gi.map((i) => vdot(w.T[i], f.up)));
  const hmin = gi.length ? Math.min(...GH.flat()) : 0;
  const onFloor = GH.map((hs) => { const lo = Math.min(...hs); return hs.map((h) => h - hmin <= 0.02 * size && h - lo <= 0.005 * size); });

  const limbs: LimbCurve[] = [];
  for (const [name, chain] of Object.entries(project.chains)) {
    if (!chain.length || chain.some((b) => !rig.index.has(b))) continue;
    const tip = chainTip(project, rig, clip, chain);
    let kind = limbKind(name);
    if (groundIdx.includes(tip.name)) kind = "foot";
    const pos = W.map((w) => tip.at(w));
    const proj = (dir: Vec3) => {
      const v = pos.map((p) => vdot(p, dir));
      const m = v.reduce((a, x) => a + x, 0) / Math.max(1, v.length);
      return v.map((x) => x - m);
    };
    // сгиб: у цепочки из 2+ костей — между первой костью и следующим отрезком (бедро→голень→стопа: колено)
    const ids = chain.map((b) => rig.index.get(b)!);
    let bend: number[], joint: string, bendKind: LimbCurve["bendKind"];
    if (ids.length >= 2) {
      joint = chain[1];
      bendKind = "bend";
      bend = W.map((w) => {
        const a = w.T[ids[0]], b = w.T[ids[1]];
        const c = ids.length >= 3 ? w.T[ids[2]] : tip.at(w);
        return angleBetween(vsub(b, a), vsub(c, b));
      });
    } else {
      // одиночная кость (таз, голова): на сколько градусов она повёрнута относительно родителя от позы покоя
      joint = chain[0];
      bendKind = "turn";
      const i = ids[0], p = rig.parent[i];
      const restLocal = rig.skel.nodes[i].restR;
      bend = W.map((w) => {
        const local = p >= 0 ? qmul(qinv(w.R[p]), w.R[i]) : w.R[i];
        return qangle(qmul(qinv(restLocal), local));
      });
    }
    const limb: LimbCurve = {
      chain: name,
      kind,
      tip: tip.name,
      joint,
      bendKind,
      pos,
      up: proj(f.up),
      forward: proj(f.forward),
      side: proj(f.side),
      bend,
      amp: { up: 0, forward: 0, side: 0, x: 0, y: 0, z: 0, bend: ptp(bend) },
    };
    limb.amp.up = ptp(limb.up) * CM;
    limb.amp.forward = ptp(limb.forward) * CM;
    limb.amp.side = ptp(limb.side) * CM;
    limb.amp.x = ptp(pos.map((p) => p[0])) * CM;
    limb.amp.y = ptp(pos.map((p) => p[1])) * CM;
    limb.amp.z = ptp(pos.map((p) => p[2])) * CM;
    if (kind === "foot") {
      const rest = tip.name.endsWith(">") ? tip.at({ T: rig.worldT, R: rig.worldR }) : rig.worldT[tip.index];
      const h0 = vdot(rest, f.up);
      limb.lift = pos.map((p) => vdot(p, f.up) - h0);
      limb.amp.lift = ptp(limb.lift) * CM;
      // интервалы опоры: подряд идущие кадры, где эта стопа у пола
      const j = groundIdx.indexOf(tip.name);
      if (j >= 0) {
        const iv: [number, number][] = [];
        for (let k = 0; k < steps; k++) {
          if (!onFloor[k][j]) continue;
          if (k > 0 && onFloor[k - 1][j] && iv.length) iv[iv.length - 1][1] = times[k + 1];
          else iv.push([times[k], times[k + 1]]);
        }
        limb.stance = iv;
      }
    }
    limbs.push(limb);
  }
  return { clip: clip.name, times, size, limbs };
}
