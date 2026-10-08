// Адаптеры под Node: файлы проекта, glb, библиотека пресетов, Blender. Используются CLI и MCP-сервером.
import { NodeIO } from "@gltf-transform/core";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { COMMANDS, Ctx, Project, RECIPES, TweenPreset, buildRig, emptyProject, frameTimes, posePartsAt, readSkeleton, runCommand, samplePreset, writeClips } from "../../core/src/index.ts";

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
export const GODOT = process.env.GODOT ?? "/Applications/Godot.app/Contents/MacOS/Godot";
export const BLENDER = process.env.BLENDER ?? "/Applications/Blender.app/Contents/MacOS/Blender";
const io = new NodeIO();

export const projectFile = (dir: string) => join(dir, "animforge.json");

export async function loadCtx(dir: string): Promise<Ctx & { dir: string }> {
  const project: Project = JSON.parse(readFileSync(projectFile(dir), "utf8"));
  const doc = await io.read(join(dir, project.model));
  return { project, skeleton: readSkeleton(doc), dir };
}

export function saveProject(dir: string, p: Project) {
  writeFileSync(projectFile(dir), JSON.stringify(p, null, 2) + "\n");
}

interface Preset {
  name: string;
  help: string;
  params: Record<string, unknown>;
  provenance: unknown[];
}

export function loadPresets(): { recipe: string; presets: Preset[] }[] {
  const d = join(ROOT, "library/presets");
  return readdirSync(d).filter((f) => f.endsWith(".json")).map((f) => JSON.parse(readFileSync(join(d, f), "utf8")));
}

export function findPreset(name: string) {
  for (const lib of loadPresets()) {
    const p = lib.presets.find((p) => p.name === name);
    if (p) return { recipe: lib.recipe, preset: p };
  }
  throw new Error(`нет пресета «${name}». Есть: ${loadPresets().flatMap((l) => l.presets.map((p) => p.name)).join(", ")}`);
}

/** Запекает все клипы в glb. Рядом кладёт <out>.samples.json — эталонные повороты для проверки в Godot. */
export async function exportGlb(ctx: Ctx & { dir: string }, out: string) {
  const doc = await io.read(join(ctx.dir, ctx.project.model));
  const rig = buildRig(ctx.skeleton);
  const report = writeClips(doc, ctx.project, rig);
  mkdirSync(dirname(out), { recursive: true });
  await io.write(out, doc);
  const samples = ctx.project.clips.map((clip) => ({
    clip: clip.name,
    duration: clip.duration,
    checks: [0.13, 0.37, 0.71].map((u) => {
      // момент ровно на запечённом кадре: сверяем экспорт, а не точность линейной интерполяции между кадрами
      const times = frameTimes(clip);
      const t = times[Math.round(u * (times.length - 1))];
      const pose = posePartsAt(ctx.project, rig, clip, t);
      return { t, rotations: Object.fromEntries(pose.rot), positions: Object.fromEntries(pose.pos), scales: Object.fromEntries(pose.scl) };
    }),
  }));
  writeFileSync(out.replace(/\.glb$/, ".samples.json"), JSON.stringify(samples.filter((s) => report.find((r) => r.clip === s.clip)!.bones > 0), null, 1));
  const empty = report.filter((r) => r.bones === 0).map((r) => r.clip);
  return { out, clips: report, ...(empty.length ? { warning: `пустые клипы не записаны (нет слоёв, двигающих кости): ${empty.join(", ")}` } : {}) };
}

/** «Глаза»: рендер клипа в Blender → лист кадров PNG. */
function renderFrames(glb: string, clip: string, dir: string, frames: number, view: string, dist = 3.4, size: [number, number] = [480, 300]) {
  const log = execFileSync(BLENDER, ["-b", "--python", join(ROOT, "bridge/blender/render_sheet.py"), "--", glb, clip, dir, String(frames), view, String(dist), String(size[0]), String(size[1])], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 64 << 20 });
  if (!log.includes("SHEET_OK")) throw new Error("Blender не отрендерил кадры:\n" + log.split("\n").filter((l) => /SHEET|Error|Traceback/.test(l)).join("\n"));
  return readdirSync(dir).filter((f) => f.endsWith(".png")).sort().map((f) => join(dir, f));
}

