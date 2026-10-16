// Ядро команд. Каждое действие — команда с описанием и параметрами: её одинаково вызывают интерфейс, CLI и MCP.
// Команды здесь чистые: меняют проект в памяти и возвращают результат. Файлы, Blender и рендер — в адаптерах (packages/cli).
import { CHANNELS } from "./project.ts";
import type { Channel, Clip, Constraint, ConstraintTarget, Interp, KeyLayer, Layer, PoseLayer, Project, RecipeLayer, Skeleton } from "./project.ts";
import { RECIPES, withDefaults } from "./recipes.ts";
import { addPoseDelta, buildRig, followBones, frameTimes, microBones, mirrorPairs, mirrorPose, motionAt, reach } from "./evaluate.ts";
import { LIMIT_AXES, boneAngles, limitFrame, type BoneLimit, type LimitAxis } from "./limits.ts";
import { DEG, qaxis, qrot, vdot, vsub } from "./math.ts";
import { bodyFrame } from "./evaluate.ts";
import { DIRECTION_NAMES, DIRECTIONS_SOURCE, GAIT_STYLES, directionClip } from "./directions.ts";
import { gaitCadence } from "./evaluate.ts";
import { HAND_POSES, fingersOf, handPose } from "./hands.ts";

const wrapAngle = (x: number) => { const w = ((((x + 180) % 360) + 360) % 360) - 180; return w === -180 ? 180 : w; };

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
        layers: c.layers.map((l) => (l.type === "recipe" ? `${l.id}: ${l.recipe}(${l.target.chain})` : l.type === "pose" ? `${l.id}: позы, ключей ${l.keys.length}` : `${l.id}: ключи, треков ${l.tracks.length}`)),
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
    name: "clip.set",
    help: "Поменять длительность, частоту запекания или цикличность клипа. fit — длина по рецептам клипа (удар — до конца окна ввода).",
    args: {
      clip: { type: "string", required: true, help: "клип" },
      duration: { type: "number", help: "длительность, с" },
      fps: { type: "number", help: "частота запекания" },
      loop: { type: "boolean", help: "цикл" },
      fit: { type: "boolean", help: "длина по рецептам: самая длинная из длин разовых рецептов клипа (RecipeDef.length)" },
    },
    mutates: true,
    run(ctx, a) {
      const clip = clipOf(ctx, a.clip);
      if (a.fit) {
        const ls = clip.layers.flatMap((l) => (l.type === "recipe" && RECIPES[l.recipe]?.length ? [RECIPES[l.recipe].length!(withDefaults(RECIPES[l.recipe], l.params))] : []));
        need(ls.length > 0, "у клипа нет разовых рецептов с длиной — укажите duration");
        clip.duration = +Math.max(...ls).toFixed(3);
      }
      if (a.duration != null) { need(+a.duration > 0, "duration > 0"); clip.duration = +a.duration; }
      if (a.fps != null) clip.fps = +a.fps;
      if (a.loop != null) clip.loop = !!a.loop;
      return { clip: clip.name, duration: clip.duration, fps: clip.fps, loop: clip.loop };
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
      flat: { type: "boolean", help: "опорная стопа (у пола) — плоско: наклон снимается, разворот остаётся; иначе носок или пятка уходят под пол" },
      lock: { type: "boolean", help: "у цикла походки опорная стопа стоит на месте: уезжает назад ровно со скоростью клипа (в игре ноги не скользят), поправка раздаётся по переносу, таз опускается, если нога не дотягивается" },
    },
    mutates: true,
    run(ctx, a) {
      const clip = clipOf(ctx, a.clip);
      if (!a.bones) { delete clip.ground; return { ground: null }; }
      const bones = String(a.bones).split(",").map((s) => s.trim());
      for (const b of bones) need(ctx.skeleton.nodes.some((n) => n.name === b), `нет кости «${b}»`);
      need(!a.mode || a.mode === "contact" || a.mode === "floor", "mode: contact | floor");
      clip.ground = { bones, mode: a.mode ?? "contact", ...(a.ik ? { ik: true } : {}), ...(a.flat ? { flat: true } : {}), ...(a.lock ? { lock: true } : {}) };
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
      length: { type: "number", help: "сколько костей сгибать от кончика вверх: 2 (по умолчанию) — рука/нога, 3–4 — с ключицей и корпусом, больше — весь хвост" },
      weight: { type: "number", help: "0…1, по умолчанию 1" },
      id: { type: "string", help: "имя, по умолчанию ik_<цепочка>" },
    },
    mutates: true,
    run(ctx, a) {
      const clip = clipOf(ctx, a.clip);
      let tip = a.tip as string | undefined;
      let end = false;
      const nodes = ctx.skeleton.nodes;
      if (!tip) {
        need(a.chain, "нужна цепочка (chain) или кончик (tip)");
        const c = ctx.project.chains[a.chain];
        need(c, `нет цепочки «${a.chain}»`);
        const last = c![c!.length - 1];
        tip = c!.length >= 3 ? last : nodes.find((n) => n.parent === last && n.isJoint)?.name;
        // рука-варежка без кисти: тянется конец последней кости цепочки
        if (!tip) (tip = last), (end = true);
      }
      const node = nodes.find((n) => n.name === tip);
      need(node, `нет кости «${tip}»`);
      const mid = end ? node : nodes.find((n) => n.name === node!.parent);
      need(mid?.isJoint && nodes.some((n) => n.name === mid.parent && n.isJoint), `у «${tip}» нет родителя и деда — IK нужны две кости над кончиком`);
      const c: Constraint = {
        id: a.id ?? `ik_${a.chain ?? tip}`,
        type: "ik",
        tip: tip!,
        ...(end ? { end: true } : {}),
        target: targetOf(ctx, a),
        ...(a.pole != null ? { pole: vec(a.pole, "pole") } : {}),
        ...(a.length != null && +a.length !== 2 ? { length: Math.max(1, Math.round(+a.length)) } : {}),
        ...(a.weight != null && +a.weight !== 1 ? { weight: +a.weight } : {}),
      };
      addConstraint(clip, c);
      return c;
    },
  },
  {
    name: "copy.add",
    help: "Копия поворота: кости повторяют движение других костей (попарно). bone/chain — кто повторяет, source/sourceChain — за кем. weight — множитель (−1 — наоборот), mirror — зеркально (левое ухо за правым). Цепочки — кость к кости, по меньшей длине.",
    args: {
      clip: { type: "string", required: true, help: "клип" },
      bone: { type: "string", help: "кость, которая повторяет" },
      chain: { type: "string", help: "или цепочка" },
      source: { type: "string", help: "кость-источник" },
      sourceChain: { type: "string", help: "или цепочка-источник" },
      weight: { type: "number", help: "множитель, по умолчанию 1; −1 — в обратную сторону" },
      mirror: { type: "boolean", help: "зеркально через плоскость симметрии тела" },
      id: { type: "string", help: "имя, по умолчанию copy_<кто>" },
    },
    mutates: true,
    run(ctx, a) {
      const clip = clipOf(ctx, a.clip);
      const pick = (bone: unknown, chain: unknown, what: string) => {
        if (chain) {
          const c = ctx.project.chains[String(chain)];
          need(c, `нет цепочки «${chain}»`);
          return c!;
        }
        need(bone, `нужна ${what}: кость или цепочка`);
        need(ctx.skeleton.nodes.some((n) => n.name === bone), `нет кости «${bone}»`);
        return [String(bone)];
      };
      const bones = pick(a.bone, a.chain, "кто повторяет");
      const source = pick(a.source, a.sourceChain, "за кем");
      const n = Math.min(bones.length, source.length);
      need(!bones.slice(0, n).some((b, k) => b === source[k]), "кость не может повторять сама себя");
      need(a.weight == null || (Number.isFinite(+a.weight) && Math.abs(+a.weight) <= 3), "weight — от −3 до 3");
      const c: Constraint = {
        id: a.id ?? `copy_${a.chain ?? a.bone}`,
        type: "copy",
        bones: bones.slice(0, n),
        source: source.slice(0, n),
        ...(a.weight != null && +a.weight !== 1 ? { weight: +a.weight } : {}),
        ...(a.mirror ? { mirror: true } : {}),
      };
      addConstraint(clip, c);
      return c;
    },
  },
  {
    name: "pose.reach",
    help: "Позинг: потянуть кость в точку в момент t — сгибаются length костей над ней с учётом пределов, результат пишется ключом позы (слой «pose»). length 0 — перенести тело целиком (за таз: присесть, наклониться; закреплённые IK-ступни останутся на месте).",
    args: {
      clip: { type: "string", required: true, help: "клип" },
      t: { type: "number", required: true, help: "время, с" },
      bone: { type: "string", required: true, help: "какую кость тянуть (кисть, голову, кончик хвоста, таз)" },
      target: { type: "string", required: true, help: "куда, «x,y,z» в координатах модели" },
      length: { type: "number", help: "сколько костей сгибать, по умолчанию 2" },
      end: { type: "boolean", help: "тянуть конец кости (у кости без дочерней: кисть-варежка, кончик хвоста) — сгибается и она сама" },
      endLength: { type: "number", help: "длина этого конца (по умолчанию — как у родительской кости; редактор мерит по коже)" },
      mirror: { type: "boolean", help: "зеркальный позинг: правка — и парной кости, отражённая" },
    },
    mutates: true,
    run(ctx, a) {
      const clip = clipOf(ctx, a.clip);
      const rig = buildRig(ctx.skeleton);
      need(rig.index.has(a.bone), `нет кости «${a.bone}»`);
      let length = a.length == null ? 2 : Math.max(0, Math.round(+a.length));
      // зеркальный позинг: сгибаются только кости, у которых есть пара (грудь и таз на оси тела — не отражаются
      // в другую сторону); та же правка, отражённая, — парным костям
      if (a.mirror) {
        const pairs = mirrorPairs(ctx.project, rig);
        let k = 0;
        for (let i = rig.parent[rig.index.get(a.bone)!]; k < length && i >= 0 && pairs[rig.skel.nodes[i].name]; i = rig.parent[i]) k++;
        length = a.end ? Math.max(1, k + 1) : k;
      }
      const r = reach(ctx.project, rig, clip, +a.t, a.bone, vec(a.target, "target"), length, !!a.end, a.endLength != null ? +a.endLength : undefined);
      if (a.mirror) {
        const m = mirrorPose(ctx.project, rig, r);
        for (const [bn, q] of Object.entries(m.rot)) if (!r.rot[bn]) r.rot[bn] = q;
        for (const [bn, v] of Object.entries(m.move)) if (!r.move[bn]) r.move[bn] = v;
      }
      const key = addPoseDelta(clip, +a.t, r);
      return { t: key.t, bones: [...Object.keys(r.rot), ...Object.keys(r.move)] };
    },
  },
  {
    name: "pose.mirror",
    help: "Вставить зеркальную позу: ключ позы из момента t отражается (левая ↔ правая, через плоскость тела) и пишется в момент to (по умолчанию тот же — поза становится зеркальной). Кости, которых нет в исходном ключе, в целевом не трогаются.",
    args: {
      clip: { type: "string", required: true, help: "клип" },
      t: { type: "number", required: true, help: "ключ-источник, с" },
      to: { type: "number", help: "куда, с (по умолчанию t)" },
      layer: { type: "string", help: "слой позы (по умолчанию pose)" },
    },
    mutates: true,
    run(ctx, a) {
      const clip = clipOf(ctx, a.clip);
      const rig = buildRig(ctx.skeleton);
      const l = clip.layers.find((x) => x.type === "pose" && x.id === (a.layer ?? "pose")) as PoseLayer | undefined;
      need(l, `нет слоя позы «${a.layer ?? "pose"}»`);
      const src = l!.keys.find((k) => Math.abs(k.t - +a.t) < 1e-6);
      need(src, `нет ключа позы в ${a.t} с; есть: ${l!.keys.map((k) => k.t).join(", ")}`);
      const m = mirrorPose(ctx.project, rig, src!);
      const to = a.to != null ? +a.to : +a.t;
      let k = l!.keys.find((x) => Math.abs(x.t - to) < 1e-6);
      // новый ключ — с тем, что слой давал в этот момент (как у позинга), иначе соседние ключи «потекут»
      if (!k && l === clip.layers.find((x) => x.type === "pose")) k = addPoseDelta(clip, to, { rot: {}, move: {} });
      if (!k) { l!.keys.push((k = { t: to })); l!.keys.sort((x, y) => x.t - y.t); }
      // в тот же ключ: сначала всё отражённое, потом то, чего в отражении нет (кости на оси — отражены)
      const rot = { ...(k === src ? {} : k.rot), ...m.rot }, move = { ...(k === src ? {} : k.move), ...m.move };
      if (k === src) {
        for (const [b, q] of Object.entries(src.rot ?? {})) if (!(b in rot)) rot[b] = q;
        for (const [b, v] of Object.entries(src.move ?? {})) if (!(b in move)) move[b] = v;
      }
      if (Object.keys(rot).length) k.rot = rot;
      if (Object.keys(move).length) k.move = move;
      return { clip: clip.name, from: +a.t, to, bones: [...Object.keys(m.rot), ...Object.keys(m.move)] };
    },
  },
  {
    name: "layer.mute",
    help: "Выключить слой (любой: рецепт, ключи, позы) или включить обратно (off).",
    args: { clip: { type: "string", required: true, help: "клип" }, layer: { type: "string", required: true, help: "id слоя" }, off: { type: "boolean", help: "включить обратно" } },
    mutates: true,
    run(ctx, a) {
      const l = clipOf(ctx, a.clip).layers.find((x) => x.id === a.layer);
      need(l, `нет слоя «${a.layer}»`);
      if (a.off) delete l!.muted; else l!.muted = true;
      return { layer: a.layer, muted: !a.off };
    },
  },
  {
    name: "layer.solo",
    help: "Соло слоя позы: остальные слои поз молчат, пока соло стоит; off — снять.",
    args: { clip: { type: "string", required: true, help: "клип" }, layer: { type: "string", required: true, help: "id слоя позы" }, off: { type: "boolean", help: "снять" } },
    mutates: true,
    run(ctx, a) {
      const l = clipOf(ctx, a.clip).layers.find((x) => x.id === a.layer);
      need(l && l.type === "pose", `нет слоя позы «${a.layer}»`);
      if (a.off) delete (l as PoseLayer).solo; else (l as PoseLayer).solo = true;
      return { layer: a.layer, solo: !a.off };
    },
  },
  {
    name: "pose.clear",
    help: "Убрать ключи позы: в момент t (или все), для кости bone (или всех).",
    args: {
      clip: { type: "string", required: true, help: "клип" },
      t: { type: "number", help: "время ключа; без него — все ключи" },
      bone: { type: "string", help: "кость; без неё — все" },
    },
    mutates: true,
    run(ctx, a) {
      const clip = clipOf(ctx, a.clip);
      const layer = clip.layers.find((l) => l.type === "pose") as PoseLayer | undefined;
      if (!layer) return { removed: 0 };
      let removed = 0;
      for (const k of layer.keys) {
        if (a.t != null && Math.abs(k.t - +a.t) > 1e-6) continue;
        for (const m of [k.rot, k.move]) {
          if (!m) continue;
          for (const b of Object.keys(m)) if (!a.bone || b === a.bone) delete m[b], removed++;
        }
      }
      layer.keys = layer.keys.filter((k) => Object.keys(k.rot ?? {}).length || Object.keys(k.move ?? {}).length);
      if (!layer.keys.length) clip.layers = clip.layers.filter((l) => l !== layer);
      return { removed };
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
      if (c.type === "copy") throw new Error("у копии поворота нет цели");
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
      length: { type: "number", help: "IK: сколько костей сгибать" },
    },
    mutates: true,
    run(ctx, a) {
      const c = constraintOf(clipOf(ctx, a.clip), a.id);
      if (a.weight != null) {
        if (c.type === "copy") need(Math.abs(+a.weight) <= 3, "weight копии — от −3 до 3");
        else need(+a.weight >= 0 && +a.weight <= 1, "weight — от 0 до 1");
        if (+a.weight === 1) delete c.weight;
        else c.weight = +a.weight;
      }
      if (a.muted != null) {
        if (a.muted) c.muted = true;
        else delete c.muted;
      }
      if (c.type === "copy") need(a.target == null && a.targetBone == null && a.offset == null, "у копии поворота нет цели");
      else if (a.target != null || a.targetBone != null) c.target = targetOf(ctx, a);
      else if (a.offset != null) c.target.offset = vec(a.offset, "offset");
      if (a.length != null && c.type === "ik") {
        const n = Math.max(1, Math.round(+a.length));
        if (n === 2) delete c.length;
        else c.length = n;
      }
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
    help: "Вес слоя (рецепта, ключей или поз): 1 — как есть, 0 — выключен, между — ослаблен (несколько слоёв — через запятую).",
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
        need(l && l.type !== undefined, `нет слоя «${id}»`);
        return l as RecipeLayer | KeyLayer | PoseLayer;
      });
      for (const l of layers) if (+a.weight === 1) delete l.weight; else l.weight = +a.weight;
      return { layers: ids, weight: +a.weight };
    },
  },
  ...(
    [
      ["clip.mirror", "Зеркало: левая сторона делает то, что делала правая (поза отражается через плоскость симметрии тела). as — сделать зеркальную копию, иначе — переключить у самого клипа; off — снять.", "mirror"],
      ["clip.reverse", "Задом наперёд: клип идёт от конца к началу, события — в зеркальные моменты. as — копия, иначе — переключить; off — снять.", "reverse"],
    ] as const
  ).map(([name, help, field]) => ({
    name,
    help,
    args: {
      clip: { type: "string", required: true, help: "клип" },
      as: { type: "string", help: "имя копии (по умолчанию правится сам клип)" },
      off: { type: "boolean", help: "снять" },
    },
    mutates: true,
    run(ctx: Ctx, a: Record<string, any>) {
      const src = clipOf(ctx, a.clip);
      let c = src;
      if (a.as) {
        need(!ctx.project.clips.some((x) => x.name === a.as), `клип «${a.as}» уже есть`);
        c = { ...structuredClone(src), name: String(a.as) };
        ctx.project.clips.push(c);
      }
      const on = a.off ? false : a.as ? !src[field] : !c[field];
      if (on) c[field] = true;
      else delete c[field];
      return { clip: c.name, [field]: on };
    },
  })),
  {
    name: "clip.inplace",
    help: "На месте по осям тела: ход клипа (конец − начало) снимается с таза и корня равномерно за клип — корень перестаёт уезжать, качание внутри шага остаётся. axes — forward, side, up, yaw через запятую; пусто — снять.",
    args: {
      clip: { type: "string", required: true, help: "клип" },
      axes: { type: "string", help: "например forward,side,yaw; по умолчанию forward,side" },
      off: { type: "boolean", help: "снять" },
    },
    mutates: true,
    run(ctx, a) {
      const c = clipOf(ctx, a.clip);
      if (a.off) {
        delete c.inPlace;
        return { clip: c.name, inPlace: null };
      }
      const ax = String(a.axes ?? "forward,side").split(",").map((x) => x.trim()).filter(Boolean);
      need(ax.every((x) => ["forward", "side", "up", "yaw"].includes(x)), "оси: forward, side, up, yaw");
      c.inPlace = ax as NonNullable<Clip["inPlace"]>;
      return { clip: c.name, inPlace: c.inPlace };
    },
  },
  {
    name: "clip.compose",
    help: "Сложить клипы по частям тела: цепочки chains (например arm_l,arm_r,chest) этого клипа берутся из клипа from — его рецепты на этих цепочках, ключи и позы их костей; остальное тело остаётся своим (ноги идут, руки бьют). mode=add — добавить поверх своих, а не заменить.",
    args: {
      clip: { type: "string", required: true, help: "куда (база)" },
      from: { type: "string", required: true, help: "откуда брать части тела" },
      chains: { type: "string", required: true, help: "цепочки через запятую" },
      mode: { type: "string", help: "replace (по умолчанию) | add" },
    },
    mutates: true,
    run(ctx, a) {
      const dst = clipOf(ctx, a.clip), src = clipOf(ctx, a.from);
      need(dst !== src, "from — другой клип");
      const chains = String(a.chains).split(",").map((x) => x.trim()).filter(Boolean);
      for (const c of chains) need(ctx.project.chains[c], `нет цепочки «${c}»`);
      const mode = a.mode ?? "replace";
      need(mode === "replace" || mode === "add", "mode — replace или add");
      const bones = new Set(chains.flatMap((c) => ctx.project.chains[c]));
      const onPart = (l: Layer) => l.type === "recipe" && chains.includes(l.target.chain);
      const removed: string[] = [];
      if (mode === "replace") {
        dst.layers = dst.layers.flatMap((l): Layer[] => {
          if (onPart(l)) { removed.push(l.id); return []; }
          if (l.type === "keys") { const tracks = l.tracks.filter((t) => !bones.has(t.bone)); return tracks.length ? [{ ...l, tracks }] : []; }
          if (l.type === "pose") {
            const keys = l.keys.map((k) => ({ ...k, rot: k.rot && Object.fromEntries(Object.entries(k.rot).filter(([b]) => !bones.has(b))), move: k.move && Object.fromEntries(Object.entries(k.move).filter(([b]) => !bones.has(b))) }));
            return [{ ...l, keys }];
          }
          return [l];
        });
      }
      const ids = new Set(dst.layers.map((l) => l.id));
      const uid = (id: string) => { let n = `${src.name}_${id}`, k = 2; while (ids.has(n)) n = `${src.name}_${id}_${k++}`; ids.add(n); return n; };
      const added: string[] = [];
      for (const l of src.layers) {
        let copy: Layer | undefined;
        if (onPart(l)) copy = structuredClone(l);
        else if (l.type === "keys") { const tracks = l.tracks.filter((t) => bones.has(t.bone)); if (tracks.length) copy = { ...structuredClone(l), tracks: structuredClone(tracks) }; }
        else if (l.type === "pose") {
          const keys = l.keys
            .map((k) => ({ ...k, rot: k.rot && Object.fromEntries(Object.entries(k.rot).filter(([b]) => bones.has(b))), move: k.move && Object.fromEntries(Object.entries(k.move).filter(([b]) => bones.has(b))) }))
            .filter((k) => Object.keys(k.rot ?? {}).length || Object.keys(k.move ?? {}).length);
          if (keys.length) copy = { ...l, keys: structuredClone(keys) };
        }
        if (copy) { copy.id = uid(l.id); dst.layers.push(copy); added.push(copy.id); }
      }
      need(added.length, `в «${src.name}» на цепочках ${chains.join(", ")} нечего брать`);
      return { clip: dst.name, from: src.name, chains, removed, added };
    },
  },
  {
    name: "hand.pose",
    help: `Поза кисти ключом позы: ${Object.entries(HAND_POSES).map(([k, v]) => `${k} — ${v.help}`).join("; ")}. Ключ — в момент t (по умолчанию 0: одна поза на весь клип); несколько ключей — кисть переходит от позы к позе. Слой «hands».`,
    args: {
      clip: { type: "string", required: true, help: "клип" },
      side: { type: "string", required: true, help: "l | r | both" },
      pose: { type: "string", required: true, help: Object.keys(HAND_POSES).join(" | ") },
      t: { type: "number", help: "момент ключа, с (0)" },
    },
    mutates: true,
    run(ctx, a) {
      const clip = clipOf(ctx, a.clip);
      const rig = buildRig(ctx.skeleton);
      const sides = a.side === "both" ? (["l", "r"] as const) : [a.side as "l" | "r"];
      need(sides.every((s) => s === "l" || s === "r"), "side — l, r или both");
      const t = +(a.t ?? 0);
      let l = clip.layers.find((x) => x.type === "pose" && x.id === "hands") as PoseLayer | undefined;
      if (!l) clip.layers.push((l = { id: "hands", type: "pose", keys: [] }));
      let k = l.keys.find((x) => Math.abs(x.t - t) < 1e-6);
      if (!k) { l.keys.push((k = { t })); l.keys.sort((x, y) => x.t - y.t); }
      const set: Record<string, number> = {};
      for (const s of sides) {
        const rot = handPose(ctx.project, rig, s, String(a.pose));
        // кости этой кисти — заменить целиком (open — пусто: пальцы прямо)
        for (const f of fingersOf(ctx.project, rig, s)!.fingers) for (const b of f.bones) if (k.rot) delete k.rot[b];
        for (const [b, q] of Object.entries(rot)) (k.rot ??= {})[b] = q;
        set[s] = Object.keys(rot).length;
      }
      return { clip: clip.name, t, pose: a.pose, bones: set };
    },
  },
  {
    name: "clip.follow",
    help: "Догоняющее движение (follow-through): грудь догоняет таз, голова и руки — грудь, через пружину. lag — запаздывание, с (0.08); bounce — перелёт 0…1 (0.3); loosen — доля 0…1 (0.6: 1 — грудь целиком отстаёт от таза, 0 — выключено). Без аргументов — убрать.",
    args: {
      clip: { type: "string", required: true, help: "клип" },
      lag: { type: "number", help: "0.01…0.5 с" },
      bounce: { type: "number", help: "0…1" },
      loosen: { type: "number", help: "0…1" },
    },
    mutates: true,
    run(ctx, a) {
      const clip = clipOf(ctx, a.clip);
      if (a.lag == null && a.bounce == null && a.loosen == null) {
        delete clip.follow;
        return { clip: clip.name, follow: null };
      }
      const rng = (k: string, lo: number, hi: number) => a[k] == null || (Number.isFinite(+a[k]) && +a[k] >= lo && +a[k] <= hi);
      need(rng("lag", 0.01, 0.5) && rng("bounce", 0, 1) && rng("loosen", 0, 1), "lag 0.01…0.5, bounce 0…1, loosen 0…1");
      need(followBones(ctx.project).length, "нужны цепочки pelvis и spine или chest (rig.detect)");
      const f = { ...clip.follow };
      for (const k of ["lag", "bounce", "loosen"] as const) if (a[k] != null) f[k] = +a[k];
      clip.follow = f;
      return { clip: clip.name, follow: f, chase: followBones(ctx.project) };
    },
  },
  {
    name: "clip.micro",
    help: "Микродвижения: мелкие плавные случайные покачивания таза, спины, шеи, головы и рук поверх клипа — «живость» стойки, разговора, ожидания. amount — размах, ° (1.5); speed — частота, Гц (0.4); seed — зерно (1): другое зерно — другие движения, у двух персонажей с одной стойкой — не в унисон. У цикла шва нет. Без аргументов — убрать.",
    args: {
      clip: { type: "string", required: true, help: "клип" },
      amount: { type: "number", help: "0…10 °" },
      speed: { type: "number", help: "0.05…3 Гц" },
      seed: { type: "number", help: "целое 0…2³¹" },
    },
    mutates: true,
    run(ctx, a) {
      const clip = clipOf(ctx, a.clip);
      if (a.amount == null && a.speed == null && a.seed == null) {
        delete clip.micro;
        return { clip: clip.name, micro: null };
      }
      const rng = (k: string, lo: number, hi: number) => a[k] == null || (Number.isFinite(+a[k]) && +a[k] >= lo && +a[k] <= hi);
      need(rng("amount", 0, 10) && rng("speed", 0.05, 3) && rng("seed", 0, 2 ** 31) && (a.seed == null || Number.isInteger(+a.seed)), "amount 0…10, speed 0.05…3, seed — целое 0…2³¹");
      need(microBones(ctx.project).length, "нужны цепочки тела (rig.detect)");
      const m = { ...clip.micro };
      for (const k of ["amount", "speed", "seed"] as const) if (a[k] != null) m[k] = +a[k];
      clip.micro = m;
      return { clip: clip.name, micro: m, bones: microBones(ctx.project).map(([b]) => b) };
    },
  },
  {
    name: "layer.shape",
    help: "Правка кривых слоя-рецепта (как Late / Amount / Step): late — сдвиг по фазе, доля периода (0.1 — на десятую цикла позже); amount — размах вокруг среднего (1.5 — в полтора раза шире, 0 — среднее значение); step — задержка каждой следующей кости цепочки, доля периода (волна по позвоночнику, хвосту, руке). Слои — по id или все слои цепочки (chain).",
    args: {
      clip: { type: "string", required: true, help: "клип" },
      layer: { type: "string", help: "id слоя или «id1,id2»" },
      chain: { type: "string", help: "или все слои-рецепты на цепочке (pelvis, leg_l, tail…)" },
      late: { type: "number", help: "−1…1, доля периода" },
      amount: { type: "number", help: "0…3, множитель размаха" },
      step: { type: "number", help: "−0.5…0.5, доля периода на кость" },
      reset: { type: "boolean", help: "убрать правку" },
    },
    mutates: true,
    run(ctx, a) {
      const clip = clipOf(ctx, a.clip);
      need(a.layer || a.chain, "нужен layer или chain");
      const layers = a.layer
        ? String(a.layer).split(",").map((id) => {
            const l = clip.layers.find((l) => l.id === id.trim());
            need(l && l.type === "recipe", `нет слоя-рецепта «${id}»`);
            return l as RecipeLayer;
          })
        : (clip.layers.filter((l) => l.type === "recipe" && l.target.chain === a.chain) as RecipeLayer[]);
      need(layers.length, `на цепочке «${a.chain}» нет слоёв-рецептов`);
      const rng = (k: string, lo: number, hi: number) => a[k] == null || (Number.isFinite(+a[k]) && +a[k] >= lo && +a[k] <= hi);
      need(rng("late", -1, 1) && rng("amount", 0, 3) && rng("step", -0.5, 0.5), "late −1…1, amount 0…3, step −0.5…0.5");
      for (const l of layers) {
        if (a.reset) { delete l.shape; continue; }
        const sh = { ...l.shape };
        for (const k of ["late", "amount", "step"] as const) if (a[k] != null) sh[k] = +a[k];
        if (sh.late === 0) delete sh.late;
        if (sh.step === 0) delete sh.step;
        if (sh.amount === 1) delete sh.amount;
        if (Object.keys(sh).length) l.shape = sh; else delete l.shape;
      }
      return { layers: layers.map((l) => ({ id: l.id, shape: l.shape ?? null })) };
    },
  },
  {
    name: "clip.directions",
    help: "8 направлений из прямой ходьбы (стрейф, назад, диагонали): копии клипа <clip>_fwd, _fwd_l, _left, _back_l, _back, _back_r, _right, _fwd_r с ходом под углом (travel). face=aim — взгляд вперёд, таз доворачивает к ходу, грудь держит плечи на цели; face=travel — всё тело поворачивается по ходу. Плоскость маха подбирается замером, чтобы тело шло точно под углом; все — с той же фазы шага, для смешивания в движке.",
    args: {
      clip: { type: "string", required: true, help: "прямая ходьба или бег (цикл, лучше с clip.ground)" },
      face: { type: "string", help: "aim (по умолчанию) | travel" },
      angles: { type: "string", help: "свои углы через запятую, ° (+ — влево); по умолчанию 8 направлений через 45°" },
      replace: { type: "boolean", help: "перезаписать клипы направлений, если уже есть" },
    },
    mutates: true,
    run(ctx, a) {
      const base = clipOf(ctx, a.clip);
      need(base.loop, `«${a.clip}» не цикл — направления делаются из цикла ходьбы`);
      need(!base.travel, `«${a.clip}» уже под углом — нужна прямая ходьба`);
      const face = a.face === "travel" ? "travel" : "aim";
      const angles: number[] = a.angles ? String(a.angles).split(",").map((x) => Number(x.trim())) : [0, 45, 90, 135, 180, -135, -90, -45];
      for (const x of angles) need(Number.isFinite(x), `угол «${x}» — не число`);
      const rig = buildRig(ctx.skeleton);
      const made = angles.map((angle) => {
        const w = wrapAngle(angle);
        const name = `${base.name}_${DIRECTION_NAMES[w] ?? `d${w < 0 ? "m" : ""}${Math.abs(w).toFixed(0).padStart(3, "0")}`}`;
        const old = ctx.project.clips.findIndex((c) => c.name === name);
        need(old < 0 || a.replace, `клип «${name}» уже есть (replace=true — перезаписать)`);
        const c = directionClip(ctx.project, rig, base, w, name, face);
        if (old >= 0) ctx.project.clips[old] = c;
        else ctx.project.clips.push(c);
        return { clip: name, angle: w, travel: c.travel, duration: c.duration };
      });
      return { face, source: DIRECTIONS_SOURCE, clips: made };
    },
  },
  {
    name: "clip.gait",
    help: "Стиль походки поверх любых слоёв цикла: speed (×, частота ^0.6, шаг ^0.4 — длина клипа меняется сама), bounce, sway, arms, lift (× вокруг среднего за цикл), width (°), lower (доля роста), lean, posture (°), stance (доля опоры 0.2…0.85: шаг ~0.6, бег ~0.35). style — готовый набор: stroll | brisk | heavy | sneak; поля поверх него. Без style и gait — убрать.",
    args: {
      clip: { type: "string", required: true, help: "цикл ходьбы" },
      style: { type: "string", help: "stroll | brisk | heavy | sneak" },
      gait: { type: "json", help: "ручки, например {\"speed\":1.2,\"bounce\":0.5}" },
    },
    mutates: true,
    run(ctx, a) {
      const clip = clipOf(ctx, a.clip);
      need(clip.loop, `«${a.clip}» не цикл — стиль походки ставится на цикл`);
      const keys = ["speed", "bounce", "sway", "arms", "lift", "width", "lower", "lean", "posture", "stance"];
      if (a.style) need(GAIT_STYLES[a.style], `нет стиля «${a.style}». Есть: ${Object.keys(GAIT_STYLES).join(", ")}`);
      for (const [k, v] of Object.entries(a.gait ?? {})) need(keys.includes(k) && Number.isFinite(Number(v)), `gait.${k}: есть ${keys.join(", ")}, числа`);
      const next = a.style || a.gait ? { ...(a.style ? GAIT_STYLES[a.style].gait : {}), ...Object.fromEntries(Object.entries(a.gait ?? {}).map(([k, v]) => [k, Number(v)])) } : undefined;
      need(!next?.speed || next.speed > 0, "speed > 0");
      need(next?.stance == null || (next.stance >= 0.2 && next.stance <= 0.85), "stance — доля опоры 0.2…0.85");
      // длина клипа — под новую частоту шагов: в цикле те же шаги
      clip.duration = +((clip.duration * gaitCadence(clip.gait)) / gaitCadence(next)).toFixed(4);
      if (next) clip.gait = next;
      else delete clip.gait;
      return { gait: clip.gait ?? null, duration: clip.duration };
    },
  },
  {
    name: "clip.travel",
    help: "Ход под углом для одного клипа (поля Travel: angle, hips, chest, look, feet, width, stride, swing, reverse). Без angle — убрать.",
    args: {
      clip: { type: "string", required: true, help: "клип" },
      travel: { type: "json", help: "например {\"angle\":90,\"hips\":25,\"chest\":0.8,\"look\":1,\"feet\":25,\"width\":6,\"stride\":0.8}; без него — убрать" },
    },
    mutates: true,
    run(ctx, a) {
      const clip = clipOf(ctx, a.clip);
      if (!a.travel || a.travel.angle === undefined) { delete clip.travel; return { travel: null }; }
      const keys = ["angle", "hips", "chest", "look", "feet", "width", "stride", "swing", "reverse"];
      for (const [k, v] of Object.entries(a.travel)) need(keys.includes(k) && (k === "reverse" ? typeof v === "boolean" : Number.isFinite(Number(v))), `travel.${k}: есть поля ${keys.join(", ")}; числа, reverse — true/false`);
      clip.travel = Object.fromEntries(Object.entries(a.travel).map(([k, v]) => [k, k === "reverse" ? v : Number(v)])) as unknown as Clip["travel"];
      return clip.travel;
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
