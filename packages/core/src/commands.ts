// Ядро команд. Каждое действие — команда с описанием и параметрами: её одинаково вызывают интерфейс, CLI и MCP.
// Команды здесь чистые: меняют проект в памяти и возвращают результат. Файлы, Blender и рендер — в адаптерах (packages/cli).
import { CHANNELS } from "./project.ts";
import type { Channel, Clip, Constraint, ConstraintTarget, Interp, KeyLayer, Project, RecipeLayer, Skeleton } from "./project.ts";
import { RECIPES } from "./recipes.ts";
import { buildRig, frameTimes, motionAt } from "./evaluate.ts";
import { LIMIT_AXES, boneAngles, limitFrame, type BoneLimit, type LimitAxis } from "./limits.ts";
import { DEG, qaxis, qrot, vdot, vsub } from "./math.ts";
import { bodyFrame } from "./evaluate.ts";

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

function limitTargets(ctx: Ctx, a: Record<string, any>): string[] {
  if (a.chain) {
    const c = ctx.project.chains[a.chain];
    need(c, `нет цепочки «${a.chain}»`);
    return c!;
  }
  need(a.bone, "нужна кость (bone) или цепочка (chain)");
  need(ctx.skeleton.nodes.some((n) => n.name === a.bone), `нет кости «${a.bone}»`);
  return [a.bone];
}

const vec = (v: unknown, name: string): [number, number, number] => {
  const a = Array.isArray(v) ? v.map(Number) : String(v).split(",").map((x) => Number(x.trim()));
  need(a.length === 3 && a.every(Number.isFinite), `${name} — три числа «x,y,z»`);
  return a as [number, number, number];
};

/** Цель из аргументов: target="x,y,z" — точка, targetBone — кость (+ offset). */
function targetOf(ctx: Ctx, a: Record<string, any>): ConstraintTarget {
  const t: ConstraintTarget = {};
  if (a.targetBone) {
    need(ctx.skeleton.nodes.some((n) => n.name === a.targetBone), `нет кости «${a.targetBone}»`);
    t.bone = a.targetBone;
  } else {
    need(a.target != null, "нужна цель: target «x,y,z» или targetBone");
    t.pos = vec(a.target, "target");
  }
  if (a.offset != null) t.offset = vec(a.offset, "offset");
  return t;
}

function constraintOf(clip: Clip, id: string): Constraint {
  const c = clip.constraints?.find((c) => c.id === id);
  need(c, `нет констрейна «${id}». Есть: ${(clip.constraints ?? []).map((c) => c.id).join(", ") || "—"}`);
  return c!;
}

