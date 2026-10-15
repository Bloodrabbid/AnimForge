// Советы к находкам проверок: что поменять и что тогда станет — не догадкой, а пробой. Для каждой находки мерка
// «насколько плохо» (1 — порог: ≤ 1 — проверка проходит), кандидаты — по одной ручке за раз: вес слоя, параметр
// рецепта ×0.8 / ×1.25, ступни на пол. Каждого кандидата меряем той же меркой, лучшие два — в совет с числами
// и готовыми командами (agent применяет их как есть). Так у ActionForge отчёт Motion Lab: «стопа скользит на 40 мм —
// укороти шаг или опусти таз»; у нас то же, но для любой проверки и любого рецепта, и цифры после правки — замер.
import { RECIPES, clipEvents, gaitSlide, motionAt, posePartsAt, withDefaults, type Clip, type Project, type RecipeLayer, type buildRig } from "../../core/src/index.ts";
import { LIMITS, footBones, sinkOf, skinBad, type Finding, type Mesh } from "./checks.ts";
import { skinFrame } from "./skin.ts";
import type { Ctx } from "../../core/src/index.ts";

type Rig = ReturnType<typeof buildRig>;
type Step = { name: string; args: Record<string, unknown> };
export interface Advice {
  /** что сделать, словами */
  text: string;
  /** мерка после правки: ≤ 1 — проверка проходит */
  after: number;
  /** команды ядра — применить как есть */
  steps: Step[];
}

/** Мерка «насколько плохо» для проверки; 1 — ровно на пороге. null — у проверки нет числа, которое можно пробовать. */
export function badnessOf(check: Finding["check"], project: Project, rig: Rig, m: Mesh, clip: Clip): ((c: Clip) => number) | null {
  const H = m.H;
  const low = (c: Clip, n: number) => {
    let z = Infinity;
    for (let k = 0; k < n; k++) {
      const f = skinFrame(m.sc, posePartsAt(project, rig, c, (c.duration * (k + 0.37)) / n));
      for (let i = 2; i < f.length; i += 3) z = Math.min(z, f[i]);
    }
    return z - m.floor;
  };
  const at = (c: Clip, t: number) => skinFrame(m.sc, posePartsAt(project, rig, c, t));
  const dist = (a: Float32Array, b: Float32Array) => { let d = 0; for (let i = 0; i < a.length; i += 3) d = Math.max(d, Math.hypot(a[i] - b[i], a[i + 1] - b[i + 1], a[i + 2] - b[i + 2])); return d; };
  switch (check) {
    case "skin": return (c) => skinBad(project, rig, m, c, 11).bad / LIMITS.skinBad;
    case "floor": return (c) => sinkOf(project, rig, m, c, 11).d / (LIMITS.floor * H);
    case "float": return (c) => low(c, 11) / (LIMITS.float * H);
    case "slide": return (c) => {
      const g = gaitSlide(project, rig, c);
      if (!g) return 0;
      const min = LIMITS.minSpeed * H;
      // топтание и «лунная» хуже любого скольжения: мерка > 1, пока шаг не уезжает назад как надо
      return g.speed < min ? 1 + (min - g.speed) / min : g.mean / LIMITS.slide;
    };
    case "seam": return (c) => {
      if (!c.loop) return 0;
      const eps = Math.min(1e-3, c.duration / 1000);
      return dist(at(c, c.duration - eps), at(c, eps)) / (LIMITS.seam * H);
    };
    case "pop": return (c) => {
      const n = Math.max(12, Math.min(90, Math.round(c.duration * c.fps)));
      const fr = Array.from({ length: n + 1 }, (_, k) => at(c, Math.min(c.duration, (c.duration * k) / n)));
      const step = fr.slice(1).map((f, k) => dist(fr[k], f));
      const med = [...step].sort((a, b) => a - b)[Math.floor(step.length / 2)] || 1e-9;
      const hits = clipEvents(c).filter((e) => e.name === "hit").map((e) => e.t);
      const free = step.map((d, k) => (hits.some((h) => Math.abs(h - (c.duration * (k + 1)) / n) < 0.1) ? 0 : d));
      const pk = Math.max(...free);
      // рывок — когда и в разы больше обычного, и заметно в долях роста: проходит, если не выполнено хоть одно
      return Math.min(pk / med / LIMITS.pop, pk / (LIMITS.popMin * H));
    };
    case "limits": return (c) => {
      if (!project.limits) return 0;
      const n = Math.max(12, Math.min(90, Math.round(c.duration * c.fps)));
      const hit = new Map<string, number>();
      for (let k = 0; k < n; k++) for (const b of motionAt(project, rig, c, (c.duration * k) / n).limited) hit.set(b, (hit.get(b) ?? 0) + 1);
      return Math.max(0, ...[...hit.values()].map((v) => v / n)) / LIMITS.limits;
    };
    case "timing": {
      const role = (project.style?.role ?? "").toLowerCase();
      const hitT = (c: Clip) => clipEvents(c).find((e) => e.name === "hit")?.t;
      if (/player|игрок/.test(role)) return (c) => (hitT(c) ?? 0) / 0.35;
      if (/enemy|npc|враг/.test(role)) return (c) => { const t = hitT(c); return t === undefined ? 0 : 0.3 / Math.max(1e-3, t); };
      return null;
    }
    default: return null;
  }
}

