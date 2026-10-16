// Автопроверки клипов — то, что в студии ловят на дейлиз и что меряется числом (docs/review-criteria.md).
// Считаются по настоящей коже (skin.ts), а не по костям: «геометрия поплыла» видно только на вершинах.
// Что умеют — чинят сами (fix): рвущий кожу слой ослабляют, проваленный в пол клип ставят на пол.
// Пороги — «на глаз», кроме помеченных источником; каждый записан рядом с проверкой.
import { NodeIO } from "@gltf-transform/core";
import { join } from "node:path";
import { buildRig, clipEvents, gaitSlide, motionAt, posePartsAt, RECIPES, withDefaults, type Clip, type Ctx, type Project } from "../../core/src/index.ts";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { call, findPreset, loadCtx, smoothWeights } from "./node.ts";
import { advise, type Advice } from "./advice.ts";
import { heightOf, loadSkinScene, meshEdges, restVerts, skinFrame, stretchOf, type SkinScene } from "./skin.ts";

export interface Finding {
  check: "skin" | "floor" | "float" | "slide" | "seam" | "pop" | "limits" | "timing" | "length" | "license";
  level: "fail" | "warn";
  msg: string;
  t?: number;
  value?: number;
  fixed?: string;
  /** что поменять и что тогда станет — замерено пробой (advice.ts) */
  advice?: Advice[];
}

export interface ClipReport {
  clip: string;
  ok: boolean;
  findings: Finding[];
  metrics: Record<string, number>;
  /** отчёт словами: что происходит и в каких числах */
  text: string;
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
  slide: 0.05, // опорная стопа проезжает по полу за шаг больше 5 % роста (на глаз: у лучших пресетов 2–4 %)
  minSpeed: 0.15, // естественная скорость меньше 0,15 роста в секунду — топчется на месте (человек идёт ≈0,8, вразвалку у пресетов 0,3–0,8)
};

/** Скольжение стоп походки (gaitSlide ядра). Чинится у waddle-walk: фаза ног к тазу (legPhase) — у пресетов она
 * разная, единой верной нет; если мало — меньше рыскание таза (у коротких ног-тумб пекаря поворот таза возит стопы
 * по полу сильнее, чем мах ног) и шире мах ног. Перебор по сетке, мерка та же; шаг не должен выродиться в топтание
 * (стопа почти не едет назад — и скользить нечему, но в игре так не пойдёшь), кожа не должна стать хуже. */