function addConstraint(clip: Clip, c: Constraint) {
  clip.constraints ??= [];
  const i = clip.constraints.findIndex((x) => x.id === c.id);
  if (i >= 0) clip.constraints[i] = c;
  else clip.constraints.push(c);
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
  {
    name: "limit.set",
    help: "Ограничение — диапазон движения кости по оси, градусы. Оси как у каналов: lateral, vertical, roll (кости цепочки), pitch, yaw, bank (корпус). Для цепочки — на каждую её кость.",
    args: {
      bone: { type: "string", help: "кость" },
      chain: { type: "string", help: "или цепочка — каждой кости" },
      axis: { type: "string", required: true, help: LIMIT_AXES.join(" | ") },
      min: { type: "number", required: true, help: "от, °" },
      max: { type: "number", required: true, help: "до, °" },
    },
    mutates: true,
    run(ctx, a) {
      need(LIMIT_AXES.includes(a.axis), `axis: ${LIMIT_AXES.join(" | ")}`);
      need(Number.isFinite(+a.min) && Number.isFinite(+a.max) && +a.min <= +a.max, "нужно min ≤ max");
      const bones = limitTargets(ctx, a);
      ctx.project.limits ??= {};
      for (const b of bones) {
        const l = (ctx.project.limits[b] ??= {});
        // оси тела и оси цепочки в одной кости не смешиваем: разложение поворота у них разное
        const body = ["pitch", "yaw", "bank"].includes(a.axis);
        for (const k of Object.keys(l) as LimitAxis[]) if (["pitch", "yaw", "bank"].includes(k) !== body) delete l[k];
        l[a.axis as LimitAxis] = [+a.min, +a.max];
      }
      return { bones, axis: a.axis, range: [+a.min, +a.max] };
    },
  },
  {
    name: "limit.clear",
    help: "Снять ограничение с кости или цепочки (по оси или все). Без bone и chain — все ограничения проекта.",
    args: {
      bone: { type: "string", help: "кость" },
      chain: { type: "string", help: "или цепочка" },
      axis: { type: "string", help: "ось; без неё — все" },
    },
    mutates: true,
    run(ctx, a) {
      if (!a.bone && !a.chain) {
        const n = Object.keys(ctx.project.limits ?? {}).length;
        delete ctx.project.limits;
        return { cleared: n };
      }
      const bones = limitTargets(ctx, a);
      for (const b of bones) {
        const l = ctx.project.limits?.[b];
        if (!l) continue;
        if (a.axis) delete l[a.axis as LimitAxis];
        if (!a.axis || !Object.keys(l).length) delete ctx.project.limits![b];
      }
      if (ctx.project.limits && !Object.keys(ctx.project.limits).length) delete ctx.project.limits;
      return { bones };
    },
  },
  {
    name: "limit.fit",
    help: "Снять диапазоны с готовых клипов: по каждой кости — от наименьшего до наибольшего угла за все кадры, плюс запас. Удобно зафиксировать «как в хорошей анимации» и не дать новым слоям выйти за это.",
    args: {
      bone: { type: "string", help: "кость" },
      chain: { type: "string", help: "или цепочка; без обоих — все кости, которые двигаются" },
      margin: { type: "number", help: "запас, °, по умолчанию 5" },
      clips: { type: "string", help: "клипы через запятую; по умолчанию все" },
    },
    mutates: true,
    run(ctx, a) {
      const rig = buildRig(ctx.skeleton);
      const free = { ...ctx.project, limits: undefined };
      const names = a.clips ? String(a.clips).split(",").map((s) => s.trim()) : ctx.project.clips.map((c) => c.name);
      const clips = names.map((n) => clipOf(ctx, n));
      const want = a.bone || a.chain ? new Set(limitTargets(ctx, a)) : null;
      const margin = a.margin ?? 5;
      const range = new Map<string, Record<string, [number, number]>>();
      for (const clip of clips)
        for (const t of frameTimes(clip)) {
          const m = motionAt(free, rig, clip, t);
          for (const [bone, d] of m.rot) {
            if (want && !want.has(bone)) continue;
            const body = !Object.values(ctx.project.chains).some((c) => c.includes(bone) && c.length > 1);
            const ang = boneAngles(rig, ctx.project, bone, d, m.base.get(bone), body);
            const r = range.get(bone) ?? {};
            for (const [k, v] of Object.entries(ang)) {
              const cur = r[k] ?? [v!, v!];
              r[k] = [Math.min(cur[0], v!), Math.max(cur[1], v!)];
            }
            range.set(bone, r);
          }
        }
      ctx.project.limits ??= {};
      const out: Record<string, BoneLimit> = {};
      for (const [bone, r] of range) {
        const l: BoneLimit = {};
        for (const [k, [lo, hi]] of Object.entries(r)) l[k as LimitAxis] = [Math.floor(lo - margin), Math.ceil(hi + margin)];
        ctx.project.limits[bone] = out[bone] = l;
      }
      return { bones: Object.keys(out).length, limits: out };
    },
  },
  {
    name: "limit.auto",
    help: "Анатомические ограничения по стандартным цепочкам: колено и локоть гнутся только в свою сторону (0…150° и 0…145°, ось сгиба — vertical или lateral, смотря по позе покоя), почти не гнутся вбок; голова и шея — в пределах человека. Сторону сгиба находит по геометрии.",
    args: {},
    mutates: true,
    run(ctx) {
      const rig = buildRig(ctx.skeleton);
      const ch = ctx.project.chains;
      const f = bodyFrame(ctx.project);
      ctx.project.limits ??= {};
      const done: string[] = [];
      // в какую сторону сгиб: поворот средней кости на +20° должен увести конец цепочки в нужную сторону
      const hinge = (chain: string[] | undefined, toward: number[], bend: number, label: string) => {
        if (!chain || chain.length < 2) return;
        const mid = chain[1], i = rig.index.get(mid)!;
        const tipName = chain.length > 2 ? chain[2] : undefined;
        const tipI = tipName ? rig.index.get(tipName)! : ctx.skeleton.nodes.findIndex((n) => n.parent === mid && n.isJoint);
        // у кисти-варежки нет дочерней кости — конец берём продолжением предыдущей кости
        const arm = tipI != null && tipI >= 0 ? vsub(rig.worldT[tipI], rig.worldT[i]) : vsub(rig.worldT[i], rig.worldT[rig.index.get(chain[0])!]);
        if (Math.hypot(...arm) < 1e-9) return;
        // ось сгиба — та из двух поперечных, что сильнее уводит конец в нужную сторону: у висящей ноги это
        // vertical, у руки в T-позе — lateral (поворот вокруг вертикали тела)
        const { names, axes } = limitFrame(rig, ctx.project, mid, false);
        const pick = ([1, 2] as const).map((k) => {
          const moved = vsub(qrot(qaxis(qrot(rig.worldR[i], axes[k]), 20 * DEG), arm), arm);
          return { k, d: vdot(moved, toward as [number, number, number]) };
        }).sort((a, b) => Math.abs(b.d) - Math.abs(a.d))[0];
        const hingeAxis = names[pick.k], other = names[pick.k === 1 ? 2 : 1];
        ctx.project.limits![mid] = { [hingeAxis]: pick.d >= 0 ? [0, bend] : [-bend, 0], [other]: [-8, 8], roll: [-15, 15] };
        done.push(`${label}: ${mid}`);
      };
      const back = f.forward.map((x) => -x);
      hinge(ch.leg_l, back, 150, "колено л");
      hinge(ch.leg_r, back, 150, "колено п");
      hinge(ch.arm_l, f.forward, 145, "локоть л");
      hinge(ch.arm_r, f.forward, 145, "локоть п");
      for (const b of ch.neck ?? []) { ctx.project.limits[b] = { pitch: [-40, 40], yaw: [-50, 50], bank: [-30, 30] }; done.push(`шея: ${b}`); }
      for (const b of ch.head ?? []) { ctx.project.limits[b] = { pitch: [-45, 45], yaw: [-70, 70], bank: [-35, 35] }; done.push(`голова: ${b}`); }
      if (!done.length) throw new Error("нет стандартных цепочек leg_l/arm_l/neck/head — сначала rig.detect");
      return { set: done };
    },
  },
  {
    name: "aim.add",
    help: "Взгляд: голова (и шея) смотрит на цель — точку или кость. bones — кости от основания к кончику через запятую (по умолчанию цепочки neck и head). Поворот делится между костями, ограничения суставов действуют.",
    args: {
      clip: { type: "string", required: true, help: "клип" },
      bones: { type: "string", help: "кости через запятую; по умолчанию neck + head" },
      target: { type: "string", help: "точка «x,y,z» в координатах модели" },
      targetBone: { type: "string", help: "или кость-цель (смотреть на свою руку, на хвост)" },
      offset: { type: "string", help: "сдвиг цели «x,y,z»" },
      weight: { type: "number", help: "0…1, по умолчанию 1" },
      id: { type: "string", help: "имя, по умолчанию aim" },
    },
    mutates: true,
    run(ctx, a) {
      const clip = clipOf(ctx, a.clip);
      const ch = ctx.project.chains;
      const bones = a.bones ? String(a.bones).split(",").map((s) => s.trim()).filter(Boolean) : [...(ch.neck ?? []), ...(ch.head ?? [])];
      need(bones.length, "нет цепочек neck/head — укажи bones");
      for (const b of bones) need(ctx.skeleton.nodes.some((n) => n.name === b), `нет кости «${b}»`);
      const c: Constraint = { id: a.id ?? "aim", type: "aim", bones, target: targetOf(ctx, a), ...(a.weight != null && +a.weight !== 1 ? { weight: +a.weight } : {}) };
      addConstraint(clip, c);
      return c;
    },
  },
  {
    name: "ik.add",
    help: "IK-цель: кисть или стопа тянется к точке или кости, сгибаются локоть и плечо (колено и бедро). chain — цепочка руки/ноги (кончик — следующая кость за ней), или tip — сама кость-кончик. pole — куда смотрит сгиб.",
    args: {
      clip: { type: "string", required: true, help: "клип" },
      chain: { type: "string", help: "цепочка: arm_l, leg_r…" },
      tip: { type: "string", help: "или кость-кончик (кисть, стопа)" },
      target: { type: "string", help: "точка «x,y,z» в координатах модели" },
      targetBone: { type: "string", help: "или кость-цель" },
      offset: { type: "string", help: "сдвиг цели «x,y,z»" },
      pole: { type: "string", help: "точка «x,y,z», куда смотрит локоть/колено" },
      weight: { type: "number", help: "0…1, по умолчанию 1" },
      id: { type: "string", help: "имя, по умолчанию ik_<цепочка>" },
    },
    mutates: true,
    run(ctx, a) {
      const clip = clipOf(ctx, a.clip);
      let tip = a.tip as string | undefined;
      if (!tip) {
        need(a.chain, "нужна цепочка (chain) или кончик (tip)");
        const c = ctx.project.chains[a.chain];
        need(c, `нет цепочки «${a.chain}»`);
        const last = c![c!.length - 1];
        tip = c!.length >= 3 ? last : ctx.skeleton.nodes.find((n) => n.parent === last && n.isJoint)?.name;
        need(tip, `у «${last}» нет дочерней кости — укажи tip`);
      }
      const nodes = ctx.skeleton.nodes;
      const node = nodes.find((n) => n.name === tip);
      need(node, `нет кости «${tip}»`);
      const mid = nodes.find((n) => n.name === node!.parent);
      need(mid?.isJoint && nodes.some((n) => n.name === mid.parent && n.isJoint), `у «${tip}» нет родителя и деда — IK нужны две кости над кончиком`);
      const c: Constraint = {
        id: a.id ?? `ik_${a.chain ?? tip}`,
        type: "ik",
        tip: tip!,
        target: targetOf(ctx, a),
        ...(a.pole != null ? { pole: vec(a.pole, "pole") } : {}),
        ...(a.weight != null && +a.weight !== 1 ? { weight: +a.weight } : {}),
      };
      addConstraint(clip, c);
      return c;
    },
  },
  {
    name: "constraint.key",
    help: "Ключ цели констрейна во времени t: цель едет по ключам (рука тянется к двигающемуся предмету, взгляд провожает).",
    args: {
      clip: { type: "string", required: true, help: "клип" },
      id: { type: "string", required: true, help: "констрейн" },
      t: { type: "number", required: true, help: "время, с" },
      target: { type: "string", required: true, help: "точка «x,y,z»" },
      interp: { type: "string", help: "smooth | linear | step" },
    },
    mutates: true,
    run(ctx, a) {
      const clip = clipOf(ctx, a.clip);
      const c = constraintOf(clip, a.id);
      const pos = vec(a.target, "target");
      const keys = (c.target.keys ??= []);
      // первая точка ключей — там, где цель стояла (иначе до первого ключа цель прыгнет)
      if (!keys.length && c.target.pos && Math.abs(+a.t) > 1e-6) keys.push({ t: 0, pos: c.target.pos });
      const k = keys.find((x) => Math.abs(x.t - +a.t) < 1e-6);
      const interp = a.interp as Interp | undefined;
      if (k) {
        k.pos = pos;
        if (interp) k.interp = interp;
      } else keys.push({ t: +a.t, pos, ...(interp ? { interp } : {}) });
      keys.sort((x, y) => x.t - y.t);
      delete c.target.pos;
      delete c.target.bone;
      return c;
    },
  },
  {
    name: "constraint.set",
    help: "Поменять констрейн: вес, выключить/включить, новая неподвижная цель (target или targetBone — ключи цели сбрасываются), pole.",
    args: {
      clip: { type: "string", required: true, help: "клип" },
      id: { type: "string", required: true, help: "констрейн" },
      weight: { type: "number", help: "0…1" },
      muted: { type: "boolean", help: "выключить" },
      target: { type: "string", help: "точка «x,y,z»" },
      targetBone: { type: "string", help: "кость-цель" },
      offset: { type: "string", help: "сдвиг цели" },
      pole: { type: "string", help: "«x,y,z» или none" },
    },
    mutates: true,
    run(ctx, a) {
      const c = constraintOf(clipOf(ctx, a.clip), a.id);
      if (a.weight != null) {
        need(+a.weight >= 0 && +a.weight <= 1, "weight — от 0 до 1");
        if (+a.weight === 1) delete c.weight;
        else c.weight = +a.weight;
      }
      if (a.muted != null) {
        if (a.muted) c.muted = true;
        else delete c.muted;
      }
      if (a.target != null || a.targetBone != null) c.target = targetOf(ctx, a);
      else if (a.offset != null) c.target.offset = vec(a.offset, "offset");
      if (a.pole != null && c.type === "ik") {
        if (a.pole === "none") delete c.pole;
        else c.pole = vec(a.pole, "pole");
      }
      return c;
    },
  },
  {
    name: "constraint.remove",
    help: "Убрать констрейн клипа.",
    args: { clip: { type: "string", required: true, help: "клип" }, id: { type: "string", required: true, help: "констрейн" } },
    mutates: true,
    run(ctx, a) {
      const clip = clipOf(ctx, a.clip);
      constraintOf(clip, a.id);
      clip.constraints = clip.constraints!.filter((c) => c.id !== a.id);
      if (!clip.constraints.length) delete clip.constraints;
      return { removed: a.id };
    },
  },
  {
    name: "layer.remove",
    help: "Убрать слои клипа по id (несколько — через запятую).",
    args: {
      clip: { type: "string", required: true, help: "клип" },
      layer: { type: "string", required: true, help: "id слоя или «id1,id2»" },
    },
    mutates: true,
    run(ctx, a) {
      const clip = clipOf(ctx, a.clip);
      const ids = String(a.layer).split(",").map((s) => s.trim()).filter(Boolean);
      for (const id of ids) need(clip.layers.some((l) => l.id === id), `нет слоя «${id}». Есть: ${clip.layers.map((l) => l.id).join(", ")}`);
      clip.layers = clip.layers.filter((l) => !ids.includes(l.id));
      return { removed: ids };
    },
  },
  {
    name: "layer.set",
    help: "Вес слоя-рецепта: 1 — как есть, 0 — выключен, между — ослаблен (несколько слоёв — через запятую).",
    args: {
      clip: { type: "string", required: true, help: "клип" },
      layer: { type: "string", required: true, help: "id слоя или «id1,id2»" },
      weight: { type: "number", required: true, help: "0…2" },
    },
    mutates: true,
    run(ctx, a) {
      const clip = clipOf(ctx, a.clip);
      need(Number.isFinite(+a.weight) && +a.weight >= 0 && +a.weight <= 2, "weight — число от 0 до 2");
      const ids = String(a.layer).split(",").map((s) => s.trim()).filter(Boolean);
      const layers = ids.map((id) => {
        const l = clip.layers.find((l) => l.id === id);
        need(l && l.type === "recipe", `нет слоя-рецепта «${id}»`);
        return l as RecipeLayer;
      });
      for (const l of layers) if (+a.weight === 1) delete l.weight; else l.weight = +a.weight;
      return { layers: ids, weight: +a.weight };
    },
  },
  {
    name: "clip.remove",
    help: "Удалить клип целиком.",
    args: { clip: { type: "string", required: true, help: "клип" } },
    mutates: true,
    run(ctx, a) {
      clipOf(ctx, a.clip);
      ctx.project.clips = ctx.project.clips.filter((c) => c.name !== a.clip);
      return { removed: a.clip };
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
