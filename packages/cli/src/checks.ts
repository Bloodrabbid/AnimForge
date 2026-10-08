// Автопроверки клипов — то, что в студии ловят на дейлиз и что меряется числом (docs/review-criteria.md).
// Считаются по настоящей коже (skin.ts), а не по костям: «геометрия поплыла» видно только на вершинах.
// Что умеют — чинят сами (fix): рвущий кожу слой ослабляют, проваленный в пол клип ставят на пол.
// Пороги — «на глаз», кроме помеченных источником; каждый записан рядом с проверкой.
import { NodeIO } from "@gltf-transform/core";
import { join } from "node:path";
import { buildRig, clipEvents, motionAt, posePartsAt, RECIPES, withDefaults, type Clip, type Ctx, type Project } from "../../core/src/index.ts";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { call, findPreset, loadCtx, smoothWeights } from "./node.ts";
import { heightOf, loadSkinScene, meshEdges, restVerts, skinFrame, stretchOf, type SkinScene } from "./skin.ts";

export interface Finding {
  check: "skin" | "floor" | "float" | "seam" | "pop" | "limits" | "timing" | "length";
  level: "fail" | "warn";
  msg: string;
  t?: number;
  value?: number;
  fixed?: string;
}

export interface ClipReport {
  clip: string;
  ok: boolean;
  findings: Finding[];
  metrics: Record<string, number>;
}

/** Пороги. Растяжение и сдвиги — в долях роста модели. */
export const LIMITS = {
  skinBad: 0.005, // > 0,5 % рёбер растянуто/сжато в 1,6+ раза — кожа рвётся (на глаз; проверено на пекаре и рабочем)
  skinTol: 1.6,
  floor: 0.01, // провал ниже пола больше 1 % роста (на глаз)
  float: 0.04, // все кадры выше пола на 4 % роста — парит (на глаз; для походок)
  seam: 0.01, // разрыв позы на стыке цикла — 1 % роста (на глаз; Unity подсвечивает то же — LoopingAnimationClips)
  pop: 3, // скачок за кадр в 3 раза больше медианы клипа (3σ-правило, на глаз) …
  popMin: 0.02, // … и больше 2 % роста
  limits: 0.3, // кость упирается в предел больше трети клипа — анимация борется с анатомией (на глаз)
};

/** Модель для проверок: кожа, рёбра, поза привязки и рост. Загружается один раз на make. */
export async function loadMesh(ctx: Ctx & { dir: string }) {
  const sc = loadSkinScene(await new NodeIO().read(join(ctx.dir, ctx.project.model)));
  const rest = skinFrame(sc, { rot: new Map(), pos: new Map(), scl: new Map() });
  let floor = Infinity;
  for (let i = 2; i < rest.length; i += 3) floor = Math.min(floor, rest[i]);
  return { sc, rest, edges: meshEdges(sc), H: heightOf(rest), floor, dom: restVerts(sc).dom };
}
type Mesh = Awaited<ReturnType<typeof loadMesh>>;

const frameCount = (clip: Clip) => Math.max(12, Math.min(90, Math.round(clip.duration * clip.fps)));

/** Худший кадр по коже. Кадров — простое число со сдвигом фазы: равномерные 8 кадров на ходьбу из четырёх шагов
 * попадают всегда в одни и те же фазы и пропускают разрыв (так и было: 8 кадров — 0,2 %, 12 — 4,5 %). */
/** Глубже всего под полом за клип (по вершинам кожи), в единицах модели; те же кадры со сдвигом фазы. */
function sinkOf(project: Project, rig: ReturnType<typeof buildRig>, m: Mesh, clip: Clip, n = 31) {
  let d = 0, at = 0;
  for (let k = 0; k < n; k++) {
    const t = (clip.duration * (k + 0.37)) / n;
    const f = skinFrame(m.sc, posePartsAt(project, rig, clip, t));
    for (let i = 2; i < f.length; i += 3) if (m.floor - f[i] > d) { d = m.floor - f[i]; at = t; }
  }
  return { d, t: at };
}

