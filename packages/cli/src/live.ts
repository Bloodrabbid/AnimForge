// Живые рецепты в Godot: данные для аддона (<имя>.af.json рядом с glb) и сверка позы Godot с ядром.
// Аддон считает позу сам (godot/sandbox/addons/animforge/live/af_core.gd — копия evaluate.ts), поэтому ему нужен
// скелет в позе покоя, цепочки, пределы, клипы со слоями и схемы параметров рецептов.
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RECIPES, buildRig, posePartsAt, type Clip, type Ctx } from "../../core/src/index.ts";
import { GODOT, ROOT, loadCtx } from "./node.ts";

export function liveData(ctx: Ctx) {
  const p = ctx.project;
  return {
    version: 1,
    name: p.name,
    project: { up: p.up, forward: p.forward ?? null, chains: p.chains, align: p.align ?? null, limits: p.limits ?? null },
    skeleton: { nodes: ctx.skeleton.nodes.map((n) => ({ name: n.name, parent: n.parent, restT: n.restT, restR: n.restR, restS: n.restS, isJoint: n.isJoint })) },
    clips: p.clips,
    // схемы параметров: по ним аддон подставляет значения по умолчанию и рисует ручки в инспекторе
    recipes: Object.fromEntries(Object.entries(RECIPES).map(([k, d]) => [k, { params: d.params, main: d.main ?? [], help: d.help }])),
  };
}

/** Классы аддона (AFCore, AFRecipes…) Godot находит по кэшу .godot/global_script_class_cache.cfg — его пишет
 * редактор при первом открытии проекта. В свежей копии репозитория кэша нет: открываем редактор без окна один раз. */
export function ensureImported(project = join(ROOT, "godot/sandbox")) {
  if (existsSync(join(project, ".godot/global_script_class_cache.cfg"))) return;
  execFileSync(GODOT, ["--headless", "--path", project, "--editor", "--quit"], { stdio: "ignore", timeout: 180_000 });
}

/** Клип, где есть всё, чего нет в демо: ключи всех видов (сдвиг, масштаб, ступенька, прямая), слой поз, IK руки
 * с пределами (подбор с шарниром) и без, длинная IK, взгляд на движущуюся цель, зеркальная копия поворота,
 * пол contact с плоской стопой. */
export const SYNTHETIC: Clip = {
  name: "synthetic", duration: 1.2, fps: 30, loop: true,
  layers: [
    { id: "w", type: "recipe", recipe: "waddle-walk", target: { chain: "pelvis" }, params: { role: "pelvis" }, weight: 0.8 },
    { id: "k", type: "keys", tracks: [
      { bone: "chest", axis: "scale_up", keys: [{ t: 0, v: 0 }, { t: 0.6, v: 0.15 }, { t: 1.2, v: 0 }] },
      { bone: "pelvis", axis: "move_forward", keys: [{ t: 0, v: 0, interp: "linear" }, { t: 0.5, v: 0.05, interp: "step" }, { t: 1, v: -0.03 }] },
      { bone: "ear_r_0", axis: "vertical", keys: [{ t: 0, v: 0 }, { t: 0.3, v: 25 }, { t: 0.7, v: -10 }, { t: 1.1, v: 5 }] },
    ] },
    { id: "pose", type: "pose", keys: [
      { t: 0.2, rot: { head: [0.08, 0, 0, 0.9968] }, move: { root: [0, 0.02, 0] } },
      { t: 0.9, rot: { head: [0, 0.1, 0, 0.995], chest: [0, 0, 0.05, 0.9987] }, interp: "linear" },
    ] },
  ],
  ground: { bones: ["foot_l", "foot_r"], mode: "contact", ik: true, flat: true },
  constraints: [
    { id: "ikr", type: "ik", tip: "arm_r_1", end: true, length: 2, target: { keys: [{ t: 0, pos: [-0.3, 0.9, 0.3] }, { t: 0.6, pos: [-0.2, 1.3, 0.2] }, { t: 1.2, pos: [-0.3, 0.9, 0.3] }] } },
    { id: "ikl", type: "ik", tip: "arm_l_1", end: true, length: 3, weight: 0.7, target: { bone: "head", offset: [0.3, 0.1, 0.25] } },
    { id: "aim", type: "aim", bones: ["chest", "head"], weight: 0.8, target: { keys: [{ t: 0, pos: [1, 1.2, 2] }, { t: 1.2, pos: [-1, 1.5, 2] }] } },
    { id: "cp", type: "copy", bones: ["ear_l_0"], source: ["ear_r_0"], mirror: true, weight: 0.9 },
  ],
};

/** Моменты сверки: края, середина и точки между кадрами (живой рецепт считается в любой момент, не по кадрам). */
const checkTimes = (d: number) => [0, 0.013, 0.137, 0.29, 0.5, 0.731, 0.97, 1].map((u) => +(u * d).toFixed(6));

export async function liveVerify(dirs?: string[]) {
  const list = dirs?.length ? dirs : readdirSync(join(ROOT, "projects")).map((d) => join(ROOT, "projects", d)).filter((d) => existsSync(join(d, "animforge.json")));
  const cases = [];
  const ctxs = [];
  for (const dir of list) ctxs.push(await loadCtx(dir));
  // у демо нет констрейнов, слоя поз и выравнивания — проверяем их на рабочем синтетическим клипом
  const worker = ctxs.find((c) => c.project.name === "worker-demo");
  if (!dirs?.length && worker) {
    const syn = structuredClone(worker);
    syn.project.name = "worker-synthetic";
    syn.project.align = { arm_l: { to: "down", abduct: 8 } };
    syn.project.clips = [SYNTHETIC];
    ctxs.push(syn);
  }
  for (const ctx of ctxs) {
    const rig = buildRig(ctx.skeleton);
    const samples = ctx.project.clips.flatMap((clip) =>
      checkTimes(clip.duration).map((t) => {
        const pose = posePartsAt(ctx.project, rig, clip, t);
        return { clip: clip.name, t, rot: Object.fromEntries(pose.rot), pos: Object.fromEntries(pose.pos), scl: Object.fromEntries(pose.scl) };
      }),
    );
    cases.push({ name: ctx.project.name, data: liveData(ctx), samples });
  }
  ensureImported();
  const tmp = mkdtempSync(join(tmpdir(), "af-live-"));
  const file = join(tmp, "live.json");
  writeFileSync(file, JSON.stringify(cases));
  let log = "";
  try {
    log = execFileSync(GODOT, ["--headless", "--path", join(ROOT, "godot/sandbox"), "--script", "res://tests/live_verify.gd", "--", file], { encoding: "utf8", timeout: 300_000, stdio: ["ignore", "pipe", "pipe"], maxBuffer: 64 << 20 });
  } catch (e: any) {
    log = String(e.stdout ?? "") + String(e.stderr ?? "");
  }
  rmSync(tmp, { recursive: true, force: true });
  const lines = log.split("\n").filter((l) => /^(CLIP|LIVE_|ERROR|SCRIPT ERROR|Parse Error)|error/i.test(l.trim()));
  return { ok: lines.some((l) => l.includes("LIVE_OK")), projects: cases.map((c) => c.name), godot: lines };
}
