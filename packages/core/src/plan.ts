// Пресет библиотеки → клип: какие цепочки нужны рецепту, сколько длится клип, какими командами его собрать,
// и поиск пресета по словам («ленивая ходьба», «удар»). Общее для веб-редактора (примерка) и команды make.
import { RECIPES, withDefaults } from "./recipes.ts";
import type { Project, StyleCard } from "./project.ts";

export interface LibPreset {
  name: string;
  help: string;
  params: Record<string, unknown>;
  provenance?: { source: string; [k: string]: unknown }[];
}

export interface LibRecipe {
  recipe: string;
  help?: string;
  roles: Record<string, { chain: string; optional: boolean }> | null;
  presets: LibPreset[];
}

export interface Step {
  name: string;
  args: Record<string, unknown>;
}

/** Роли рецепта в виде «роль → цепочка» (рука для ударов — правая). */
export function libRoles(recipe: string): LibRecipe["roles"] {
  const def = RECIPES[recipe];
  return def?.roles
    ? Object.fromEntries(Object.entries(def.roles).map(([role, r]) => [role, { chain: typeof r.chain === "function" ? r.chain("r") : r.chain, optional: !!r.optional }]))
    : null;
}

export const CATEGORIES: { id: string; title: string; recipes: string[] }[] = [
  { id: "walk", title: "Ходьба", recipes: ["waddle-walk", "compass-step"] },
  { id: "quad", title: "Четвероногие", recipes: ["quadruped-gait"] },
  { id: "multi", title: "Многоногие", recipes: ["multileg-gait"] },
  { id: "wing", title: "Крылья и ласты", recipes: ["wing-flap"] },
  { id: "swim", title: "Плавание и хвосты", recipes: ["wave", "curl", "zero-g-float"] },
  { id: "hover", title: "Парение", recipes: ["hover", "scare-pose"] },
  { id: "fight", title: "Удары", recipes: ["melee-strike", "charge-release", "tentacle-strike", "body-ram"] },
  { id: "react", title: "Реакции", recipes: ["hit-react", "startle"] },
  { id: "emerge", title: "Появление", recipes: ["emerge"] },
  { id: "small", title: "Мелочи", recipes: ["blink", "jiggle", "tremble", "idle-glance"] },
];
export const categoryOf = (recipe: string) => CATEGORIES.find((c) => c.recipes.includes(recipe))?.id ?? "small";

/** Рецепты на один раз (удар, появление) — клип не зациклен. */
export const ONE_SHOT = new Set(["melee-strike", "charge-release", "tentacle-strike", "emerge", "body-ram", "hit-react", "startle", "scare-pose"]);

/** Цепочки, которые подходят рецепту без ролей, — в порядке предпочтения. */
const CHAIN_PREF: Record<string, string[]> = {
  wave: ["body", "tail", "spine"],
  curl: ["tail", "body", "spine"],
  jiggle: ["tail", "body", "spine"],
  "tentacle-strike": ["body", "tail", "spine"],
  emerge: ["body", "pelvis", "spine"],
};
export function chainsFor(recipe: string, chains: Record<string, string[]>): string[] {
  const all = Object.keys(chains);
  const pref = (CHAIN_PREF[recipe] ?? []).filter((c) => chains[c]);
  return [...pref, ...all.filter((c) => !pref.includes(c))];
}

/** Подходит ли рецепт скелету: у рецепта с ролями должны быть все обязательные цепочки. */
export function missingChains(roles: LibRecipe["roles"], chains: Record<string, string[]>): string[] {
  if (!roles) return Object.keys(chains).length ? [] : ["любая цепочка"];
  const rs = Object.values(roles);
  const missing = [...new Set(rs.filter((r) => !r.optional && !chains[r.chain]).map((r) => r.chain))];
  // обязательных ролей нет (лапы многоногого: leg_l0…leg_r11) — нужна хотя бы одна главная, той же породы, что первая роль;
  // таз или позвоночник сами по себе походку не делают
  if (!missing.length && !rs.some((r) => !r.optional)) {
    const kind = rs[0]?.chain.match(/^[a-z]+/)?.[0] ?? "";
    if (!rs.some((r) => r.chain.startsWith(kind) && chains[r.chain])) return [`${rs[0]?.chain ?? "цепочки"}…`];
  }
  return missing;
}