function skinBad(project: Project, rig: ReturnType<typeof buildRig>, m: Mesh, clip: Clip, n = 31) {
  let worst = { bad: 0, worst: 1, worstVertex: -1, t: 0 };
  for (let k = 0; k < n; k++) {
    const t = (clip.duration * (k + 0.37)) / n;
    const s = stretchOf(m.rest, skinFrame(m.sc, posePartsAt(project, rig, clip, t)), m.edges, 0.01 * m.H, LIMITS.skinTol);
    if (s.bad > worst.bad) worst = { ...s, t };
  }
  return worst;
}

/** Проверить клип. fix — разрешить чинить: возвращает и правки (команды), которые надо записать в проект. */
export function checkClip(project: Project, ctx: Ctx, m: Mesh, clip: Clip, fix: boolean): { report: ClipReport; steps: { name: string; args: Record<string, unknown> }[] } {
  const rig = buildRig(ctx.skeleton);
  const findings: Finding[] = [];
  const steps: { name: string; args: Record<string, unknown> }[] = [];
  const metrics: Record<string, number> = {};
  let work = structuredClone(clip);

  // 1–2. кожа и пол — чинятся вместе: постановка на пол меняет позу ног, ослабление слоя — и кожу, и провал
  let s = skinBad(project, rig, m, work);
  let sink0 = sinkOf(project, rig, m, work);
  metrics.skin = +(s.bad * 100).toFixed(2);
  metrics.sink = +((sink0.d / m.H) * 100).toFixed(2);
  const skinF: Finding | null = s.bad > LIMITS.skinBad
    ? { check: "skin", level: "fail", msg: `кожа рвётся: ${(s.bad * 100).toFixed(1)} % рёбер растянуто больше чем в ${LIMITS.skinTol} раза (хуже всего у ${m.dom[s.worstVertex] ?? "?"}, ×${s.worst.toFixed(0)})`, t: +s.t.toFixed(2), value: metrics.skin }
    : null;
  const floorF: Finding | null = sink0.d > LIMITS.floor * m.H ? { check: "floor", level: "fail", msg: `уходит в пол на ${metrics.sink} % роста`, t: +sink0.t.toFixed(2), value: metrics.sink } : null;
  if (fix && (skinF || floorF)) {
    const feet = footBones(project, ctx);
    // сначала устройство, потом сила: стопы на пол и плоско — это не меняет характер движения, ослабление — меняет
    if (floorF && feet.length && (!work.ground || !work.ground.flat || !work.ground.ik)) {
      const bones = work.ground?.bones.length ? work.ground.bones : feet;
      work.ground = { bones, mode: work.ground?.mode ?? "floor", ik: true, flat: true };
      steps.push({ name: "clip.ground", args: { clip: clip.name, bones: bones.join(","), mode: work.ground.mode, ik: true, flat: true } });
    }
    // жадно: на каждом шаге ослабляем на 30 % тот слой, после которого меньше всего плохого. Два этапа:
    // разрыв кожи недопустим — ради него слой можно гасить до нуля (главный — до 0,35); провал в пол на пару
    // процентов — меньшее зло, чем потерять характер походки, поэтому ради пола — не ниже 0,5
    const weight = (c: Clip, id: string) => ((c.layers.find((l) => l.id === id) as { weight?: number } | undefined)?.weight ?? 1);
    let ids = work.layers.filter((l) => l.type === "recipe").map((l) => l.id);
    const skinScore = (c: Clip, n = 17) => skinBad(project, rig, m, c, n).bad / LIMITS.skinBad;
    const floorScore = (c: Clip, n = 17) => Math.max(skinScore(c, n), sinkOf(project, rig, m, c, n).d / (LIMITS.floor * m.H));
    const greedy = (score: (c: Clip, n?: number) => number, lowest: (id: string) => number) => {
      let cur = score(work, 31);
      for (let it = 0; it < 30 && cur > 1; it++) {
        let best: { c: Clip; v: number } | null = null;
        for (const id of ids) {
          const w = weight(work, id), lo = lowest(id);
          if (w <= lo + 1e-3) continue;
          const c = structuredClone(work);
          (c.layers.find((l) => l.id === id) as { weight?: number }).weight = +Math.max(lo, w < 0.2 ? 0 : w * 0.7).toFixed(2);
          const v = score(c);
          if (!best || v < best.v) best = { c, v };
        }
        if (!best || best.v >= cur - 1e-3) break;
        work = best.c;
        cur = score(work, 31);
      }
    };
    if (skinF) greedy(skinScore, (id) => (isMainLayer(work, id) ? 0.35 : 0));
    let swapped: string | null = null;
    if (skinF) {
      const r = ramSwap(project, clip, work, (c) => skinScore(c, 31));
      if (r) {
        work = r.work;
        swapped = r.preset;
        ids = work.layers.filter((l) => l.type === "recipe").map((l) => l.id);
        steps.push(...r.steps);
        greedy(skinScore, (id) => (id === "pelvis_body-ram" ? 0.5 : 0));
      }
    }
    if (floorF) greedy(floorScore, (id) => Math.min(weight(work, id), Math.max(0.5, isMainLayer(work, id) ? 0.5 : 0)));
    const changed = ids.filter((id) => weight(work, id) !== weight(clip, id) && !(swapped && id === "pelvis_body-ram" && weight(work, id) === 1));
    for (const id of changed) steps.push({ name: "layer.set", args: { clip: clip.name, layer: id, weight: weight(work, id) } });
    s = skinBad(project, rig, m, work);
    const sink1 = sinkOf(project, rig, m, work);
    metrics.skinAfter = +(s.bad * 100).toFixed(2);
    metrics.sinkAfter = +((sink1.d / m.H) * 100).toFixed(2);
    const what = [swapped ? `удар рукой рвёт кожу при любой силе — заменён тараном корпусом (body-ram, ${swapped})` : "", work.ground && JSON.stringify(work.ground) !== JSON.stringify(clip.ground) ? "ступни на пол (IK, опорная стопа плоско)" : "", changed.length ? `ослаблены слои: ${changed.map((id) => `${id} ×${weight(work, id)}`).join(", ")}` : ""].filter(Boolean).join("; ");
    if (skinF) {
      skinF.fixed = `${what} → рвётся ${metrics.skinAfter} %`;
      if (s.bad <= LIMITS.skinBad) skinF.level = "warn";
      else skinF.msg += " — ослаблением слоёв не чинится: меш не даёт так двигаться (части слеплены, веса); нужна правка модели или другое движение";
    }
    if (floorF) {
      floorF.fixed = `${what} → провал ${metrics.sinkAfter} %`;
      if (sink1.d <= LIMITS.floor * m.H) floorF.level = "warn";
      else if (sink1.d <= 4 * LIMITS.floor * m.H) { floorF.level = "warn"; floorF.msg += " — остаток оставлен: дальше ослаблять — терять характер движения"; }
    }
  }
  if (skinF) findings.push(skinF);
  if (floorF) findings.push(floorF);

  // кадры кожи один раз: пол, парение, шов, рывки
  const n = frameCount(work);
  const frames: Float32Array[] = [];
  for (let k = 0; k <= n; k++) frames.push(skinFrame(m.sc, posePartsAt(project, rig, work, Math.min(work.duration, (work.duration * k) / n))));
  const low = frames.map((f) => { let z = Infinity; for (let i = 2; i < f.length; i += 3) z = Math.min(z, f[i]); return z - m.floor; });

  const isGait = work.layers.some((l) => l.type === "recipe" && /walk|step|gait/.test(l.recipe));
  if (isGait && Math.min(...low) > LIMITS.float * m.H) findings.push({ check: "float", level: "warn", msg: `парит: ни в одном кадре не касается пола (зазор ${((Math.min(...low) / m.H) * 100).toFixed(1)} % роста)` });

  const dist = (a: Float32Array, b: Float32Array) => { let d = 0; for (let i = 0; i < a.length; i += 3) d = Math.max(d, Math.hypot(a[i] - b[i], a[i + 1] - b[i + 1], a[i + 2] - b[i + 2])); return d; };
  // 3. шов цикла: в момент duration зацикленный клип равен началу по определению — поэтому смотрим на позу за
  // миг до конца и через миг после начала. Непрерывное движение за 2ε почти не меняется (даже разворот стопы
  // галопа ровно на стыке), рваный шов — скачок. Сравниваем со сдвигом за те же 2ε внутри начала клипа
  if (work.loop) {
    const at = (t: number) => skinFrame(m.sc, posePartsAt(project, rig, work, t));
    const eps = Math.min(1e-3, work.duration / 1000);
    const jump = dist(at(work.duration - eps), at(eps));
    const inside = dist(at(eps), at(3 * eps));
    metrics.seam = +((jump / m.H) * 100).toFixed(2);
    if (jump > LIMITS.seam * m.H && jump > 10 * inside) {
      let wv = -1, w = 0;
      const p = at(work.duration - eps), q = at(eps);
      for (let i = 0; i < p.length; i += 3) { const d = Math.hypot(p[i] - q[i], p[i + 1] - q[i + 1], p[i + 2] - q[i + 2]); if (d > w) { w = d; wv = i / 3; } }
      findings.push({ check: "seam", level: "fail", msg: `рваный шов цикла: конец не сходится с началом у ${m.dom[wv] ?? "?"} на ${metrics.seam} % роста`, value: metrics.seam });
    }
  }

  // 4. рывки: скачок за кадр сильно больше обычного для этого клипа
  const step = frames.slice(1).map((f, k) => dist(frames[k], f));
  const med = [...step].sort((a, b) => a - b)[Math.floor(step.length / 2)] || 1e-9;
  // удар — это и есть резкий кадр: рывки ±0,1 с от события hit не считаем
  const hits = clipEvents(work).filter((e) => e.name === "hit").map((e) => e.t);
  const tOf = (k: number) => (work.duration * (k + 1)) / n;
  const free = step.map((d, k) => (hits.some((h) => Math.abs(h - tOf(k)) < 0.1) ? 0 : d));
  const pk = free.indexOf(Math.max(...free));
  metrics.pop = +(step[pk] / med).toFixed(1);
  if (step[pk] > LIMITS.pop * med && step[pk] > LIMITS.popMin * m.H) findings.push({ check: "pop", level: "warn", msg: `рывок: за кадр сдвиг в ${metrics.pop} раза больше обычного`, t: +tOf(pk).toFixed(2), value: metrics.pop });

  // 5. пределы: кость долго упирается — анимация борется с анатомией
  if (project.limits && Object.keys(project.limits).length) {
    const hit = new Map<string, number>();
    for (let k = 0; k < n; k++) for (const b of motionAt(project, rig, work, (work.duration * k) / n).limited) hit.set(b, (hit.get(b) ?? 0) + 1);
    const long = [...hit].filter(([, c]) => c / n > LIMITS.limits).map(([b, c]) => `${b} ${Math.round((c / n) * 100)} %`);
    if (long.length) findings.push({ check: "limits", level: "warn", msg: `упирается в пределы: ${long.join(", ")} клипа` });
  }

  // 6. тайминг удара под роль (карточка стиля): у игрока удар быстрый, у врага замах читаемый
  const events = clipEvents(work);
  const hit = events.find((e) => e.name === "hit");
  const role = (project.style?.role ?? "").toLowerCase();
  if (hit && role) {
    if (/player|игрок/.test(role) && hit.t > 0.35) findings.push({ check: "timing", level: "warn", msg: `удар игрока приходит через ${hit.t.toFixed(2)} с — дольше 0,35 с ощущается вязко (быстрые стили Witcher 0,21–0,30 с)`, value: hit.t });
    if (/enemy|npc|враг/.test(role) && hit.t < 0.3) findings.push({ check: "timing", level: "warn", msg: `замах врага ${hit.t.toFixed(2)} с — короче 0,3 с игрок не успеет прочитать (NPC Witcher 0,31–1,2 с)`, value: hit.t });
  }

  // 6б. окно ввода: у удара открытие и закрытие в один миг — комбо не связать (у toolsup-hammer tail = 0; заметил критик)
  const wo = events.find((e) => e.name === "window_open"), wc = events.find((e) => e.name === "window_close");
  if (wo && wc && wc.t - wo.t < 0.05) {
    const f: Finding = { check: "timing", level: "warn", msg: `окно ввода нулевое (${wo.t.toFixed(2)}–${wc.t.toFixed(2)} с): следующий удар не связать` };
    const layers = work.layers.filter((l) => l.type === "recipe" && "tail" in RECIPES[l.recipe].params);
    if (fix && layers.length) {
      for (const l of layers) steps.push({ name: "recipe.set", args: { clip: clip.name, layer: l.id, params: { tail: 0.3 } } });
      steps.push({ name: "clip.set", args: { clip: clip.name, fit: true } });
      f.fixed = "окно 0,3 с (tail), клип удлинён до конца окна";
    }
    findings.push(f);
  }

  // 7. длина: разовый клип не должен обрезать свои события
  const last = Math.max(0, ...events.map((e) => e.t));
  const recipe = work.layers.find((l) => l.type === "recipe" && RECIPES[l.recipe]?.events);
  if (!work.loop && recipe && last > work.duration + 1e-3) findings.push({ check: "length", level: "fail", msg: `клип ${work.duration} с короче своих событий (последнее в ${last.toFixed(2)} с)` });

  return { report: { clip: clip.name, ok: !findings.some((f) => f.level === "fail"), findings, metrics }, steps };
}

