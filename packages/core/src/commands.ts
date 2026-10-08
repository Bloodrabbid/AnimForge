// Ядро команд. Каждое действие — команда с описанием и параметрами: её одинаково вызывают интерфейс, CLI и MCP.
// Команды здесь чистые: меняют проект в памяти и возвращают результат. Файлы, Blender и рендер — в адаптерах (packages/cli).
import { CHANNELS } from "./project.ts";
import type { Channel, Clip, Interp, KeyLayer, Project, RecipeLayer, Skeleton } from "./project.ts";
import { RECIPES } from "./recipes.ts";

export interface Ctx {
  project: Project;
  skeleton: Skeleton;
}

export interface CommandDef {
  name: string;
  help: string;
  args: Record<string, { type: string; required?: boolean; help: string }>;
  mutates: boolean;
  run(ctx: Ctx, a: Record<string, any>): unknown;
}

const need = (cond: unknown, msg: string) => {
  if (!cond) throw new Error(msg);
};

function clipOf(ctx: Ctx, name: string): Clip {
  const c = ctx.project.clips.find((c) => c.name === name);
  need(c, `нет клипа «${name}». Есть: ${ctx.project.clips.map((c) => c.name).join(", ") || "—"}`);
  return c!;
}

function keyLayer(clip: Clip): KeyLayer {
  let l = clip.layers.find((l) => l.type === "keys") as KeyLayer | undefined;
  if (!l) {
    l = { id: "edits", type: "keys", tracks: [] };
    clip.layers.push(l);
  }
  return l;
}