/** Какие разделы ближе всего телу из rig.detect — их движения идут первыми. */
export const BODY_FIRST: Record<string, string[]> = {
  quadruped: ["quad", "small", "swim"],
  multileg: ["multi", "swim"],
  winged: ["wing", "hover"],
  finned: ["wing", "swim", "hover"],
  biped: ["walk", "fight", "hover"],
  other: ["swim", "emerge", "fight"],
};

/** Длительность клипа под пресет: цикл — целое число периодов около 2 с, разовый — своя длительность. */
export function presetDuration(recipe: string, params: Record<string, unknown>): number {
  const def = RECIPES[recipe];
  const p = withDefaults(def, params);
  if (def.length) return def.length(p);
  const period = Number(p.period);
  const d = period > 0 ? period * Math.max(1, Math.round(2 / period)) : Number(p.duration) > 0 ? Number(p.duration) : 1.6;
  return +d.toFixed(3);
}

/** Команды, которые собирают клип name из пресета: клип, слои (на все роли или на одну цепочку), лапы на пол. */
export function clipSteps(
  o: { recipe: string; preset: LibPreset; name: string; chains: Record<string, string[]>; paws?: string[]; chain?: string; params?: Record<string, unknown>; fps?: number; side?: "l" | "r" },
): Step[] {
  const params = { ...o.preset.params, ...(o.params ?? {}) };
  const roles = !!RECIPES[o.recipe]?.roles;
  const steps: Step[] = [
    { name: "clip.add", args: { name: o.name, duration: presetDuration(o.recipe, params), loop: !ONE_SHOT.has(o.recipe), ...(o.fps ? { fps: o.fps } : {}) } },
    roles
      ? { name: "recipe.rig", args: { clip: o.name, recipe: o.recipe, preset: o.preset.name, ...(o.params ? { params: o.params } : {}), ...(o.side ? { side: o.side } : {}) } }
      : { name: "preset.apply", args: { clip: o.name, preset: o.preset.name, chain: o.chain ?? chainsFor(o.recipe, o.chains)[0] } },
  ];
  // походка четвероногого и многоногого — лапы на пол, колени сгибаются
  if ((o.recipe === "quadruped-gait" || o.recipe === "multileg-gait") && o.paws?.length)
    steps.push({ name: "clip.ground", args: { clip: o.name, bones: o.paws.join(","), mode: "floor", ik: true } });
  return steps;
}