/** Проверить клипы проекта (и починить, если fix): правки — командами ядра, потом проверка ещё раз — что осталось. */
export async function checkProject(dir: string, clips?: string[], fix = false, smooth: (dir: string) => Promise<{ changed: number; backup: string }> = smoothWeights): Promise<ClipReport[]> {
  let ctx = await loadCtx(dir);
  let m = await loadMesh(ctx);
  if (!m.sc.parts.length) throw new Error("в модели нет мешей — проверять нечего");
  const out: ClipReport[] = [];
  const list = ctx.project.clips.filter((c) => !clips || clips.includes(c.name));
  const rig = buildRig(ctx.skeleton);
  // веса — первыми: жёсткая граница кости-родителя и ребёнка открывает щель в сгибе (колено рабочего). Сгладили —
  // оставляем, только если рвётся меньше; иначе возвращаем исходник модели
  let weightsNote: Finding | null = null;
  if (fix) {
    const tear = (mm: Mesh) => list.reduce((a, c) => a + skinBad(ctx.project, rig, mm, c, 17).bad, 0);
    const before = tear(m);
    // пробуем и без брака: у пекаря сглаживание сняло половину растяжения в ходьбе (0,24 → 0,13 %), хотя порог не был превышен
    if (before > 0 && !existsSync(join(dir, ctx.project.model).replace(/\.glb$/, ".orig.glb"))) {
      const file = join(dir, ctx.project.model);
      const keep = readFileSync(file);
      const r = await smooth(dir);
      const m2 = await loadMesh(ctx);
      const after = tear(m2);
      if (after < before * 0.7) {
        m = m2;
        weightsNote = { check: "skin", level: "warn", msg: `веса сглажены у суставов (${r.changed} вершин): рвалось ${(before * 100).toFixed(1)}, стало ${(after * 100).toFixed(1)} (сумма % по клипам)`, fixed: `weights.smooth, исходник — ${r.backup}` };
      } else {
        // не помогло — модель как была и без *.orig.glb: «исходник» должен значить «до правок», а правок не было
        writeFileSync(file, keep);
        rmSync(r.backup, { force: true });
      }
    }
  }
  for (const clip of list) {
    const { report, steps } = checkClip(ctx.project, ctx, m, clip, fix);
    if (weightsNote) report.findings.unshift(weightsNote);
    if (fix && steps.length) {
      for (const st of steps) await call(dir, st.name, st.args);
      ctx = await loadCtx(dir);
      // после починки — заново: пол мог сдвинуть кожу, ослабленный слой — убрать рывок
      const again = checkClip(ctx.project, ctx, m, ctx.project.clips.find((c) => c.name === clip.name)!, false).report;
      const fixed = report.findings.filter((f) => f.fixed);
      // находки после починки, но с пометкой, что и как чинили
      // уровень — как решила починка (остаток провала в пол «ради характера» — предупреждение, а не брак)
      const findings = [...fixed, ...again.findings.filter((g) => !fixed.some((f) => f.check === g.check))];
      out.push({ ...again, ok: !findings.some((f) => f.level === "fail"), findings });
    } else out.push(report);
  }
  return out;
}

