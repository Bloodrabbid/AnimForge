// Пресеты твинов для UI и камеры. Один JSON — единственный источник правды: по нему одинаково считают
// это ядро (предпросмотр в редакторе, рендер для агента) и аддон Godot (godot/addons/animforge/animforge.gd).
// Формулы easing и шума здесь и в GDScript обязаны совпадать — это проверяет `af tweens.verify`.

export type EaseSpec = string | { hermite: [number, number] };

export interface Segment {
  t0: number;
  t1: number;
  from: number;
  to: number;
  ease?: EaseSpec;
}

export interface ShakeSpec {
  amp: number; // размах смещения (для камеры — в единицах h/v_offset)
  freq: number; // Гц
  attack: number;
  sustain: number;
  decay: number;
  roll?: number; // градусы крена при amp = 1
  seed?: number;
}

export interface TweenTrack {
  // ui: alpha, scale, scale_x, scale_y, x, y (px, вниз = +), rotation (°) · camera: fov (°), yaw, pitch (°, вверх = +),
  // dolly (м вперёд по взгляду камеры), shake · node (любой Node3D): x, y, z (м, в осях родителя), yaw (°), forward (м по
  // взгляду узла −Z после поворота), travel (м пути по курсу: в каждый миг — вдоль текущего yaw, так что поворот во
  // время хода даёт дугу; ядро интегрирует и отдаёт смещение travel_x/travel_z в осях исходного курса). Оси — как в Godot; при переносе из Unity y и pitch меняют знак.
  prop: string;
  mode?: "abs" | "add" | "mul"; // abs — значение как есть; add — к исходному; mul — множитель исходного
  segments?: Segment[];
  shake?: ShakeSpec;
}

export interface TweenPreset {
  name: string;
  help: string;
  target: "ui" | "camera" | "node";
  duration: number;
  loop?: boolean;
  tracks: TweenTrack[];
  provenance: unknown[];
}

export function ease(spec: EaseSpec | undefined, s: number): number {
  s = Math.min(1, Math.max(0, s));
  if (spec && typeof spec === "object") {
    const [a, b] = spec.hermite;
    return (s ** 3 - 2 * s ** 2 + s) * a + (-2 * s ** 3 + 3 * s ** 2) + (s ** 3 - s ** 2) * b;
  }
  switch (spec ?? "linear") {
    case "linear": return s;
    case "inQuad": return s * s;
    case "outQuad": return 1 - (1 - s) * (1 - s);
    case "inOutSine": return -(Math.cos(Math.PI * s) - 1) / 2;
    case "outExpo": return s >= 1 ? 1 : 1 - Math.pow(2, -10 * s);
    case "outBack": { const c1 = 1.70158, c3 = c1 + 1; return 1 + c3 * (s - 1) ** 3 + c1 * (s - 1) ** 2; }
    case "outBounce": {
      const n = 7.5625, d = 2.75;
      if (s < 1 / d) return n * s * s;
      if (s < 2 / d) return n * (s -= 1.5 / d) * s + 0.75;
      if (s < 2.5 / d) return n * (s -= 2.25 / d) * s + 0.9375;
      return n * (s -= 2.625 / d) * s + 0.984375;
    }
    case "smoothstep": return s * s * (3 - 2 * s);
    case "step": return s >= 1 ? 1 : 0;
    default: throw new Error(`неизвестный ease «${spec}»`);
  }
}

function segValue(segs: Segment[], t: number): number {
  const ss = [...segs].sort((a, b) => a.t0 - b.t0);
  if (t <= ss[0].t0) return ss[0].from;
  let v = ss[0].from;
  for (const s of ss) {
    if (t < s.t0) return v; // пауза между сегментами — держим конец предыдущего
    if (t <= s.t1) return s.from + (s.to - s.from) * ease(s.ease, s.t1 > s.t0 ? (t - s.t0) / (s.t1 - s.t0) : 1);
    v = s.to;
  }
  return v;
}

/** Детерминированный «шум» тряски: сумма трёх синусов с несоизмеримыми частотами. Огибающая: attack → sustain → decay. */
export function shakeAt(sh: ShakeSpec, t: number): { x: number; y: number; roll: number } {
  const env =
    t < sh.attack ? ease("smoothstep", t / sh.attack)
    : t < sh.attack + sh.sustain ? 1
    : t < sh.attack + sh.sustain + sh.decay ? (1 - (t - sh.attack - sh.sustain) / sh.decay) ** 2
    : 0;
  const s = sh.seed ?? 1;
  const w = 2 * Math.PI * sh.freq * t;
  const n = (k: number) => 0.5 * Math.sin(w + s * k) + 0.3 * Math.sin(2.17 * w + s * k * 1.7) + 0.2 * Math.sin(3.71 * w + s * k * 2.3);
  return { x: sh.amp * env * n(1), y: sh.amp * env * n(2), roll: (sh.roll ?? 0) * sh.amp * env * n(3) };
}

/** Шагов интегрирования пути travel: одинаково в ядре и в аддоне, чтобы выборки совпадали до 1e-4. */
export const TRAVEL_STEPS = 256;

/** Смещение по дуге к моменту t: приращения пути travel, каждое — вдоль курса yaw в середине шага (вперёд — −Z). */
export function travelXZ(travel: Segment[], yaw: Segment[] | undefined, t: number): [number, number] {
  let x = 0, z = 0, prev = segValue(travel, 0);
  for (let k = 1; k <= TRAVEL_STEPS; k++) {
    const cur = segValue(travel, (t * k) / TRAVEL_STEPS);
    const a = yaw ? (segValue(yaw, (t * (k - 0.5)) / TRAVEL_STEPS) * Math.PI) / 180 : 0;
    x -= (cur - prev) * Math.sin(a);
    z -= (cur - prev) * Math.cos(a);
    prev = cur;
  }
  return [x, z];
}

/** Значения всех свойств пресета в момент t (относительные — их смысл задаёт mode трека). */
export function samplePreset(p: TweenPreset, t: number): Record<string, number> {
  if (p.loop && p.duration > 0) t = ((t % p.duration) + p.duration) % p.duration;
  const out: Record<string, number> = {};
  for (const tr of p.tracks) {
    if (tr.shake) {
      const s = shakeAt(tr.shake, t);
      out.shake_x = s.x;
      out.shake_y = s.y;
      out.shake_roll = s.roll;
    } else if (tr.segments?.length) out[tr.prop] = segValue(tr.segments, t);
  }
  const tv = p.tracks.find((tr) => tr.prop === "travel" && tr.segments?.length);
  if (tv) [out.travel_x, out.travel_z] = travelXZ(tv.segments!, p.tracks.find((tr) => tr.prop === "yaw" && tr.segments?.length)?.segments, t);
  return out;
}
