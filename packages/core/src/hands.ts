// Позы кисти (hand.pose): кулак, расслабленно, раскрыто, указательный, хват, большой палец вверх. Пальцы — дети
// кисти с потомками: по именам (Thumb/Index/Middle/Ring/Pinky, Mixamo, Unreal, Rigify) или по геометрии (большой —
// ближе всех к запястью). Сгиб — к ладони: нормаль ладони = направление кисти × «поперёк» (от мизинца к большому),
// у правой — со сменой знака; так у любой кисти пальцы сгибаются внутрь, а не назад.
import { qaxis, qinv, qmul, qnorm, vadd, vcross, vdot, vnorm, vscale, vsub, DEG, type Quat, type Vec3 } from "./math.ts";
import type { Project } from "./project.ts";
import type { Rig } from "./evaluate.ts";
import { standardNames } from "./naming.ts";

export interface Finger {
  name: "thumb" | "index" | "middle" | "ring" | "pinky" | "other";
  bones: string[]; // от основания к кончику (без кости-листа на конце, если у неё нет своей длины)
}

/** Сгибы суставов пальцев, ° (основание, средний, кончик); thumb — у большого. */
export const HAND_POSES: Record<string, { help: string; fingers: [number, number, number]; thumb: [number, number, number]; index?: [number, number, number] }> = {
  fist: { help: "кулак", fingers: [75, 95, 70], thumb: [25, 40, 35] },
  relaxed: { help: "расслабленно, пальцы чуть согнуты", fingers: [15, 25, 15], thumb: [10, 12, 10] },
  open: { help: "раскрыта, пальцы прямые", fingers: [0, 0, 0], thumb: [0, 0, 0] },
  point: { help: "указательный вытянут, остальные в кулак", fingers: [75, 95, 70], thumb: [25, 40, 35], index: [0, 0, 0] },
  grip: { help: "хват рукояти (меч, молоток, фонарь)", fingers: [55, 65, 45], thumb: [30, 30, 20] },
  thumbs_up: { help: "кулак, большой палец вверх", fingers: [75, 95, 70], thumb: [-10, 0, 0] },
};
export const HAND_POSES_SOURCE = "на глаз — углы сгибов по анатомии кисти, не из разборов игр";

const NAMES: [Finger["name"], RegExp][] = [["thumb", /thumb/i], ["index", /index|pointer/i], ["middle", /middle/i], ["ring", /ring/i], ["pinky", /pinky|little/i]];

/** Кисть и пальцы стороны side. */
export function fingersOf(project: Project, rig: Rig, side: "l" | "r"): { hand: string; fingers: Finger[] } | undefined {
  const std = [...standardNames(project, rig, "unreal")].find(([, n]) => n === `hand_${side}`)?.[0];
  if (!std) return undefined;
  const hi = rig.index.get(std)!;
  const kids = (i: number) => rig.parent.flatMap((p, k) => (p === i && rig.skel.nodes[k].isJoint ? [k] : []));
  const fingers: Finger[] = [];
  for (const k of kids(hi)) {
    const path = [k];
    for (let c = kids(k); c.length; c = kids(path[path.length - 1])) path.push(c[0]);
    if (path.length < 2) continue;
    // последняя кость-лист — только кончик (Mixamo *4), её не сгибаем
    const bones = path.slice(0, -1).map((i) => rig.skel.nodes[i].name);
    const nm = NAMES.find(([, re]) => re.test(rig.skel.nodes[k].name))?.[0] ?? "other";
    fingers.push({ name: nm, bones });
  }
  if (!fingers.length) return undefined;
  // без имён: большой — тот, чьё основание ближе всех к запястью
  if (!fingers.some((f) => f.name === "thumb")) {
    const d = (f: Finger) => Math.hypot(...vsub(rig.worldT[rig.index.get(f.bones[0])!], rig.worldT[hi]));
    fingers.reduce((a, b) => (d(a) < d(b) ? a : b)).name = "thumb";
  }
  return { hand: std, fingers };
}

/** Добавочные повороты костей пальцев (как у ключа позы) для позы pose. */
export function handPose(project: Project, rig: Rig, side: "l" | "r", pose: string): Record<string, Quat> {
  const def = HAND_POSES[pose];
  if (!def) throw new Error(`поза кисти: ${Object.keys(HAND_POSES).join(", ")}`);
  const h = fingersOf(project, rig, side);
  if (!h) throw new Error(`у кисти ${side} нет пальцев`);
  const at = (b: string) => rig.worldT[rig.index.get(b)!];
  const W = at(h.hand);
  const thumb = h.fingers.find((f) => f.name === "thumb");
  const others = h.fingers.filter((f) => f !== thumb);
  const mean = (fs: Finger[]) => vscale(fs.reduce((a, f) => vadd(a, at(f.bones[0])), [0, 0, 0] as Vec3), 1 / Math.max(1, fs.length));
  const dir = vnorm(vsub(mean(others.length ? others : h.fingers), W));
  // поперёк ладони — к большому пальцу, без составляющей вдоль кисти
  let across: Vec3 = thumb && others.length ? vsub(at(thumb.bones[0]), mean(others)) : [0, 0, 1];
  across = vnorm(vsub(across, vscale(dir, vdot(across, dir))));
  const palm = vscale(vnorm(vcross(dir, across)), side === "l" ? 1 : -1);
  const out: Record<string, Quat> = {};
  for (const f of h.fingers) {
    const ang = f.name === "thumb" ? def.thumb : f.name === "index" && def.index ? def.index : def.fingers;
    f.bones.forEach((b, j) => {
      const i = rig.index.get(b)!;
      const next = f.bones[j + 1] ?? rig.skel.nodes[rig.parent.findIndex((p) => p === i)]?.name;
      const fd = next && rig.index.has(next) ? vnorm(vsub(at(next), at(b))) : dir;
      const a = ang[Math.min(j, 2)];
      if (!a) return;
      const axis = vnorm(vcross(fd, palm));
      const w = rig.worldR[i];
      out[b] = qnorm(qmul(qmul(qinv(w), qaxis(axis, a * DEG)), w));
    });
  }
  return out;
}
