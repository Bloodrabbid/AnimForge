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

/** Повороты вокруг осей всего тела (одинаковы для любого рига): pitch — вокруг бока (+ — верх уходит вперёд,
 * свисающая рука — назад), yaw — вокруг вертикали (+ — влево), bank — вокруг «вперёд» (+ — верх уходит вправо). */
export type BodyAxis = "pitch" | "yaw" | "bank";

/** Любой канал, который выдают рецепты и ручные ключи. Повороты — в градусах. */
export type Channel = SemanticAxis | BodyAxis | MoveAxis | ScaleAxis;
export const CHANNELS: Channel[] = ["lateral", "vertical", "roll", "pitch", "yaw", "bank", "move_up", "move_forward", "move_side", "scale_up", "scale_forward", "scale_side"];

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
  /** Правка кривых слоя (как Late / Amount / Step в ActionForge): late — сдвиг по фазе, доля периода (+ — позже);
   * amount — размах вокруг среднего за период (×); step — задержка каждой следующей кости цепочки, доля периода. */
  shape?: { late?: number; amount?: number; step?: number };
}

export interface KeyLayer {
  id: string;
  type: "keys";
  tracks: KeyTrack[]; // добавочные повороты поверх нижних слоёв
}

/** Ключ позы: добавочные повороты костей (кватернион-дельта в локальных осях позы покоя, поверх нижних слоёв)
 * и сдвиги (мировые, м) в момент t. Так записывается поза, которую тянули мышью или pose.reach. */
export interface PoseKey {
  t: number;
  rot?: Record<string, Quat>;
  move?: Record<string, Vec3>;
  interp?: Interp; // как идти к следующему ключу; по умолчанию smooth
}

export interface PoseLayer {
  id: string;
  type: "pose";
  keys: PoseKey[];
}

export type Layer = RecipeLayer | KeyLayer | PoseLayer;

/** Цель констрейна: точка в координатах модели (как у костей в rest), кость (+ сдвиг в мировых осях) или
 * точка с ключами по времени — цель движется, рука или взгляд следуют. */
export interface ConstraintTarget {
  pos?: Vec3;
  bone?: string;
  offset?: Vec3;
  keys?: { t: number; pos: Vec3; interp?: Interp }[];
}

/** Взгляд: кости bones (от основания к кончику, например шея и голова) поворачиваются так, чтобы «вперёд»
 * последней (направление forward тела в позе покоя) смотрело на цель; поворот делится между костями поровну. */
export interface AimConstraint {
  id: string;
  type: "aim";
  bones: string[];
  target: ConstraintTarget;
  weight?: number; // 0…1, доля поворота к цели
  muted?: boolean;
}

/** IK: кончик tip (кисть, стопа) тянется к цели, сгибаются его родитель и дед (локоть и плечо, колено и бедро).
 * pole — точка, в сторону которой смотрит сгиб (локоть назад, колено вперёд); без неё — сохраняется текущая
 * плоскость сгиба. */
export interface IKConstraint {
  id: string;
  type: "ik";
  tip: string;
  /** у кости-кончика нет дочерней (рука-варежка): тянется конец самой tip, длиной как её родитель;
   * сгибаются tip и её родитель */
  end?: boolean;
  target: ConstraintTarget;
  pole?: Vec3;
  /** сколько костей сгибать, считая вверх от кончика: 2 — рука или нога, больше — ещё ключица и позвоночник,
   * весь хвост. Пределы суставов учитываются при подборе позы, а не обрезают её потом. */
  length?: number;
  weight?: number;
  muted?: boolean;
}

/** Копия поворота: кости bones повторяют движение костей source (попарно) — хвост вслед за тазом, второе ухо
 * за первым, пальцы за одним. Берётся движение источника от его позы покоя и выравнивания, в мировых осях позы
 * покоя, и добавляется поверх своей анимации. weight — множитель (−1 — в обратную сторону, 0.5 — вполовину);
 * mirror — зеркально через плоскость симметрии тела (левая рука повторяет правую). */
export interface CopyConstraint {
  id: string;
  type: "copy";
  bones: string[];
  source: string[];
  weight?: number;
  mirror?: boolean;
  muted?: boolean;
}

export type Constraint = AimConstraint | IKConstraint | CopyConstraint;

export interface Clip {
  name: string;
  duration: number;
  fps: number;
  loop: boolean;
  layers: Layer[];
  /** Постановка на пол: после всех слоёв корень сдвигается по up так, чтобы нижняя из bones стояла на высоте покоя.
   * contact — прижимать всегда (опорная нога на полу); floor — только не проваливаться (подскоки сохраняются). */
  ground?: { bones: string[]; mode: "contact" | "floor"; ik?: boolean; flat?: boolean; lock?: boolean }; // ik — сгибать колени, а не двигать тело; flat — опорная стопа плоско; lock — опорная стопа стоит на месте (у цикла походки)
  /** Констрейны клипа: после слоёв и пола, до вторичной динамики; ограничения суставов действуют и на них. */
  constraints?: Constraint[];
  /** Ход под углом (8 направлений из прямой ходьбы, clip.directions): после слоёв, до пределов и пола. */
  travel?: Travel;
  /** Стиль походки поверх любых слоёв (clip.gait): быстрее, ниже, тяжелее… — до хода под углом. */
  gait?: GaitStyle;
  /** Догоняющее движение (clip.follow): грудь догоняет таз, голова и руки — грудь, через пружину. После всех
   * основных слоёв и пола, до вторичной динамики. lag — запаздывание, с; bounce — перелёт 0…1; loosen — доля 0…1. */
  follow?: { lag?: number; bounce?: number; loosen?: number };
  /** Зеркально: левая сторона делает то, что правая (clip.mirror) — последней стадией позы. */
  mirror?: boolean;
  /** Задом наперёд (clip.reverse): время клипа идёт от конца к началу, события — в зеркальные моменты. */
  reverse?: boolean;
  /** На месте (clip.inPlace) по осям тела: forward, side, up, yaw — ход клипа «конец − начало» снимается с таза и корня. */
  inPlace?: ("forward" | "side" | "up" | "yaw")[];
}