/** Слова запроса → разделы библиотеки и подсказки, что искать в описании пресета. Основа — корни слов, по-русски и по-английски. */
const WORDS: { stems: string[]; cats?: string[]; recipes?: string[]; hints?: string[]; need?: boolean; clip: string }[] = [
  { stems: ["бег", "бежит", "run", "галоп", "рысь", "trot"], cats: ["walk", "quad", "multi"], hints: ["бег", "run", "галоп", "рысь"], clip: "run" },
  { stems: ["ходьб", "ход", "шаг", "иде", "идт", "иду", "походк", "гуля", "walk", "step"], cats: ["walk", "quad", "multi"], clip: "walk" },
  { stems: ["таран", "толк", "пузом", "корпусом", "ram", "bump"], cats: ["fight"], hints: ["таран"], clip: "attack" },
  { stems: ["удар", "атак", "бьёт", "бьет", "бить", "замах", "выпад", "punch", "strike", "attack", "hit", "хлыст", "кус"], cats: ["fight"], clip: "attack" },
  { stems: ["плав", "плыв", "волн", "swim", "wave", "ползе", "ползт", "змея", "рыб"], cats: ["swim"], clip: "swim" },
  { stems: ["хвост", "виля", "tail"], cats: ["swim", "small"], hints: ["хвост"], need: true, clip: "tail" },
  { stems: ["крыл", "взмах", "мах", "полёт", "полет", "лет", "fly", "flap", "ласт", "греб"], cats: ["wing"], clip: "fly" },
  { stems: ["пари", "левит", "hover", "висит", "призрак"], cats: ["hover"], clip: "hover" },
  { stems: ["появл", "вылез", "вынырн", "всплы", "spawn", "emerge", "рост", "ныря", "исчез", "уход"], cats: ["emerge"], clip: "emerge" },
  { stems: ["морг", "blink", "ресниц"], cats: ["small"], hints: ["морг"], need: true, clip: "blink" },
  { stems: ["idle", "покой", "стоит", "стоя", "дыха", "дыш", "breath"], recipes: ["curl"], hints: ["дыхан", "покое", "на месте", "idle"], need: true, clip: "idle" },
  { stems: ["болта", "дрож", "колых", "jiggle", "уши", "ухо", "волос"], cats: ["small"], clip: "jiggle" },
];
/** Прилагательные → что искать в описании пресета. */
const ADJ: Record<string, string[]> = {
  ленив: ["спокойн", "медлен"],
  спокой: ["спокойн", "медлен"],
  медлен: ["медлен", "спокойн"],
  calm: ["спокойн"],
  тяжел: ["тяжёл", "голем"],
  тяжёл: ["тяжёл", "голем"],
  heavy: ["тяжёл"],
  быстр: ["быстр"],
  fast: ["быстр"],
  реалист: ["реалист"],
  неуклюж: ["неуклюж"],
  мультяш: ["tools up"],
  сильн: ["сильн"],
  силов: ["силов", "сильн"],
  радост: ["гладят", "happy"],
  весел: ["гладят", "happy"],
  боев: ["боев"],
};

/** Походки, которые по цепочкам подходят и чужому телу (у четвероногого тоже есть leg_l), — только своему. */
const BODY_ONLY: Record<string, string[]> = { walk: ["biped"], quad: ["quadruped"], multi: ["multileg", "quadruped"], "tentacle-strike": ["other", "finned"] };

/** Пресеты с такими пометками берутся, только если в запросе есть такие слова. */
const EXPLICIT: [string[], string[]][] = [
  [["бег", "бежит", "run", "галоп", "рысь", "trot", "быстр"], ["бег", "run", "галоп"]],
  [["силов", "заряд", "charge", "мощн", "тяжел", "power"], ["силов", "заряд"]],
];

export interface Found {
  recipe: string;
  preset: LibPreset;
  score: number;
  clip: string;
}

/** Поиск пресета по словам — запасной путь, когда агента нет и пишут «ходьба, удар».
 * Подходят только пресеты, которым хватает цепочек скелета; лучший — с совпадением раздела и описания. */
/** Карточка стиля → что предпочесть при равенстве: мультяшному — Tools Up!, реалистичному — Witcher и TLJ;
 * врагу и NPC — читаемый телеграф, персонажу игрока — быстрый удар. */
function styleHints(st?: StyleCard): { hints: string[]; w: number }[] {
  const out: { hints: string[]; w: number }[] = [];
  const sz = (st?.stylization ?? "").toLowerCase();
  if (/cartoon|styliz|мульт|стилиз/.test(sz)) out.push({ hints: ["tools up", "toolsup"], w: 1 });
  if (/real|реал/.test(sz)) out.push({ hints: ["реалист", "witcher", "tlj", "геральт"], w: 1 });
  const role = (st?.role ?? "").toLowerCase();
  if (/npc|enemy|враг|нпс/.test(role)) out.push({ hints: ["npc", "телеграф", "читаем"], w: 0.6 });
  if (/player|игрок/.test(role)) out.push({ hints: ["быстр", "геральт"], w: 0.6 });
  return out;
}

