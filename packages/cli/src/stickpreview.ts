// Живое превью движения для библиотеки: скелет модели проекта в этом движении — кадры суставов в 2D (вид спереди на
// три четверти, как у камеры редактора), без рендера. Карточка на наведении рисует их на холсте по кругу.
import { bodyFrame, buildRig, posePartsAt, qaxis, qrot, vdot, worldPose, type Clip, type Project, type Skeleton } from "../../core/src/index.ts";

export interface StickAnim {
  fps: number;
  /** пары индексов суставов (родитель, ребёнок) — палки */
  edges: [number, number][];
  /** кадры: [x, y] каждого сустава в долях окна 0…1 (y вниз), окно — по всем кадрам клипа, пропорции сохранены */
  frames: [number, number][][];
}

export function stickAnim(project: Project, skeleton: Skeleton, clip: Clip, o: { fps?: number; maxT?: number } = {}): StickAnim {
  const rig = buildRig(skeleton);
  const fps = o.fps ?? 15;
  const T = Math.min(clip.duration, o.maxT ?? 4);
  const n = Math.max(2, Math.round(T * fps));
  const f = bodyFrame(project);
  // три четверти: камера повёрнута от «спереди» на 35° вокруг вертикали
  const view = qrot(qaxis(f.up, (35 * Math.PI) / 180), f.forward);
  const right = [view[1] * f.up[2] - view[2] * f.up[1], view[2] * f.up[0] - view[0] * f.up[2], view[0] * f.up[1] - view[1] * f.up[0]] as [number, number, number];
  const joints = skeleton.nodes.flatMap((nd, i) => (nd.isJoint ? [i] : []));
  const slot = new Map(joints.map((j, k) => [j, k]));
  const edges: [number, number][] = [];
  for (const j of joints) {
    let p = rig.parent[j];
    while (p >= 0 && !slot.has(p)) p = rig.parent[p];
    if (p >= 0) edges.push([slot.get(p)!, slot.get(j)!]);
  }
  const raw = Array.from({ length: n }, (_, k) => {
    const w = worldPose(rig, posePartsAt(project, rig, clip, (k / n) * T));
    return joints.map((j) => [vdot(w.T[j], right), vdot(w.T[j], f.up)] as [number, number]);
  });
  const xs = raw.flat().map((p) => p[0]), ys = raw.flat().map((p) => p[1]);
  const x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys);
  const s = Math.max(x1 - x0, y1 - y0, 1e-6) * 1.08;
  const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
  const r3 = (v: number) => Math.round(v * 1000) / 1000;
  const frames = raw.map((fr) => fr.map(([x, y]) => [r3(0.5 + (x - cx) / s), r3(0.5 - (y - cy) / s)] as [number, number]));
  return { fps, edges, frames };
}