function gaitCheck(project: Project, rig: ReturnType<typeof buildRig>, m: Mesh, work: Clip, name: string, fix: boolean, skin0: number, steps: { name: string; args: Record<string, unknown> }[], metrics: Record<string, number>): { finding: Finding; work: Clip } | null {
  const g = gaitSlide(project, rig, work);
  if (!g) return null;
  metrics.slide = +(g.mean * 100).toFixed(1);
  metrics.backward = +(g.backward * 100).toFixed(0);
  metrics.speed = +(g.speed / m.H).toFixed(2);
  const minSpeed = LIMITS.minSpeed * m.H;
  // «лунная»: естественная скорость — медиана скорости опоры назад; ≤ 0 — значит, назад едет не больше половины кадров
  const moon = g.speed <= 0;
  const shuffle = !moon && g.speed < minSpeed;
  if (!moon && !shuffle && g.mean <= LIMITS.slide) return null;
  const finding: Finding = moon
    ? { check: "slide", level: "fail", msg: `«лунная» походка: опорная стопа едет вперёд (назад — только ${metrics.backward} % кадров опоры); в игре ноги поедут по полу, подогнать шаг под скорость нечем`, value: metrics.backward }
    : shuffle
      ? { check: "slide", level: "warn", msg: `топчется на месте: опорная стопа почти не уезжает назад — шаг на ${metrics.speed} роста в секунду; в игре его придётся крутить в разы быстрее`, value: metrics.speed }
      : { check: "slide", level: "warn", msg: `ноги скользят: опорная стопа проезжает по полу ${metrics.slide} % роста за шаг (худший шаг ${(g.max * 100).toFixed(1)} %)`, value: metrics.slide };
  // сначала устройство: фиксация опорной стопы (ground.lock) снимает скольжение у любой походки, не трогая
  // характер; «лунную» и топтание она не чинит — там стопа в опоре едет не туда, это дело фазы ног
  if (fix && !moon && !shuffle && work.ground?.bones.length && !work.ground.lock) {
    const c = structuredClone(work);
    c.ground = { ...c.ground!, ik: true, lock: true };
    const after = gaitSlide(project, rig, c);
    if (after && after.mean <= LIMITS.slide && after.speed >= minSpeed && skinBad(project, rig, m, c, 17).bad <= Math.max(skin0, LIMITS.skinBad) && sinkOf(project, rig, m, c, 17).d <= Math.max(LIMITS.floor * m.H, sinkOf(project, rig, m, work, 17).d)) {
      steps.push({ name: "clip.ground", args: { clip: name, bones: c.ground!.bones.join(","), mode: c.ground!.mode, ik: true, ...(c.ground!.flat ? { flat: true } : {}), lock: true } });
      metrics.slideAfter = +(after.mean * 100).toFixed(1);
      metrics.speedAfter = +(after.speed / m.H).toFixed(2);
      finding.fixed = `опорная стопа зафиксирована (ground.lock) → скольжение ${metrics.slideAfter} % роста за шаг, шаг ${metrics.speedAfter} роста/с`;
      finding.level = "warn";
      return { finding, work: c };
    }
  }
  const layers = work.layers.filter((l) => l.type === "recipe" && l.recipe === "waddle-walk");
  if (!fix || !layers.length) return { finding, work };
  const p0 = withDefaults(RECIPES["waddle-walk"], (layers[0] as { params: Record<string, unknown> }).params);
  const score = (x: ReturnType<typeof gaitSlide>) => (!x || x.speed < minSpeed ? Infinity : x.mean + (x.backward < 0.8 ? 0.1 : 0));
  const variant = (phase: number, yawK: number, swingK: number) => {
    const c = structuredClone(work);
    for (const l of c.layers) if (l.type === "recipe" && l.recipe === "waddle-walk") l.params = { ...l.params, legPhase: phase, pelvisYaw: +(p0.pelvisYaw * yawK).toFixed(2), legSwing: +Math.min(60, p0.legSwing * swingK).toFixed(2) };
    return c;
  };
  let best = { c: work, sc: score(g), phase: Number(p0.legPhase), k: 1, sw: 1 };
  // сначала фаза (характер не меняется), потом меньше рыскания и шире мах — за каждую правку небольшая цена
  for (const sw of [1, 1.4, 1.8])
    for (const k of [1, 0.75, 0.5, 0.25])
      for (let phase = 0; phase < 360; phase += 30) {
        const c = variant(phase, k, sw);
        const sc = score(gaitSlide(project, rig, c)) + (1 - k) * 0.02 + (sw - 1) * 0.02;
        if (sc < best.sc - 1e-6 && skinBad(project, rig, m, c, 17).bad <= Math.max(skin0, LIMITS.skinBad)) best = { c, sc, phase, k, sw };
      }
  if (best.c === work) {
    finding.fixed = "фазой ног, поворотом таза и махом не чинится — нужен другой пресет походки";
    return { finding, work };
  }
  const params = { legPhase: best.phase, pelvisYaw: +(p0.pelvisYaw * best.k).toFixed(2), legSwing: +Math.min(60, p0.legSwing * best.sw).toFixed(2) };
  for (const l of layers) steps.push({ name: "recipe.set", args: { clip: name, layer: l.id, params } });
  const after = gaitSlide(project, rig, best.c)!;
  metrics.slideAfter = +(after.mean * 100).toFixed(1);
  metrics.speedAfter = +(after.speed / m.H).toFixed(2);
  finding.fixed = `фаза ног ${best.phase}°${best.k < 1 ? `, рыскание таза ×${best.k}` : ""}${best.sw > 1 ? `, мах ног ×${best.sw}` : ""} → скольжение ${metrics.slideAfter} % роста за шаг, шаг ${metrics.speedAfter} роста/с, назад ${(after.backward * 100).toFixed(0)} % опоры`;
  if (after.speed >= minSpeed && after.mean <= LIMITS.slide) finding.level = "warn";
  return { finding, work: best.c };
}

