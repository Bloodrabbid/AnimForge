// 8 направлений из одной прямой ходьбы: та же ходьба под углом к взгляду (стрейф, назад, диагонали). Как у
// ActionForge Motion Lab, но для любого тела с цепочками leg_* и с проверкой по замеру: плоскость маха подбирается
// так, чтобы тело на самом деле шло под нужным углом (таз в рецептах рыщет и кренится — это тоже возит стопы).
// Все направления — с той же фазы шага, что и прямая ходьба: в движке их смешивают (Godot BlendSpace2D) без рывка.
import type { Clip, Project, Travel } from "./project.ts";
import { RECIPES } from "./recipes.ts";
import { gaitHeading, gaitSlide, type Rig } from "./evaluate.ts";

/** Коэффициенты по углу хода θ (0 — вперёд, 90 — влево, 180 — назад), для θ ≥ 0; вправо — зеркально (hips, feet
 * со знаком минус). hips — таз к ходу, °; chest — доля, на которую грудь возвращает таз (плечи на цель); look — доля
 * остатка, которую возвращает голова; feet — куда смотрят стопы, °; width — отведение бедра наружу, °; stride — размах
 * маха к прямому шагу; cadence — период к прямому. Источник — DIRECTIONS_SOURCE. У ActionForge «шаг короче, частота
 * выше» — в Witcher не подтвердилось: ни в одном из 6 стрейфов период не меняется, укорачивается только шаг. */
export const DIRECTIONS: { angle: number; hips: number; chest: number; look: number; feet: number; width: number; stride: number; cadence: number }[] = [
  { angle: 0, hips: 0, chest: 0, look: 0.65, feet: 0, width: 0, stride: 1, cadence: 1 },
  // диагонали ни в одной выгрузке нет — на глаз, между 0 и 90
  { angle: 45, hips: 35, chest: 0.25, look: 0.65, feet: 34, width: 1, stride: 0.95, cadence: 1 },
  // Witcher, 6 клипов walkl/walkr (Геральт, cr_male, cr_female): таз 61° [31…74], грудь возвращает 0.24, голова
  // держит 16° из оставшихся 46 (look 0.65), стопы 0.76·θ, колея +6 см ≈ +2° отведения, период тот же, шаг ×0.9
  { angle: 90, hips: 61, chest: 0.24, look: 0.65, feet: 68, width: 2, stride: 0.9, cadence: 1 },
  // на глаз: таз к ходу 30°; стопы 15° — подобрано по скольжению на ходьбе April (стопы как таз, 30°: 5.0 % → 2.5 %)
  { angle: 135, hips: 30, chest: 0.25, look: 0.65, feet: 15, width: 1.5, stride: 0.9, cadence: 1 },
  // Witcher, 4 клипа назад: таз 0 [−8…+2], период ×0.99, шаг ×1.0; колея +1 см
  { angle: 180, hips: 0, chest: 0, look: 0.65, feet: 0, width: 0.3, stride: 1, cadence: 1 },
];
export const DIRECTIONS_SOURCE = "90° и 180° — The Witcher (2007), 10 клипов ходьбы вбок и назад, измерено (research/directions.md); 45° и 135° — на глаз, между ними";

/** Имена восьми направлений: суффикс клипа. */
export const DIRECTION_NAMES: Record<number, string> = { 0: "fwd", 45: "fwd_l", 90: "left", 135: "back_l", 180: "back", [-135]: "back_r", [-90]: "right", [-45]: "fwd_r" };

const wrap = (x: number) => ((((x + 180) % 360) + 360) % 360) - 180;

/** Коэффициенты для любого угла: линейно между строками таблицы, вправо — зеркально. */
export function directionAt(angle: number): Omit<(typeof DIRECTIONS)[number], "angle"> {
  const a = ((((angle + 180) % 360) + 360) % 360) - 180; // −180…180
  const s = a < 0 ? -1 : 1;
  const x = Math.abs(a);
  let k = DIRECTIONS.findIndex((d) => d.angle >= x);
  if (k <= 0) k = Math.max(1, k);
  const lo = DIRECTIONS[k - 1], hi = DIRECTIONS[k];
  const u = hi.angle === lo.angle ? 0 : (x - lo.angle) / (hi.angle - lo.angle);
  const mix = (p: "hips" | "chest" | "look" | "feet" | "width" | "stride" | "cadence") => lo[p] + (hi[p] - lo[p]) * u;
  return { hips: s * mix("hips"), chest: mix("chest"), look: mix("look"), feet: s * mix("feet"), width: mix("width"), stride: mix("stride"), cadence: mix("cadence") };
}

