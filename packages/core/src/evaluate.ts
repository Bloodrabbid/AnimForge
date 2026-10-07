// Вычисление позы: rest-поза → слои рецептов → ручной слой. Работает одинаково в браузере и в Node.
import { evalKeys } from "./curves.ts";
import { DEG, QI, Quat, Vec3, qaxis, qinv, qmul, qnorm, qrot, vcross, vnorm, vsub } from "./math.ts";
import type { Clip, Project, SemanticAxis, Skeleton } from "./project.ts";
import { RECIPES, withDefaults } from "./recipes.ts";

export interface Rig {
  skel: Skeleton;
  index: Map<string, number>;
  worldR: Quat[]; // мировой поворот узла в rest-позе
  worldT: Vec3[];
}

export function buildRig(skel: Skeleton): Rig {
  const index = new Map(skel.nodes.map((n, i) => [n.name, i]));
  const worldR: Quat[] = [], worldT: Vec3[] = [];
  skel.nodes.forEach((n, i) => {
    const p = n.parent == null ? -1 : index.get(n.parent)!;
    if (p < 0) {
      worldR[i] = n.restR;
      worldT[i] = n.restT;
    } else {
      worldR[i] = qnorm(qmul(worldR[p], n.restR));
      const off = qrot(worldR[p], n.restT);
      worldT[i] = [worldT[p][0] + off[0], worldT[p][1] + off[1], worldT[p][2] + off[2]];
    }
  });
  return { skel, index, worldR, worldT };
}

/** Мировые оси цепочки: lateral — вокруг «верха», vertical — вокруг бока, roll — вдоль цепочки. */
export function chainAxes(rig: Rig, project: Project, chain: string[]): Record<SemanticAxis, Vec3> {
  const a = rig.worldT[rig.index.get(chain[0])!];
  const b = rig.worldT[rig.index.get(chain[chain.length - 1])!];
  const along = vnorm(vsub(b, a));
  const up = vnorm(project.up);
  const side = vnorm(vcross(along, up));
  return { lateral: up, vertical: side, roll: along };
}

/** Мировая ось → поворот в локальном пространстве кости (чтобы рецепт не зависел от осей конкретного рига). */
function localDelta(rig: Rig, bone: number, worldAxis: Vec3, angle: number): Quat {
  const w = rig.worldR[bone];
  return qmul(qmul(qinv(w), qaxis(worldAxis, angle)), w);
}

function chainOf(project: Project, bone: string): string[] | undefined {
  return Object.values(project.chains).find((c) => c.includes(bone));
}

/** Локальные повороты всех затронутых костей в момент t. Остальные кости остаются в rest-позе. */
export function poseAt(project: Project, rig: Rig, clip: Clip, t: number): Map<string, Quat> {
  const pose = new Map<string, Quat>();
  const apply = (bone: string, axisWorld: Vec3, deg: number) => {
    const i = rig.index.get(bone);
    if (i == null || deg === 0) return;
    const cur = pose.get(bone) ?? QI;
    pose.set(bone, qnorm(qmul(cur, localDelta(rig, i, axisWorld, deg * DEG))));
  };
  for (const layer of clip.layers) {
    if (layer.type === "recipe") {
      const def = RECIPES[layer.recipe];
      const chain = project.chains[layer.target.chain];
      if (!def || !chain) continue;
      const p = withDefaults(def, layer.params);
      const axes = chainAxes(rig, project, chain);
      const w = layer.weight ?? 1;
      chain.forEach((bone, i) => {
        const angles = def.evaluate(p, i, chain.length, t);
        for (const [ax, deg] of Object.entries(angles)) apply(bone, axes[ax as SemanticAxis], (deg as number) * w);
      });
    } else {
      for (const tr of layer.tracks) {
        const chain = chainOf(project, tr.bone) ?? [tr.bone];
        const axes = chainAxes(rig, project, chain.length > 1 ? chain : [chain[0], chain[0]]);
        apply(tr.bone, axes[tr.axis], evalKeys(tr.keys, t, clip.loop, clip.duration));
      }
    }
  }
  // итог: rest * delta
  const out = new Map<string, Quat>();
  for (const [bone, d] of pose) out.set(bone, qnorm(qmul(rig.skel.nodes[rig.index.get(bone)!].restR, d)));
  return out;
}

export interface Baked {
  times: number[];
  rotations: Map<string, Quat[]>;
}

/** Запекание клипа в ключи с частотой fps. Для цикла последний кадр совпадает с первым. */
export function bakeClip(project: Project, rig: Rig, clip: Clip): Baked {
  const n = Math.max(1, Math.round(clip.duration * clip.fps));
  const times = Array.from({ length: n + 1 }, (_, k) => (k * clip.duration) / n);
  const rotations = new Map<string, Quat[]>();
  times.forEach((t, k) => {
    const pose = poseAt(project, rig, clip, clip.loop && k === n ? 0 : t);
    for (const [bone, q] of pose) {
      if (!rotations.has(bone)) rotations.set(bone, []);
      rotations.get(bone)![k] = q;
    }
  });
  // кость могла быть неподвижной в части кадров — дозаполняем rest-позой
  for (const [bone, arr] of rotations) {
    const rest = rig.skel.nodes[rig.index.get(bone)!].restR;
    for (let k = 0; k <= n; k++) arr[k] ??= rest;
  }
  return { times, rotations };
}