/** Модель для проверок: кожа, рёбра, поза привязки и рост. Загружается один раз на make. */
export async function loadMesh(ctx: Ctx & { dir: string }) {
  const sc = loadSkinScene(await new NodeIO().read(join(ctx.dir, ctx.project.model)));
  const rest = skinFrame(sc, { rot: new Map(), pos: new Map(), scl: new Map() });
  let floor = Infinity;
  for (let i = 2; i < rest.length; i += 3) floor = Math.min(floor, rest[i]);
  return { sc, rest, edges: meshEdges(sc), H: heightOf(rest), floor, dom: restVerts(sc).dom };
}
export type Mesh = Awaited<ReturnType<typeof loadMesh>>;

const frameCount = (clip: Clip) => Math.max(12, Math.min(90, Math.round(clip.duration * clip.fps)));

/** Худший кадр по коже. Кадров — простое число со сдвигом фазы: равномерные 8 кадров на ходьбу из четырёх шагов
 * попадают всегда в одни и те же фазы и пропускают разрыв (так и было: 8 кадров — 0,2 %, 12 — 4,5 %). */
/** Глубже всего под полом за клип (по вершинам кожи), в единицах модели; те же кадры со сдвигом фазы. */
export function sinkOf(project: Project, rig: ReturnType<typeof buildRig>, m: Mesh, clip: Clip, n = 31) {
  let d = 0, at = 0;
  for (let k = 0; k < n; k++) {
    const t = (clip.duration * (k + 0.37)) / n;
    const f = skinFrame(m.sc, posePartsAt(project, rig, clip, t));
    for (let i = 2; i < f.length; i += 3) if (m.floor - f[i] > d) { d = m.floor - f[i]; at = t; }
  }
  return { d, t: at };
}

export function skinBad(project: Project, rig: ReturnType<typeof buildRig>, m: Mesh, clip: Clip, n = 31) {
  let worst = { bad: 0, worst: 1, worstVertex: -1, t: 0 };
  for (let k = 0; k < n; k++) {
    const t = (clip.duration * (k + 0.37)) / n;
    const s = stretchOf(m.rest, skinFrame(m.sc, posePartsAt(project, rig, clip, t)), m.edges, 0.01 * m.H, LIMITS.skinTol);
    if (s.bad > worst.bad) worst = { ...s, t };
  }
  return worst;
}

/** Лицензия основы клипа (слои поз с source из clip.import): CC0, CMU и без source — молча. */
export function licenseFinding(clip: Clip): Finding | undefined {
  const src = clip.layers.flatMap((l) => (l.type === "pose" && l.source?.license && /^cc by/i.test(l.source.license) ? [l.source] : []));
  if (!src.length) return undefined;
  const who = [...new Set(src.map((x) => `${x.author ?? x.file} (${x.license})`))].join("; ");
  const nc = src.some((x) => /\bNC\b/i.test(x.license!));
  return {
    check: "license",
    level: "warn",
    msg: nc
      ? `основа клипа — запись под CC BY-NC: только некоммерческое, в игру на продажу нельзя; в титрах — ${who}, ссылка на лицензию и что данные изменены`
      : `основа клипа — запись под CC BY: в титрах игры — ${who}, ссылка на лицензию и что данные изменены`,
  };
}