/** Видео клипа: один проход рендерится в Blender, ffmpeg повторяет его loops раз. */
export async function renderVideo(ctx: Ctx & { dir: string }, clipName: string, view: string, loops: number, dist: number, out: string) {
  const clip = ctx.project.clips.find((c) => c.name === clipName);
  if (!clip) throw new Error(`нет клипа «${clipName}»`);
  const tmp = mkdtempSync(join(tmpdir(), "af-video-"));
  try {
    const glb = join(tmp, "clip.glb");
    await exportGlb(ctx, glb);
    const n = Math.max(2, Math.round(clip.duration * clip.fps));
    renderFrames(glb, clipName, tmp, n, view, dist, [720, 720]);
    mkdirSync(dirname(out), { recursive: true });
    execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-stream_loop", String(Math.max(0, loops - 1)), "-framerate", String(n / clip.duration), "-i", join(tmp, "f_%03d.png"), "-pix_fmt", "yuv420p", "-vf", "scale=720:720", out]);
    return { out, frames: n, loops, seconds: +(clip.duration * loops).toFixed(2) };
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

export async function renderSheet(ctx: Ctx & { dir: string }, clip: string, frames: number, view: string, out: string, dist = 3.4) {
  const tmp = mkdtempSync(join(tmpdir(), "af-sheet-"));
  try {
    const glb = join(tmp, "clip.glb");
    await exportGlb(ctx, glb);
    const pngs = renderFrames(glb, clip, tmp, frames, view, dist);
    mkdirSync(dirname(out), { recursive: true });
    const cols = Math.min(4, pngs.length);
    // ряды по cols кадров: ( a b c d +append ) ( e f g h +append ) -append — без шрифтов, в отличие от montage
    const rows: string[] = [];
    for (let i = 0; i < pngs.length; i += cols) rows.push("(", ...pngs.slice(i, i + cols), "-bordercolor", "#c4c8cf", "-border", "1", "+append", ")");
    execFileSync("magick", [...rows, "-append", out]);
    return { out, frames: pngs.length, view };
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

/** Шаблон тела через Blender: меш + кости + автоматические веса. */
export function makeTemplate(type: string, out: string, bones?: number) {
  const script = join(ROOT, `bridge/blender/template_${type}.py`);
  if (!existsSync(script)) throw new Error(`нет шаблона «${type}»`);
  mkdirSync(dirname(out), { recursive: true });
  const log = execFileSync(BLENDER, ["-b", "--python", script, "--", out, ...(bones ? [String(bones)] : [])], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  const ok = log.split("\n").find((l) => l.includes("_OK"));
  if (!ok) throw new Error("шаблон не собрался");
  return { out, log: ok };
}

/** Команды адаптера (файлы, Blender) — того же вида, что и команды ядра, чтобы CLI и MCP видели единый список. */

const TWEEN_LIB = () => join(ROOT, "library/tweens");
const ADDON_PRESETS = () => join(ROOT, "godot/sandbox/addons/animforge/presets");

export function loadTweens(): TweenPreset[] {
  return readdirSync(TWEEN_LIB()).filter((f) => f.endsWith(".json")).flatMap((f) => JSON.parse(readFileSync(join(TWEEN_LIB(), f), "utf8")).presets);
}

export function findTween(name: string): TweenPreset {
  const all = loadTweens();
  const p = all.find((p) => p.name === name);
  if (!p) throw new Error(`нет твина «${name}». Есть: ${all.map((p) => p.name).join(", ")}`);
  return p;
}

/** Копирует библиотеку твинов в аддон Godot (аддон читает только свою папку presets). */
export function syncTweens() {
  mkdirSync(ADDON_PRESETS(), { recursive: true });
  const files = readdirSync(TWEEN_LIB()).filter((f) => f.endsWith(".json"));
  for (const f of files) writeFileSync(join(ADDON_PRESETS(), f), readFileSync(join(TWEEN_LIB(), f)));
  return { copied: files, to: ADDON_PRESETS() };
}

const sampleTimes = (p: TweenPreset, n: number) => Array.from({ length: n + 1 }, (_, i) => (p.duration * i) / n);

/** Глаза агента для твинов: график всех свойств пресета во времени, PNG. */
export function plotTween(p: TweenPreset, out: string) {
  const W = 640, H = 400, pad = 40, N = 240;
  const ts = sampleTimes(p, N);
  const rows = ts.map((t) => samplePreset(p, t));
  const keys = [...new Set(rows.flatMap((r) => Object.keys(r)))];
  const colors = ["#e4572e", "#29335c", "#f3a712", "#669bbc", "#4c956c", "#a8201a", "#7b2cbf"];
  const top = 24 + 18 * keys.length; // легенда над графиком, а не поверх кривых
  const lines: string[] = [];
  keys.forEach((k, ci) => {
    const vs = rows.map((r) => r[k] ?? 0);
    let lo = Math.min(...vs), hi = Math.max(...vs);
    if (hi - lo < 1e-9) { lo -= 1; hi += 1; }
    const pts = vs.map((v, i) => `${(pad + ((W - 2 * pad) * i) / N).toFixed(1)},${(H - pad - ((H - pad - top) * (v - lo)) / (hi - lo)).toFixed(1)}`).join(" ");
    lines.push(`<polyline fill="none" stroke="${colors[ci % colors.length]}" stroke-width="2.5" points="${pts}"/>`);
    lines.push(`<text x="${pad + 8}" y="${20 + ci * 18}" font-size="14" fill="${colors[ci % colors.length]}">${k}: ${lo.toFixed(2)}…${hi.toFixed(2)}</text>`);
  });
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" font-family="Helvetica, Arial, sans-serif"><rect width="100%" height="100%" fill="#fbf8f2"/>
<line x1="${pad}" y1="${H - pad}" x2="${W - pad}" y2="${H - pad}" stroke="#999"/><line x1="${pad}" y1="${top}" x2="${pad}" y2="${H - pad}" stroke="#999"/>
<text x="${W - pad}" y="${H - 12}" font-size="13" text-anchor="end" fill="#555">${p.name} · ${p.duration} с${p.loop ? " · цикл" : ""} (каждая кривая в своём масштабе)</text>
${lines.join("\n")}</svg>`;
  mkdirSync(dirname(out), { recursive: true });
  const svgPath = out.replace(/\.png$/, ".svg");
  writeFileSync(svgPath, svg);
  execFileSync("rsvg-convert", [svgPath, "-o", out]);
  return { png: out, props: keys };
}

export const NODE_COMMANDS: Record<string, { help: string; args: Record<string, { type: string; required?: boolean; help: string }>; run(dir: string, a: Record<string, any>): Promise<unknown> }> = {
  init: {
    help: "Создать проект в папке: модель (glb) копируется не будет — указывается путь относительно папки.",
    args: { model: { type: "string", required: true, help: "путь к glb относительно папки проекта" }, name: { type: "string", help: "имя проекта" } },
    async run(dir, a) {
      if (existsSync(projectFile(dir))) throw new Error("проект уже есть");
      const p = emptyProject(a.name ?? dir.split("/").pop(), a.model);
      saveProject(dir, p);
      return p;
    },
  },
  "template.make": {
    help: "Собрать модель по шаблону тела в Blender: fish, snake, tentacle, quadruped, biped, worker.",
    args: { type: { type: "string", required: true, help: "fish | snake | tentacle | quadruped | biped | worker" }, out: { type: "string", required: true, help: "куда положить glb" }, bones: { type: "number", help: "число костей тела (по умолчанию — своё у каждого шаблона)" } },
    run: async (dir, a) => makeTemplate(a.type, resolve(dir, a.out), a.bones),
  },
  "preset.list": {
    help: "Пресеты библиотеки с происхождением параметров.",
    args: {},
    run: async () => loadPresets().map((l) => ({ recipe: l.recipe, presets: l.presets.map((p) => ({ name: p.name, help: p.help, params: p.params })) })),
  },
  "preset.apply": {
    help: "Добавить рецепт из пресета на цепочку (или переписать параметры существующего слоя, если указан layer).",
    args: {
      clip: { type: "string", required: true, help: "клип" },
      preset: { type: "string", required: true, help: "имя пресета" },
      chain: { type: "string", help: "цепочка (для нового слоя)" },
      layer: { type: "string", help: "id существующего слоя" },
      id: { type: "string", help: "id нового слоя (если на клипе уже есть слой того же рецепта)" },
    },
    async run(dir, a) {
      const { recipe, preset } = findPreset(a.preset);
      const ctx = await loadCtx(dir);
      const r = a.layer
        ? runCommand(ctx, "recipe.set", { clip: a.clip, layer: a.layer, params: preset.params })
        : runCommand(ctx, "recipe.add", { clip: a.clip, recipe, chain: a.chain, params: { ...preset.params }, preset: preset.name, id: a.id ?? recipe });
      if (a.layer) {
        const l = ctx.project.clips.find((c) => c.name === a.clip)!.layers.find((l) => l.id === a.layer);
        if (l && l.type === "recipe") l.preset = preset.name;
      }
      saveProject(dir, ctx.project);
      const clip = ctx.project.clips.find((c) => c.name === a.clip)!;
      const period = Number(preset.params.period);
      const cycles = clip.duration / period;
      return { layer: r, warning: clip.loop && period && Math.abs(cycles - Math.round(cycles)) > 1e-3 ? `длительность ${clip.duration} с не кратна периоду ${period} с — стык цикла будет рваным` : undefined };
    },
  },
  export: {
    help: "Запечь все клипы в glb (+ .samples.json для проверки в Godot).",
    args: { out: { type: "string", required: true, help: "путь к glb" } },
    run: async (dir, a) => exportGlb(await loadCtx(dir), resolve(dir, a.out)),
  },
  verify: {
    help: "Проверка в Godot без окна: экспорт → загрузка glb в Godot → сверка поворотов костей с ядром.",
    args: { out: { type: "string", help: "куда экспортировать glb, по умолчанию out/<имя>.glb" } },
    async run(dir, a) {
      const ctx = await loadCtx(dir);
      const glb = resolve(dir, a.out ?? `out/${ctx.project.name}.glb`);
      await exportGlb(ctx, glb);
      let log = "";
      try {
        log = execFileSync(GODOT, ["--headless", "--path", join(ROOT, "godot/verify"), "--script", "verify.gd", "--", glb, glb.replace(/\.glb$/, ".samples.json")], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
      } catch (e: any) {
        log = String(e.stdout ?? "") + String(e.stderr ?? "");
      }
      const lines = log.split("\n").filter((l) => /CLIP|VERIFY/.test(l));
      return { ok: lines.some((l) => l.includes("VERIFY_OK")), godot: lines };
    },
  },
  "tweens.list": {
    help: "Пресеты твинов UI и камеры из library/tweens.",
    args: { target: { type: "string", help: "ui | camera" } },
    run: async (_d, a) => loadTweens().filter((p) => !a.target || p.target === a.target).map((p) => ({ name: p.name, target: p.target, duration: p.duration, loop: !!p.loop, help: p.help, props: p.tracks.map((t) => t.prop) })),
  },
  "tweens.sample": {
    help: "Значения свойств твина во времени (как их применит аддон Godot).",
    args: { preset: { type: "string", required: true, help: "имя твина" }, steps: { type: "number", help: "сколько отрезков, по умолчанию 10" } },
    run: async (_d, a) => { const p = findTween(a.preset); return sampleTimes(p, a.steps ?? 10).map((t) => ({ t: +t.toFixed(4), v: samplePreset(p, t) })); },
  },
  "tweens.plot": {
    help: "Глаза агента: график свойств твина во времени, PNG.",
    args: { preset: { type: "string", required: true, help: "имя твина" }, out: { type: "string", required: true, help: "png" } },
    run: async (dir, a) => plotTween(findTween(a.preset), resolve(dir, a.out)),
  },
  "tweens.sync": {
    help: "Скопировать библиотеку твинов в аддон Godot (godot/sandbox/addons/animforge/presets).",
    args: {},
    run: async () => syncTweens(),
  },
  "tweens.verify": {
    help: "Сверка аддона Godot с ядром: выборки всех твинов + живой Tween на Control, без окна.",
    args: {},
    async run() {
      const sync = syncTweens();
      const tmp = mkdtempSync(join(tmpdir(), "af-tw-"));
      const samples = Object.fromEntries(loadTweens().map((p) => [p.name, sampleTimes(p, 50).map((t) => ({ t, v: samplePreset(p, t) }))]));
      const file = join(tmp, "samples.json");
      writeFileSync(file, JSON.stringify(samples));
      let log = "";
      try {
        log = execFileSync(GODOT, ["--headless", "--path", join(ROOT, "godot/sandbox"), "--script", "res://tests/tweens_verify.gd", "--", file], { encoding: "utf8", timeout: 90_000, stdio: ["ignore", "pipe", "pipe"] });
      } catch (e: any) {
        log = String(e.stdout ?? "") + String(e.stderr ?? "");
      }
      rmSync(tmp, { recursive: true, force: true });
      const lines = log.split("\n").filter((l) => /SAMPLES|LIVE|TWEENS|ERROR|error/.test(l));
      return { ok: lines.some((l) => l.includes("TWEENS_OK")), presets: Object.keys(samples).length, synced: sync.copied, godot: lines };
    },
  },
  sheet: {
    help: "Глаза агента: отрендерить клип в лист кадров PNG через Blender.",
    args: {
      clip: { type: "string", required: true, help: "клип" },
      out: { type: "string", required: true, help: "png" },
      frames: { type: "number", help: "сколько кадров, по умолчанию 8" },
      view: { type: "string", help: "side | top | three_quarter (по умолчанию) — тела вдоль X; front | profile | front_3q — персонажи" },
      dist: { type: "number", help: "отдаление камеры в радиусах модели, по умолчанию 3.4" },
    },
    run: async (dir, a) => renderSheet(await loadCtx(dir), a.clip, a.frames ?? 8, a.view ?? "three_quarter", resolve(dir, a.out), a.dist ?? 3.4),
  },
  video: {
    help: "Видео клипа (mp4, 720×720) через Blender + ffmpeg: один проход, повторённый loops раз.",
    args: {
      clip: { type: "string", required: true, help: "клип" },
      out: { type: "string", required: true, help: "mp4" },
      view: { type: "string", help: "как у sheet, по умолчанию three_quarter" },
      loops: { type: "number", help: "сколько раз повторить, по умолчанию 4" },
      dist: { type: "number", help: "отдаление камеры, по умолчанию 2.6" },
    },
    run: async (dir, a) => renderVideo(await loadCtx(dir), a.clip, a.view ?? "three_quarter", a.loops ?? 4, a.dist ?? 2.6, resolve(dir, a.out)),
  },
};

/** Единая точка вызова любой команды: и ядра, и адаптера. Команды ядра, меняющие проект, сохраняют его. */
export async function call(dir: string, name: string, args: Record<string, any>) {
  if (NODE_COMMANDS[name]) return NODE_COMMANDS[name].run(dir, args);
  const ctx = await loadCtx(dir);
  const res = runCommand(ctx, name, args);
  if (COMMANDS[name].mutates) saveProject(dir, ctx.project);
  return res;
}

export function listAll() {
  return [
    ...Object.values(COMMANDS).map((c) => ({ name: c.name, help: c.help, args: c.args })),
    ...Object.entries(NODE_COMMANDS).map(([name, c]) => ({ name, help: c.help, args: c.args })),
  ];
}

export { RECIPES };
