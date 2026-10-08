// Ограничения (констрейны): диапазон движения кости по осям тела — колено не гнётся назад, шея не крутится на 360°.
// Итоговый поворот кости (поверх позы покоя и выравнивания) раскладывается на кручение вдоль оси и два изгиба
// (swing-twist, как в физических движках), каждый угол обрезается по своему диапазону, поворот собирается обратно.
// Оси — те же, что у каналов: у костей цепочки lateral / vertical / roll, у корпуса pitch / yaw / bank, поэтому
// «vertical от −10 до 120» у колена значит то же, что ключ vertical = 120 в ручном слое.
import { DEG, QI, qaxis, qinv, qmul, qnorm, qrot, vcross, vdot, vnorm, vscale, vsub, type Quat, type Vec3 } from "./math.ts";
import type { Project } from "./project.ts";
import { bodyFrame, chainAxes, type Rig } from "./evaluate.ts";

export type LimitAxis = "lateral" | "vertical" | "roll" | "pitch" | "yaw" | "bank";
export const LIMIT_AXES: LimitAxis[] = ["lateral", "vertical", "roll", "pitch", "yaw", "bank"];
/** Диапазон по осям, градусы [от, до]; оси, которых нет, свободны. */
export type BoneLimit = Partial<Record<LimitAxis, [number, number]>>;

const BODY = new Set<LimitAxis>(["pitch", "yaw", "bank"]);

/** Оси разложения кости в её локальных осях rest: кручение и два изгиба. Корпус (pitch/yaw/bank) — по осям тела,
 * кость цепочки — по осям цепочки (как у рецептов и ключей). */
export function limitFrame(rig: Rig, project: Project, bone: string, body: boolean) {
  const i = rig.index.get(bone)!;
  let names: [LimitAxis, LimitAxis, LimitAxis], world: [Vec3, Vec3, Vec3];
  if (body) {
    const f = bodyFrame(project);
    names = ["yaw", "pitch", "bank"];
    world = [f.up, f.side, f.forward];
  } else {
    const chain = Object.values(project.chains).find((c) => c.includes(bone)) ?? [bone];
    const ax = chainAxes(rig, project, chain);
    const roll = vnorm(ax.roll);
    // lateral («верх») может быть не перпендикулярен цепочке — для разложения берём его часть поперёк
    let lat = vsub(ax.lateral, vscale(roll, vdot(ax.lateral, roll)));
    lat = Math.hypot(...lat) > 1e-6 ? vnorm(lat) : vnorm(ax.vertical);
    names = ["roll", "lateral", "vertical"];
    // roll × (поперечная часть up) = along × up = vertical цепочки — тот же знак, что у канала
    world = [roll, lat, vnorm(vcross(roll, lat))];
  }
  const inv = qinv(rig.worldR[i]);
  return { names, axes: world.map((v) => qrot(inv, v)) as [Vec3, Vec3, Vec3] };
}

/** Углы поворота d (дельта в локальных осях кости) по осям рамки, градусы. */
export function decompose(d: Quat, axes: [Vec3, Vec3, Vec3]): [number, number, number] {
  const [t, a, b] = axes;
  // кручение — часть кватерниона вдоль оси t
  const p = d[0] * t[0] + d[1] * t[1] + d[2] * t[2];
  let twist: Quat = [t[0] * p, t[1] * p, t[2] * p, d[3]];
  const n = Math.hypot(...twist);
  twist = n < 1e-9 ? QI : (twist.map((x) => x / n) as Quat);
  if (twist[3] < 0) twist = twist.map((x) => -x) as Quat;
  const tw = 2 * Math.atan2(twist[0] * t[0] + twist[1] * t[1] + twist[2] * t[2], twist[3]);
  // изгиб — остаток; его вектор поворота раскладываем на две оси поперёк
  let sw = qmul(d, qinv(twist));
  if (sw[3] < 0) sw = sw.map((x) => -x) as Quat;
  const s = Math.hypot(sw[0], sw[1], sw[2]);
  const ang = 2 * Math.atan2(s, sw[3]);
  const rv: Vec3 = s < 1e-9 ? [0, 0, 0] : [(sw[0] / s) * ang, (sw[1] / s) * ang, (sw[2] / s) * ang];
  return [tw / DEG, vdot(rv, a) / DEG, vdot(rv, b) / DEG];
}

export function compose(angles: [number, number, number], axes: [Vec3, Vec3, Vec3]): Quat {
  const [t, a, b] = axes;
  const rv: Vec3 = [0, 1, 2].map((k) => (a[k] * angles[1] + b[k] * angles[2]) * DEG) as Vec3;
  const ang = Math.hypot(...rv);
  const swing = ang < 1e-12 ? QI : qaxis(vscale(rv, 1 / ang), ang);
  return qnorm(qmul(swing, qaxis(t, angles[0] * DEG)));
}

/** Применить ограничения: base — поворот кости до слоев (выравнивание позы), d — итоговый. Возвращает новый d
 * и признак, что кость упёрлась в предел. */
export function clampRotation(rig: Rig, project: Project, bone: string, lim: BoneLimit, d: Quat, base: Quat = QI): { d: Quat; hit: boolean } {
  const keys = Object.keys(lim) as LimitAxis[];
  if (!keys.length) return { d, hit: false };
  const body = keys.some((k) => BODY.has(k));
  const { names, axes } = limitFrame(rig, project, bone, body);
  const motion = qmul(d, qinv(base)); // только движение, без выравнивания позы покоя
  const ang = decompose(motion, axes);
  let hit = false;
  const out = ang.map((v, k) => {
    const r = lim[names[k]];
    if (!r) return v;
    const c = Math.min(Math.max(v, Math.min(r[0], r[1])), Math.max(r[0], r[1]));
    if (Math.abs(c - v) > 1e-6) hit = true;
    return c;
  }) as [number, number, number];
  if (!hit) return { d, hit };
  return { d: qnorm(qmul(compose(out, axes), base)), hit };
}

/** Углы кости в позе по осям ограничений — для подсказки в редакторе и для limit.fit. */
export function boneAngles(rig: Rig, project: Project, bone: string, d: Quat, base: Quat = QI, body = false): Partial<Record<LimitAxis, number>> {
  const { names, axes } = limitFrame(rig, project, bone, body);
  const a = decompose(qmul(d, qinv(base)), axes);
  return { [names[0]]: a[0], [names[1]]: a[1], [names[2]]: a[2] };
}