/** Проверить клип. fix — разрешить чинить: возвращает и правки (команды), которые надо записать в проект. */
export function checkClip(project: Project, ctx: Ctx, m: Mesh, clip: Clip, fix: boolean, advice = true): { report: ClipReport; steps: { name: string; args: Record<string, unknown> }[] } {
  const rig = buildRig(ctx.skeleton);
  const findings: Finding[] = [];
  const steps: { name: string; args: Record<string, unknown> }[] = [];
  const metrics: Record<string, number> = {};
  let work = structuredClone(clip);

  // 0. происхождение: клип на основе чужой записи — CC BY требует авторов в титрах, CC BY-NC — ещё и не на продажу
  const lic = licenseFinding(clip);
  if (lic) findings.push(lic);

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

  // 2б. скольжение стоп: персонаж идёт в игре с естественной скоростью клипа — опорная стопа должна стоять
  const slideF = gaitCheck(project, rig, m, work, clip.name, fix, s.bad, steps, metrics);
  if (slideF) {
    findings.push(slideF.finding);
    work = slideF.work;
  }

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
    } else if (layers.length) f.advice = [{ text: "открыть окно на 0,3 с (tail) и удлинить клип до его конца", after: 0, steps: [...layers.map((l) => ({ name: "recipe.set", args: { clip: clip.name, layer: l.id, params: { tail: 0.3 } } })), { name: "clip.set", args: { clip: clip.name, fit: true } }] }];
    findings.push(f);
  }

  // 7. длина: разовый клип не должен обрезать свои события
  const last = Math.max(0, ...events.map((e) => e.t));
  const recipe = work.layers.find((l) => l.type === "recipe" && RECIPES[l.recipe]?.events);
  if (!work.loop && recipe && last > work.duration + 1e-3) findings.push({ check: "length", level: "fail", msg: `клип ${work.duration} с короче своих событий (последнее в ${last.toFixed(2)} с)` });

  // советы — к тому, что не починено: что поменять и что станет (пробой той же меркой)
  if (advice) for (const f of findings) if (!f.fixed) { const a = advise(project, ctx, rig, m, work, f); if (a.length) f.advice = a; }
  return { report: { clip: clip.name, ok: !findings.some((f) => f.level === "fail"), findings, metrics, text: describe(work, metrics, m, findings) }, steps };
}

/** Отчёт словами: что за клип и в каких числах — в единицах игры (м/с, мм), чтобы читалось без таблицы порогов. */
export function describe(clip: Clip, x: Record<string, number>, m: Mesh, findings: Finding[]): string {
  const mm = (pct: number) => `${Math.round((pct / 100) * m.H * 1000)} мм`;
  const parts = [`${clip.name}: ${clip.loop ? "цикл" : "разовый"} ${clip.duration.toFixed(2)} с`];
  if (x.speed !== undefined) parts.push(`идёт ${(x.speed * m.H).toFixed(2)} м/с (${x.speed} роста/с), опорная стопа проезжает ${x.slide} % роста (${mm(x.slide)}) за шаг`);
  parts.push(x.skin > LIMITS.skinBad * 100 ? `кожа рвётся у ${x.skin} % рёбер` : `кожа цела (растянуто ${x.skin} % рёбер)`);
  parts.push(x.sink > LIMITS.floor * 100 ? `уходит в пол на ${x.sink} % роста (${mm(x.sink)})` : `в пол не уходит (${mm(x.sink)})`);
  if (x.seam !== undefined) parts.push(`шов цикла ${x.seam} % роста`);
  const bad = findings.filter((f) => f.level === "fail").length, warn = findings.length - bad;
  parts.push(!findings.length ? "замечаний нет" : `${bad ? `брак: ${bad}` : ""}${bad && warn ? ", " : ""}${warn ? `предупреждений: ${warn}` : ""}`);
  return parts.join("; ") + ".";
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
    // советы — в последнем проходе: при починке их считает повторная проверка, без правок — эта
    const { report, steps } = checkClip(ctx.project, ctx, m, clip, fix, !fix);
    if (fix && !steps.length) for (const f of report.findings) if (!f.fixed) { const a = advise(ctx.project, ctx, rig, m, clip, f); if (a.length) f.advice = a; }
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
  // таз ведёт удар, голова (если есть) держится на линии удара — роли рецепта
  const parts = (["pelvis", "head"] as const).filter((r) => project.chains[r]);
  for (const r of parts) ram.layers.push({ id: `${r}_body-ram`, type: "recipe", recipe: "body-ram", target: { chain: r }, params: { ...(preset.params as Record<string, unknown>), role: r }, preset: name });
  ram.duration = RECIPES["body-ram"].length!(withDefaults(RECIPES["body-ram"], preset.params));
  ram.ground = work.ground;
  if (score(ram) >= now) return null;
  return {
    work: ram,
    preset: name,
    steps: [
      { name: "layer.remove", args: { clip: clip.name, layer: strikes.map((x) => x.id).join(",") } },
      ...parts.map((r) => ({ name: "recipe.add", args: { clip: clip.name, recipe: "body-ram", chain: r, id: `${r}_body-ram`, params: { ...preset.params, role: r }, preset: name } })),
      { name: "clip.set", args: { clip: clip.name, duration: ram.duration } },
    ],
  };
}
