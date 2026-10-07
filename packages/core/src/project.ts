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

export type Interp = "smooth" | "linear" | "step";

export interface Key {
  t: number; // секунды
  v: number; // градусы
  interp?: Interp; // как идти от этого ключа к следующему; по умолчанию smooth
}

export interface KeyTrack {
  bone: string;
  axis: SemanticAxis;
  keys: Key[];
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
}

export interface Project {
  version: 1;
  name: string;
  model: string; // путь к glb относительно файла проекта
  up: Vec3; // «верх» мира модели; glTF — +Y
  chains: Record<string, string[]>; // имя цепочки → кости от основания к кончику
  clips: Clip[];
}

export function emptyProject(name: string, model: string): Project {
  return { version: 1, name, model, up: [0, 1, 0], chains: {}, clips: [] };
}