/** Ручки стиля походки — для любого цикла ходьбы, не зависят от рецепта. Множители (×) — вокруг среднего за цикл:
 * подскок ×0 — таз на средней высоте, ×2 — вдвое выше и ниже её. */
export interface GaitStyle {
  /** скорость хода ×: частота шагов растёт как speed^0.6, длина шага — как speed^0.4 (длина клипа делится на частоту) */
  speed?: number;
  /** подскок таза × */
  bounce?: number;
  /** раскачка таза (рыскание и крен) × */
  sway?: number;
  /** мах рук × */
  arms?: number;
  /** подъём стопы в переносе — сгиб колена × */
  lift?: number;
  /** колея: ноги наружу, ° */
  width?: number;
  /** таз ниже — доля роста (ноги согнуты; нужен clip.ground с ik) */
  lower?: number;
  /** наклон корпуса вперёд, ° (голова наклоняется вместе с ним) */
  lean?: number;
  /** сутулость: грудь вперёд, голова обратно — смотрит прямо, ° */
  posture?: number;
}

/** Ход под углом к взгляду. Углы — вокруг up, градусы, + — влево (как yaw тела). Мах ног поворачивается вокруг
 * вертикали так, что стопы идут в сторону angle, а колено гнётся как обычно, вперёд (так и у людей при стрейфе). */
export interface Travel {
  /** куда идёт: 0 — вперёд, 90 — влево, −90 — вправо, 180 — назад */
  angle: number;
  /** таз доворачивает к ходу, ° */
  hips?: number;
  /** грудь возвращает долю поворота таза — плечи на цель (1 — целиком) */
  chest?: number;
  /** голова возвращает остаток (1 — смотрит вперёд, 0 — туда же, куда грудь) */
  look?: number;
  /** куда смотрят стопы и колени, ° (полный угол; 0 — вперёд, angle — по ходу) */
  feet?: number;
  /** ноги отводятся вбок, °: колея шире, чтобы при стрейфе голени не задевали друг друга */
  width?: number;
  /** размах маха ног — доля прямого шага (шаг вбок короче) */
  stride?: number;
  /** плоскость маха ног, ° (по умолчанию angle). Таз в рецептах ходьбы рыщет и кренится — это тоже возит стопы
   * вперёд-назад, поэтому тело идёт чуть не туда, куда машут ноги; clip.directions подбирает swing по замеру. */
  swing?: number;
  /** проиграть клип назад во времени: ходьба назад — это прямая ходьба наоборот (у NPC Witcher — точный реверс);
   * тогда подскок, крен и сгиб колена приходят в свои моменты шага, а не в моменты прямой ходьбы */
  reverse?: boolean;
}

export interface Project {
  version: 1;
  name: string;
  model: string; // путь к glb относительно файла проекта
  up: Vec3; // «верх» мира модели; glTF — +Y
  forward?: Vec3; // куда смотрит персонаж; по умолчанию +Z (так экспортирует Blender: его −Y → glTF +Z)
  /** Выравнивание позы покоя перед всеми слоями: цепочка разворачивается к направлению тела (руки из T-позы — вниз).
   * to — куда смотрит цепочка: down; abduct — отвести от тела вбок на столько градусов (A-поза). */
  align?: Record<string, { to: "down"; abduct?: number }>;
  chains: Record<string, string[]>; // имя цепочки → кости от основания к кончику
  /** Ограничения: диапазон движения кости по осям, градусы [от, до] (limits.ts). Действуют на все клипы. */
  limits?: Record<string, Partial<Record<"lateral" | "vertical" | "roll" | "pitch" | "yaw" | "bank", [number, number]>>>;
  clips: Clip[];
  /** Карточка стиля: что нужно игре — по ней судят автопроверки и критик. Заполняет агент из запроса. */
  style?: StyleCard;
  /** Куда класть готовый glb в игре на Godot (папка внутри проекта Godot) — make копирует туда после экспорта. */
  godot?: string;
}

export interface StyleCard {
  genre?: string; // жанр и камера: «экшен от третьего лица», «вид сверху»
  stylization?: "realistic" | "stylized" | "cartoon" | string;
  role?: "player" | "enemy" | "npc" | string; // чей персонаж: у игрока короткий замах, у врага читаемый
  fps?: number; // частота игры — частота запекания клипов
  refs?: string[]; // игры-ориентиры: «как в DREDGE»
  notes?: string;
}

export function emptyProject(name: string, model: string): Project {
  return { version: 1, name, model, up: [0, 1, 0], chains: {}, clips: [] };
}
