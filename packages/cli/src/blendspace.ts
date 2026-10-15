// BlendSpace2D для Godot: восемь направлений ходьбы (и стойка в центре) — ресурс .tres, который ставится корнем
// AnimationTree или узлом в его машине состояний. Позиция смешивания — куда идёт персонаж в его осях: y — вперёд,
// x — вправо (как ввод джойстика), длина — скорость (1 — эта ходьба). Клипы одной длины и с одной фазы шага
// (так их делает clip.directions), поэтому sync: ноги не путаются при смешивании соседних направлений.

export interface BlendPoint {
  anim: string;
  /** направление хода, ° (+ — влево, как travel.angle); у стойки — undefined (центр) */
  angle?: number;
  speed?: number;
}

/** Точка BlendSpace2D для угла хода: вперёд (0°) — (0, 1), влево (90°) — (−1, 0). */
export const blendPos = (angle: number, speed = 1): [number, number] => {
  const a = (angle * Math.PI) / 180;
  const r = (x: number) => Math.round(x * 1e6) / 1e6 + 0; // без −0
  return [r(-Math.sin(a) * speed), r(Math.cos(a) * speed)];
};

export function blendSpace2D(points: BlendPoint[], o: { library?: string } = {}): string {
  const lib = o.library ? `${o.library}/` : "";
  const max = Math.max(1, ...points.map((p) => p.speed ?? 1));
  const subs = points.map((p, i) => `[sub_resource type="AnimationNodeAnimation" id="a${i}"]\nanimation = &"${lib}${p.anim}"\n`);
  const pts = points.map((p, i) => {
    const [x, y] = p.angle == null ? [0, 0] : blendPos(p.angle, p.speed ?? 1);
    return `blend_point_${i}/node = SubResource("a${i}")\nblend_point_${i}/pos = Vector2(${x}, ${y})`;
  });
  return [
    `[gd_resource type="AnimationNodeBlendSpace2D" load_steps=${points.length + 1} format=3]`,
    "",
    ...subs,
    "[resource]",
    ...pts,
    `min_space = Vector2(${-max}, ${-max})`,
    `max_space = Vector2(${max}, ${max})`,
    'x_label = "вправо"',
    'y_label = "вперёд"',
    "sync = true",
    "",
  ].join("\n");
}