/** Ход под углом для клипа: face = aim — взгляд вперёд (стрейф), travel — всё тело поворачивается по ходу. */
export function travelFor(angle: number, face: "aim" | "travel" = "aim"): { travel: Travel; cadence: number } {
  if (face === "travel") return { travel: { angle, hips: angle, feet: angle, swing: angle }, cadence: 1 };
  const d = directionAt(angle);
  // назад и назад-вбок — прямая ходьба наоборот во времени, мах повёрнут от «назад» (180) к углу хода
  const back = Math.abs(wrap(angle)) > 90;
  return { travel: { angle, hips: d.hips, chest: d.chest, look: d.look, feet: d.feet, width: d.width, stride: d.stride, ...(back ? { reverse: true, swing: wrap(angle - 180) } : {}) }, cadence: d.cadence };
}

/** Подобрать плоскость маха так, чтобы тело шло точно под angle (замер gaitHeading, метод секущих). Без пола
 * (опоры нет) — плоскость маха равна углу. */
export function calibrateSwing(project: Project, rig: Rig, clip: Clip, tol = 0.5): number | undefined {
  const tr = clip.travel;
  if (!tr || !clip.ground?.bones.length) return undefined;
  const err = (sw: number) => wrap(gaitHeading(project, rig, { ...clip, travel: { ...tr, swing: sw } }) - tr.angle);
  const start = tr.swing ?? tr.angle;
  let s0 = start, e0 = err(s0);
  if (!Number.isFinite(e0)) return undefined;
  if (Math.abs(e0) < tol) return s0;
  // грубо: ±60° шагом 10° (секущие с места могут уйти — направление от плоскости маха зависит не линейно)
  for (let d = -60; d <= 60; d += 10) {
    const e = err(start + d);
    if (Number.isFinite(e) && Math.abs(e) < Math.abs(e0)) [s0, e0] = [start + d, e];
  }
  // точно: секущие от лучшей точки
  let s1 = s0 - e0, e1 = err(s1);
  for (let it = 0; it < 6 && Math.abs(e1) >= tol && Number.isFinite(e1); it++) {
    const s2 = Math.abs(e1 - e0) < 1e-9 ? s1 - e1 : s1 - (e1 * (s1 - s0)) / (e1 - e0);
    if (Math.abs(e1) < Math.abs(e0)) [s0, e0] = [s1, e1];
    s1 = s2;
    e1 = err(s1);
  }
  return Math.abs(e1) < Math.abs(e0) ? +s1.toFixed(2) : +s0.toFixed(2);
}

/** Клип под угол: копия прямой ходьбы с travel, период шагов ×cadence (и длина клипа с ним — петля остаётся петлёй). */
export function directionClip(project: Project, rig: Rig, base: Clip, angle: number, name: string, face: "aim" | "travel" = "aim"): Clip {
  const { travel, cadence } = travelFor(angle, face);
  const c: Clip = structuredClone(base);
  c.name = name;
  c.travel = travel;
  if (cadence !== 1) {
    for (const l of c.layers) if (l.type === "recipe" && RECIPES[l.recipe]?.params.period) l.params = { ...l.params, period: +(Number(l.params.period ?? RECIPES[l.recipe].params.period.default) * cadence).toFixed(4) };
    c.duration = +(c.duration * cadence).toFixed(4);
  }
  if (face !== "aim" || angle === 0) return c;
  const sw = calibrateSwing(project, rig, c);
  if (sw !== undefined) c.travel = { ...c.travel!, swing: sw };
  // назад-вбок: ходьба наоборот, повёрнутая к углу, или прямая, повёрнутая почти назад, — какая из двух меньше
  // возит стопы по полу, зависит от походки (у спокойной ходьбы April — первая, 2.5 % против 3.2; у Геральта
  // наоборот, 7.6 против 10.3); у чистого «назад» реверс всегда лучше (9.7 → 2.9 %)
  if (c.travel!.reverse && Math.abs(wrap(angle)) < 170 && c.ground?.bones.length) {
    const alt: Clip = { ...c, travel: { ...c.travel!, reverse: undefined, swing: angle } };
    delete alt.travel!.reverse;
    const sw2 = calibrateSwing(project, rig, alt);
    if (sw2 !== undefined) alt.travel = { ...alt.travel!, swing: sw2 };
    if ((gaitSlide(project, rig, alt)?.mean ?? Infinity) < (gaitSlide(project, rig, c)?.mean ?? Infinity)) return alt;
  }
  return c;
}