export function searchPresets(text: string, lib: LibRecipe[], chains: Record<string, string[]>, body = "other", style?: StyleCard): Found[] {
  const words = text.toLowerCase().replace(/ё/g, "е").split(/[^a-zа-я0-9-]+/).filter((w) => w.length >= 2);
  const has = (w: string, stem: string) => w.startsWith(stem.replace(/ё/g, "е"));
  const kinds = WORDS.filter((k) => words.some((w) => k.stems.some((s) => has(w, s))));
  const hints = [...kinds.flatMap((k) => k.hints ?? []), ...Object.entries(ADJ).filter(([a]) => words.some((w) => has(w, a))).flatMap(([, h]) => h)];
  const first = BODY_FIRST[body] ?? [];
  const out: Found[] = [];
  for (const l of lib) {
    if (missingChains(l.roles, chains).length) continue;
    const cat = categoryOf(l.recipe);
    if ((BODY_ONLY[cat] && !BODY_ONLY[cat].includes(body)) || (BODY_ONLY[l.recipe] && !BODY_ONLY[l.recipe].includes(body))) continue;
    for (const p of l.presets) {
      const hay = `${p.name} ${p.help} ${l.recipe}`.toLowerCase().replace(/ё/g, "е");
      // need — раздел засчитывается, только если в описании есть подсказка («idle» — не любая волна, а дыхание или покой)
      const kind = kinds.find((k) => (k.cats?.includes(cat) || k.recipes?.includes(l.recipe)) && (!k.need || (k.hints ?? []).some((h) => hay.includes(h))));
      let score = kind ? 3 : 0;
      score += hints.filter((h) => hay.includes(h.replace(/ё/g, "е"))).length;
      // слова запроса прямо в имени или описании (акула, Геральт, собака)
      // (кроме слов раздела — «ходьба» уже засчитана разделом и не должна тянуть пресеты, где это слово просто есть в описании)
      score += words.filter((w) => w.length >= 4 && !kinds.some((k) => k.stems.some((st) => has(w, st))) && hay.includes(w.slice(0, Math.max(4, w.length - 2)))).length * 1.5;
      // бег и силовой удар — только когда о них просят: «ходьба» — не бег, «удар» — не заряд на 4 с
      for (const [stems, marks] of EXPLICIT) if (marks.some((m) => hay.includes(m)) && !words.some((w) => stems.some((st) => has(w, st)))) score -= 1.5;
      if (score < 2) continue;
      // стиль игры решает между равными: стилизация весит 1, роль — 0.6
      score += styleHints(style).reduce((a, g) => a + (g.hints.some((h) => hay.includes(h)) ? g.w : 0), 0);
      // тело подсказывает раздел: у двуногого «ходьба» — это waddle-walk, а не лапы
      const bi = first.indexOf(cat);
      score += bi >= 0 ? (first.length - bi) * 0.1 : 0;
      out.push({ recipe: l.recipe, preset: p, score: +score.toFixed(2), clip: kind?.clip ?? kinds[0]?.clip ?? p.name });
    }
  }
  return out.sort((a, b) => b.score - a.score);
}

/** Запрошенный клип: «имя=пресет{json}», «пресет», «слова» или «имя=слова». Через «;», а без него — через запятую. */
export interface ClipRequest {
  name?: string;
  query: string;
  params?: Record<string, unknown>;
}
export function parseClips(s: string): ClipRequest[] {
  const items = (s.includes(";") ? s.split(";") : s.split(/,(?![^{]*})/)).map((x) => x.trim()).filter(Boolean);
  return items.map((it) => {
    const m = it.match(/^([A-Za-z_][\w-]*)\s*=\s*(.+)$/);
    let rest = m ? m[2].trim() : it;
    let params: Record<string, unknown> | undefined;
    const b = rest.indexOf("{");
    if (b >= 0) {
      params = JSON.parse(rest.slice(b));
      rest = rest.slice(0, b).trim();
    }
    return { name: m?.[1], query: rest, params };
  });
}

export const uniqueClipName = (project: Project, base: string, taken: string[] = []) => {
  let name = base;
  for (let i = 2; project.clips.some((c) => c.name === name) || taken.includes(name); i++) name = `${base}-${i}`;
  return name;
};