const defs: CommandDef[] = [
  {
    name: "info",
    help: "Сводка проекта: кости, цепочки, клипы и слои.",
    args: {},
    mutates: false,
    run: (ctx) => ({
      name: ctx.project.name,
      model: ctx.project.model,
      bones: ctx.skeleton.nodes.filter((n) => n.isJoint).map((n) => `${n.name}${n.parent ? ` ← ${n.parent}` : ""}`),
      chains: ctx.project.chains,
      clips: ctx.project.clips.map((c) => ({
        name: c.name,
        duration: c.duration,
        fps: c.fps,
        loop: c.loop,
        layers: c.layers.map((l) => (l.type === "recipe" ? `${l.id}: ${l.recipe}(${l.target.chain})` : `${l.id}: ключи, треков ${l.tracks.length}`)),
      })),
    }),
  },
  {
    name: "recipes",
    help: "Список рецептов и их параметров (схема для ползунков и для агента).",
    args: {},
    mutates: false,
    run: () => Object.values(RECIPES).map((r) => ({ name: r.name, help: r.help, params: r.params })),
  },
  {
    name: "chain.set",
    help: "Задать цепочку костей от основания к кончику. bones — через запятую, либо from+to: путь по иерархии.",
    args: {
      name: { type: "string", required: true, help: "имя цепочки, например tail" },
      bones: { type: "string", help: "кости через запятую" },
      from: { type: "string", help: "первая кость" },
      to: { type: "string", help: "последняя кость (потомок from)" },
    },
    mutates: true,
    run(ctx, a) {
      let bones: string[];
      if (a.bones) bones = String(a.bones).split(",").map((s) => s.trim());
      else {
        need(a.from && a.to, "нужно bones или from+to");
        const parent = new Map(ctx.skeleton.nodes.map((n) => [n.name, n.parent]));
        bones = [];
        for (let b: string | null | undefined = a.to; b; b = parent.get(b)) {
          bones.unshift(b);
          if (b === a.from) break;
        }
        need(bones[0] === a.from, `${a.to} не потомок ${a.from}`);
      }
      const known = new Set(ctx.skeleton.nodes.map((n) => n.name));
      bones.forEach((b) => need(known.has(b), `нет кости «${b}»`));
      ctx.project.chains[a.name] = bones;
      return { chain: a.name, bones };
    },
  },
  {
    name: "clip.add",
    help: "Создать клип.",
    args: {
      name: { type: "string", required: true, help: "имя клипа (станет именем анимации в glTF и в Godot)" },
      duration: { type: "number", required: true, help: "длительность, с" },
      fps: { type: "number", help: "частота запекания, по умолчанию 30" },
      loop: { type: "boolean", help: "цикл, по умолчанию true" },
    },
    mutates: true,
    run(ctx, a) {
      need(!ctx.project.clips.some((c) => c.name === a.name), `клип «${a.name}» уже есть`);
      const clip: Clip = { name: a.name, duration: +a.duration, fps: +(a.fps ?? 30), loop: a.loop ?? true, layers: [] };
      ctx.project.clips.push(clip);
      return clip;
    },
  },
  {
    name: "recipe.add",
    help: "Добавить слой-рецепт на цепочку с параметрами params (JSON). Слой из пресета библиотеки — preset.apply.",
    args: {
      clip: { type: "string", required: true, help: "клип" },
      recipe: { type: "string", required: true, help: "имя рецепта, см. recipes" },
      chain: { type: "string", required: true, help: "цепочка" },
      id: { type: "string", help: "id слоя, по умолчанию имя рецепта" },
      params: { type: "json", help: "параметры рецепта" },
      preset: { type: "string", help: "имя пресета — только пометка происхождения рядом с params; взять параметры из библиотеки — preset.apply" },
    },
    mutates: true,
    run(ctx, a) {
      const clip = clipOf(ctx, a.clip);
      // без params пометка врала бы: слой подписан пресетом, а считается на умолчаниях
      need(!a.preset || a.params, `recipe.add: preset «${a.preset}» без params ничего не применяет — вызови preset.apply`);
      need(RECIPES[a.recipe], `нет рецепта «${a.recipe}». Есть: ${Object.keys(RECIPES).join(", ")}`);
      need(ctx.project.chains[a.chain], `нет цепочки «${a.chain}»`);
      const layer: RecipeLayer = { id: a.id ?? a.recipe, type: "recipe", recipe: a.recipe, target: { chain: a.chain }, params: a.params ?? {}, preset: a.preset };
      need(!clip.layers.some((l) => l.id === layer.id), `слой «${layer.id}» уже есть`);
      // рецепты всегда под ручным слоем
      const ki = clip.layers.findIndex((l) => l.type === "keys");
      ki < 0 ? clip.layers.push(layer) : clip.layers.splice(ki, 0, layer);
      return layer;
    },
  },
  {
    name: "recipe.set",
    help: "Поменять параметры слоя-рецепта (остальные параметры не трогаются).",
    args: {
      clip: { type: "string", required: true, help: "клип" },
      layer: { type: "string", required: true, help: "id слоя" },
      params: { type: "json", required: true, help: "параметры, например {\"period\":2}" },
    },
    mutates: true,
    run(ctx, a) {
      const l = clipOf(ctx, a.clip).layers.find((l) => l.id === a.layer);
      need(l && l.type === "recipe", `нет слоя-рецепта «${a.layer}»`);
      const spec = RECIPES[(l as RecipeLayer).recipe].params;
      for (const k of Object.keys(a.params)) need(spec[k], `у рецепта нет параметра «${k}». Есть: ${Object.keys(spec).join(", ")}`);
      Object.assign((l as RecipeLayer).params, a.params);
      return l;
    },
  },
  {
    name: "key.set",
    help: "Поставить ручной ключ поверх рецептов: добавка по каналу — поворот (°), сдвиг (м) или масштаб (добавка к 1).",
    args: {
      clip: { type: "string", required: true, help: "клип" },
      bone: { type: "string", required: true, help: "кость" },
      axis: { type: "string", required: true, help: "lateral | vertical | roll | move_up | move_forward | move_side | scale_up | scale_forward | scale_side" },
      t: { type: "number", required: true, help: "время, с" },
      v: { type: "number", required: true, help: "значение: °, м или добавка к масштабу (0.2 → ×1.2)" },
      interp: { type: "string", help: "smooth | linear | step (переход к следующему ключу)" },
    },
    mutates: true,
    run(ctx, a) {
      const clip = clipOf(ctx, a.clip);
      need(ctx.skeleton.nodes.some((n) => n.name === a.bone), `нет кости «${a.bone}»`);
      need(CHANNELS.includes(a.axis), `axis: ${CHANNELS.join(" | ")}`);
      need(+a.t >= 0 && +a.t <= clip.duration, `t вне клипа 0…${clip.duration}`);
      const layer = keyLayer(clip);
      let tr = layer.tracks.find((t) => t.bone === a.bone && t.axis === a.axis);
      if (!tr) layer.tracks.push((tr = { bone: a.bone, axis: a.axis as Channel, keys: [] }));
      tr.keys = tr.keys.filter((k) => Math.abs(k.t - +a.t) > 1e-6);
      tr.keys.push({ t: +a.t, v: +a.v, ...(a.interp ? { interp: a.interp as Interp } : {}) });
      tr.keys.sort((x, y) => x.t - y.t);
      return tr;
    },
  },
  {
    name: "clip.ground",
    help: "Ставить кости на пол после всех слоёв: корень сдвигается по вертикали. contact — нижняя кость всегда на полу; floor — только не проваливаться. Без bones — выключить.",
    args: {
      clip: { type: "string", required: true, help: "клип" },
      bones: { type: "string", help: "кости через запятую (ступни)" },
      mode: { type: "string", help: "contact (по умолчанию) | floor" },
      ik: { type: "boolean", help: "провалившуюся ступню поднимать сгибом колена (двухзвенная IK: ступня → голень → бедро)" },
    },
    mutates: true,
    run(ctx, a) {
      const clip = clipOf(ctx, a.clip);
      if (!a.bones) { delete clip.ground; return { ground: null }; }
      const bones = String(a.bones).split(",").map((s) => s.trim());
      for (const b of bones) need(ctx.skeleton.nodes.some((n) => n.name === b), `нет кости «${b}»`);
      need(!a.mode || a.mode === "contact" || a.mode === "floor", "mode: contact | floor");
      clip.ground = { bones, mode: a.mode ?? "contact", ...(a.ik ? { ik: true } : {}) };
      return clip.ground;
    },
  },
  {
    name: "key.clear",
    help: "Убрать ручные ключи кости (по оси или все).",
    args: {
      clip: { type: "string", required: true, help: "клип" },
      bone: { type: "string", required: true, help: "кость" },
      axis: { type: "string", help: "ось; без неё — все оси" },
    },
    mutates: true,
    run(ctx, a) {
      const layer = keyLayer(clipOf(ctx, a.clip));
      const before = layer.tracks.length;
      layer.tracks = layer.tracks.filter((t) => !(t.bone === a.bone && (!a.axis || t.axis === a.axis)));
      return { removed: before - layer.tracks.length };
    },
  },
];

export const COMMANDS: Record<string, CommandDef> = Object.fromEntries(defs.map((d) => [d.name, d]));

export function runCommand(ctx: Ctx, name: string, args: Record<string, any>) {
  const def = COMMANDS[name];
  need(def, `нет команды «${name}»`);
  for (const [k, s] of Object.entries(def.args)) need(!s.required || args[k] !== undefined, `${name}: нужен аргумент ${k} — ${s.help}`);
  return def.run(ctx, args);
}
