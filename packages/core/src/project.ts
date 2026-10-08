// Модель проекта. Хранится текстом (animforge.json), чтобы её одинаково удобно правили человек, агент и git.
import type { Quat, Vec3 } from "./math.ts";

export interface Bone {
  name: string;
  parent: string | null; // имя родительского узла (кости или нет — неважно)
  restT: Vec3;
  restR: Quat;
  restS: Vec3;
  isJoint: boolean; // входит ли в skin
}

export interface Skeleton {
  nodes: Bone[]; // все узлы сцены в порядке «родитель раньше ребёнка»
}

/** Ось вращения в понятных терминах тела, а не в локальных осях кости. */
export type SemanticAxis = "lateral" | "vertical" | "roll";

/** Сдвиг кости в метрах по направлениям тела: up — project.up, forward — project.forward, side = up × forward. */
export type MoveAxis = "move_up" | "move_forward" | "move_side";

/** Масштаб кости (множитель) вдоль направлений тела; ось кости выбирается та, что ближе к направлению. */
export type ScaleAxis = "scale_up" | "scale_forward" | "scale_side";

/** Любой канал, который выдают рецепты и ручные ключи. Повороты — в градусах. */
export type Channel = SemanticAxis | MoveAxis | ScaleAxis;
export const CHANNELS: Channel[] = ["lateral", "vertical", "roll", "move_up", "move_forward", "move_side", "scale_up", "scale_forward", "scale_side"];

export type Interp = "smooth" | "linear" | "step";

export interface Key {
  t: number; // секунды
  v: number; // градусы, метры или множитель — по каналу трека
  interp?: Interp; // как идти от этого ключа к следующему; по умолчанию smooth
}

export interface KeyTrack {
  bone: string;
  axis: Channel;
  keys: Key[]; // для scale_* значение — добавка к 1 (0 = без изменений), чтобы ключи складывались
}

export interface RecipeLayer {
  id: string;
  type: "recipe";
  recipe: string; // имя в реестре рецептов
  target: { chain: string };
  params: Record<string, number | string | boolean>;
  preset?: string; // из какого пресета библиотеки взяты параметры
  weight?: number;
}

export interface KeyLayer {
  id: string;
  type: "keys";
  tracks: KeyTrack[]; // добавочные повороты поверх нижних слоёв
}

export type Layer = RecipeLayer | KeyLayer;

export interface Clip {
  name: string;
  duration: number;
  fps: number;
  loop: boolean;
  layers: Layer[];
  /** Постановка на пол: после всех слоёв корень сдвигается по up так, чтобы нижняя из bones стояла на высоте покоя.
   * contact — прижимать всегда (опорная нога на полу); floor — только не проваливаться (подскоки сохраняются). */
  ground?: { bones: string[]; mode: "contact" | "floor"; ik?: boolean }; // ik — сгибать колени, а не двигать тело
}

export interface Project {
  version: 1;
  name: string;
  model: string; // путь к glb относительно файла проекта
  up: Vec3; // «верх» мира модели; glTF — +Y
  forward?: Vec3; // куда смотрит персонаж; по умолчанию +Z (так экспортирует Blender: его −Y → glTF +Z)
  chains: Record<string, string[]>; // имя цепочки → кости от основания к кончику
  clips: Clip[];
}

export function emptyProject(name: string, model: string): Project {
  return { version: 1, name, model, up: [0, 1, 0], chains: {}, clips: [] };
}