/** Ручка параметра коротко: начало подсказки рецепта до скобки или точки с запятой. */
const label = (help: string) => help.split(/[(;:,—]/)[0].trim();
const fmt = (v: number) => +v.toFixed(Math.abs(v) >= 10 ? 0 : Math.abs(v) >= 1 ? 1 : 3);

/** Кандидаты правок по одной ручке. cheap — мерка дешёвая (по костям): тогда пробуем все числовые параметры,
 * иначе — только главные (main), чтобы проверка с кожей не растянулась на минуты. */
function candidates(project: Project, ctx: Ctx, clip: Clip, check: Finding["check"], cheap: boolean): { text: string; apply: (c: Clip) => void; steps: Step[] }[] {
  const out: { text: string; apply: (c: Clip) => void; steps: Step[] }[] = [];
  const recipeLayers = clip.layers.filter((l): l is RecipeLayer => l.type === "recipe");
  // 1. вес слоя — грубо, но всегда работает: видно, какой слой виноват
  for (const l of recipeLayers) {
    const w = l.weight ?? 1;
    if (w <= 0.05) continue;
    for (const k of [0.7, 0.5]) {
      const nw = +(w * k).toFixed(2);
      out.push({ text: `ослабить слой ${l.id} (${l.recipe}) ${w} → ${nw}`, apply: (c) => { (c.layers.find((x) => x.id === l.id) as RecipeLayer).weight = nw; }, steps: [{ name: "layer.set", args: { clip: clip.name, layer: l.id, weight: nw } }] });
    }
  }
  // 2. параметры рецептов: один параметр на всех слоях рецепта сразу (пресет ставит их одинаково на все роли)
  const byRecipe = new Map<string, RecipeLayer[]>();
  for (const l of recipeLayers) byRecipe.set(l.recipe, [...(byRecipe.get(l.recipe) ?? []), l]);
  for (const [recipe, layers] of byRecipe) {
    const def = RECIPES[recipe];
    if (!def) continue;
    const names = Object.entries(def.params).filter(([k, s]) => s.type === "number" && (cheap || def.main?.includes(k))).map(([k]) => k);
    for (const k of names) {
      const s = def.params[k];
      const cur = Number(withDefaults(def, layers[0].params)[k]);
      const lo = s.min ?? -Infinity, hi = s.max ?? Infinity;
      // ноль ×1.25 — всё ещё ноль: тогда шаг — десятая часть диапазона
      const vals = cur === 0 ? [Number.isFinite(hi - lo) ? (hi - lo) * 0.1 : 1] : [cur * 0.8, cur * 1.25];
      for (const raw of vals) {
        const v = fmt(Math.max(lo, Math.min(hi, raw)));
        if (Math.abs(v - cur) < 1e-9) continue;
        const unit = s.unit ? ` ${s.unit}` : "";
        const more = v > cur ? "больше" : "меньше";
        // период цикла: петля длиной в целое число периодов — меняем и длину клипа, иначе шов разорвётся
        const loopPeriod = k === "period" && clip.loop;
        const dur = loopPeriod ? +(clip.duration * (v / cur)).toFixed(4) : clip.duration;
        const steps: Step[] = layers.map((l) => ({ name: "recipe.set", args: { clip: clip.name, layer: l.id, params: { [k]: v } } }));
        if (loopPeriod) steps.push({ name: "clip.set", args: { clip: clip.name, duration: dur } });
        out.push({
          text: `${k} ${fmt(cur)} → ${v}${unit} (${label(s.help)} — ${more})`,
          apply: (c) => { for (const l of c.layers) if (l.type === "recipe" && l.recipe === recipe) l.params = { ...l.params, [k]: v }; c.duration = dur; },
          steps,
        });
      }
    }
  }
  // 3. ступни на пол: колени гнутся, опорная стопа плоско — для пола, парения и скольжения
  if (/floor|float|slide/.test(check) && (!clip.ground?.ik || !clip.ground?.flat)) {
    const bones = clip.ground?.bones.length ? clip.ground.bones : footBones(project, ctx);
    if (bones.length) {
      const g = { bones, mode: check === "float" ? "contact" as const : clip.ground?.mode ?? "floor" as const, ik: true, flat: true };
      out.push({ text: `ступни на пол (${g.mode}, IK, опорная стопа плоско)`, apply: (c) => { c.ground = g; }, steps: [{ name: "clip.ground", args: { clip: clip.name, bones: bones.join(","), mode: g.mode, ik: true, flat: true } }] });
    }
  }
  return out;
}

/** Советы к находке: лучшие правки по одной ручке с числом «что станет». Пусто — ни одна ручка не помогает заметно. */
export function advise(project: Project, ctx: Ctx, rig: Rig, m: Mesh, clip: Clip, f: Finding, top = 2): Advice[] {
  // у этих проверок совет однозначный — пробовать нечего
  if (f.check === "length") return [{ text: "удлинить клип до последнего события: clip.set fit", after: 0, steps: [{ name: "clip.set", args: { clip: clip.name, fit: true } }] }];
  const bad = badnessOf(f.check, project, rig, m, clip);
  if (!bad) return [];
  const cheap = /slide|limits|timing/.test(f.check);
  const now = bad(clip);
  if (now <= 1) return [];
  // кожа — сторож: правка, после которой кожа рвётся сильнее, — не совет (кроме совета для самой кожи)
  const skin = f.check === "skin" ? null : (c: Clip) => skinBad(project, rig, m, c, 11).bad;
  const skin0 = skin ? skin(clip) : 0;
  const tried = candidates(project, ctx, clip, f.check, cheap).map((cand) => {
    const c = structuredClone(clip);
    cand.apply(c);
    return { ...cand, after: bad(c), c };
  });
  // заметно лучше: хотя бы на 15 % ближе к порогу; ослабление слоя — только если параметром не вышло
  const good = tried.filter((x) => x.after < now - 0.15 * (now - 1) - 0.05 * now).sort((a, b) => a.after - b.after);
  const params = good.filter((x) => !x.text.startsWith("ослабить"));
  const pick = [...params, ...good.filter((x) => x.text.startsWith("ослабить"))];
  const out: Advice[] = [];
  for (const x of pick) {
    if (out.length >= top) break;
    if (skin && skin(x.c) > Math.max(skin0 * 1.2, LIMITS.skinBad)) continue;
    out.push({ text: `${x.text} → ${say(f.check, x.after, m, project, rig, x.c)}`, after: +x.after.toFixed(2), steps: x.steps });
  }
  // кожа рвётся, а ни одна ручка движения не спасает — виновата модель: жёсткая граница весов в сгибе (колено рабочего)
  if (f.check === "skin" && !out.some((x) => x.after <= 1)) out.push({ text: "движением не чинится — сгладить веса модели у суставов: weights.smooth (check --fix пробует сам и оставляет, если помогло)", after: now, steps: [{ name: "weights.smooth", args: {} }] });
  return out;
}

/** Мерку — обратно словами и в единицах игры (мм, м/с), как в находке. */
function say(check: Finding["check"], v: number, m: Mesh, project: Project, rig: Rig, c: Clip): string {
  const ok = v <= 1 ? "проходит" : "лучше, но не проходит";
  const mm = (share: number) => `${Math.round(share * m.H * 1000)} мм`;
  switch (check) {
    case "skin": return `рвётся ${(v * LIMITS.skinBad * 100).toFixed(2)} % рёбер (${ok})`;
    case "floor": return `провал ${(v * LIMITS.floor * 100).toFixed(1)} % роста, ${mm(v * LIMITS.floor)} (${ok})`;
    case "float": return `зазор ${(v * LIMITS.float * 100).toFixed(1)} % роста (${ok})`;
    case "slide": {
      const g = gaitSlide(project, rig, c)!;
      return `стопа проезжает ${(g.mean * 100).toFixed(1)} % роста (${mm(g.mean)}) за шаг, шаг ${(g.speed / m.H).toFixed(2)} роста/с — ${g.speed.toFixed(2)} м/с (${ok})`;
    }
    case "seam": return `шов ${(v * LIMITS.seam * 100).toFixed(2)} % роста (${ok})`;
    case "pop": return v <= 1 ? "рывка нет" : "рывок меньше, но остался";
    case "limits": return `в пределе ${Math.round(v * LIMITS.limits * 100)} % клипа (${ok})`;
    case "timing": return `удар в ${(clipEvents(c).find((e) => e.name === "hit")?.t ?? 0).toFixed(2)} с (${ok})`;
    default: return ok;
  }
}