/** Слой, без которого клип теряет смысл: рука в ударе, ноги в ходьбе, тело у рыбы. */
function isMainLayer(clip: Clip, id: string) {
  const l = clip.layers.find((x) => x.id === id);
  if (!l || l.type !== "recipe") return false;
  const ch = l.target.chain;
  if (/strike|charge/.test(l.recipe)) return /^arm_|^body|^tail/.test(ch);
  if (/walk|step|gait/.test(l.recipe)) return /^leg_|^arm_l0|^arm_r0/.test(ch);
  return clip.layers.filter((x) => x.type === "recipe").length === 1;
}

/** Стопы для постановки на пол: кость сразу под концом цепочки ноги (у CC-скелета цепочка — бедро и голень,
 * стопа — её ребёнок), иначе — конец цепочки. */
export function footBones(project: Project, ctx: Ctx): string[] {
  const rig = buildRig(ctx.skeleton);
  return (["leg_l", "leg_r"] as const).flatMap((c) => {
    const end = project.chains[c]?.at(-1);
    if (!end) return [];
    const i = rig.index.get(end)!;
    const kid = ctx.skeleton.nodes.findIndex((n, k) => n.isJoint && rig.parent[k] === i);
    return [kid >= 0 ? ctx.skeleton.nodes[kid].name : end];
  });
}

