// Минимальная математика кватернионов и векторов. Кватернион — [x, y, z, w], как в glTF.
export type Vec3 = [number, number, number];
export type Quat = [number, number, number, number];

export const QI: Quat = [0, 0, 0, 1];
export const DEG = Math.PI / 180;

export function qmul(a: Quat, b: Quat): Quat {
  const [ax, ay, az, aw] = a;
  const [bx, by, bz, bw] = b;
  return [
    aw * bx + ax * bw + ay * bz - az * by,
    aw * by - ax * bz + ay * bw + az * bx,
    aw * bz + ax * by - ay * bx + az * bw,
    aw * bw - ax * bx - ay * by - az * bz,
  ];
}

export const qinv = (q: Quat): Quat => [-q[0], -q[1], -q[2], q[3]];

export function qnorm(q: Quat): Quat {
  const l = Math.hypot(q[0], q[1], q[2], q[3]) || 1;
  return [q[0] / l, q[1] / l, q[2] / l, q[3] / l];
}

export function qaxis(axis: Vec3, angle: number): Quat {
  const [x, y, z] = vnorm(axis);
  const s = Math.sin(angle / 2);
  return [x * s, y * s, z * s, Math.cos(angle / 2)];
}

export function qrot(q: Quat, v: Vec3): Vec3 {
  const r = qmul(qmul(q, [v[0], v[1], v[2], 0]), qinv(q));
  return [r[0], r[1], r[2]];
}

export function vnorm(v: Vec3): Vec3 {
  const l = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / l, v[1] / l, v[2] / l];
}

export const vsub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
export const vadd = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
export const vcross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
export const vdot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const vscale = (a: Vec3, k: number): Vec3 => [a[0] * k, a[1] * k, a[2] * k];
export const vmul = (a: Vec3, b: Vec3): Vec3 => [a[0] * b[0], a[1] * b[1], a[2] * b[2]];

/** Угловая скорость (рад/с, мировой вектор) по двум поворотам с шагом h: ось·угол от q0 к q1. */
export function angVel(q0: Quat, q1: Quat, h: number): Vec3 {
  let d = qmul(q1, qinv(q0));
  if (d[3] < 0) d = [-d[0], -d[1], -d[2], -d[3]];
  const s = Math.hypot(d[0], d[1], d[2]);
  if (s < 1e-12) return [0, 0, 0];
  const ang = 2 * Math.atan2(s, d[3]);
  return [(d[0] / s) * (ang / h), (d[1] / s) * (ang / h), (d[2] / s) * (ang / h)];
}

/** Доля поворота: тот же поворот вокруг той же оси на угол·k (k = 0 — без поворота, 1 — весь). */
export function qscale(q: Quat, k: number): Quat {
  let d = q;
  if (d[3] < 0) d = [-d[0], -d[1], -d[2], -d[3]];
  const s = Math.hypot(d[0], d[1], d[2]);
  if (s < 1e-12) return QI;
  const ang = 2 * Math.atan2(s, d[3]) * k;
  return qaxis([d[0] / s, d[1] / s, d[2] / s], ang);
}