/** Удар рукой рвёт кожу и на силе 0,35 — рука слеплена с телом (колобок-пекарь). Тогда бьёт всё тело: таран корпусом
 * (body-ram, пресет по роли из карточки стиля), остальные слои клипа — как были. Так пять кругов с критиком на
 * пекаре закончились «принято». score — «насколько рвётся» (> 1 — брак); замена — только если с ней меньше. */
export function ramSwap(project: Project, clip: Clip, work: Clip, score: (c: Clip) => number) {
  const strikes = work.layers.filter((l) => l.type === "recipe" && /^(melee-strike|charge-release)$/.test(l.recipe));
  if (!strikes.length || !project.chains.pelvis) return null;
  const now = score(work);
  if (now <= 1) return null;
  // виновата ли рука: без неё кожа цела. Иначе рвётся другое (колено с жёсткими весами) — таран не поможет по делу
  const armless = structuredClone(work);
  for (const l of armless.layers) if (l.type === "recipe" && strikes.some((x) => x.id === l.id) && /^arm_/.test(l.target.chain)) l.weight = 0;
  if (score(armless) > 1) return null;
  const name = /player|игрок/.test(project.style?.role ?? "") ? "ram-player" : "ram-npc";
  const preset = findPreset(name).preset;
  const ram = structuredClone(clip);
  ram.layers = ram.layers.filter((l) => !strikes.some((x) => x.id === l.id));
  ram.layers.push({ id: "pelvis_body-ram", type: "recipe", recipe: "body-ram", target: { chain: "pelvis" }, params: { ...(preset.params as Record<string, number>) }, preset: name });
  ram.duration = RECIPES["body-ram"].length!(withDefaults(RECIPES["body-ram"], preset.params));
  ram.ground = work.ground;
  if (score(ram) >= now) return null;
  return {
    work: ram,
    preset: name,
    steps: [
      { name: "layer.remove", args: { clip: clip.name, layer: strikes.map((x) => x.id).join(",") } },
      { name: "recipe.add", args: { clip: clip.name, recipe: "body-ram", chain: "pelvis", id: "pelvis_body-ram", params: preset.params, preset: name } },
      { name: "clip.set", args: { clip: clip.name, duration: ram.duration } },
    ],
  };
}
