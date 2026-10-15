// Адаптеры под Node: файлы проекта, glb, библиотека пресетов, Blender. Используются CLI и MCP-сервером.
import { NodeIO } from "@gltf-transform/core";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { COMMANDS, Clip, type LibPreset, smoothJointWeights, Ctx, Project, bodyFrame, RECIPES, TweenPreset, buildRig, clipEvents, detectFins, detectForward, detectMultiLeg, detectWings, detectQuadruped, detectRig, emptyProject, frameTimes, posePartsAt, readSkeleton, runCommand, samplePreset, standardNames, suggestAlign, worldPose, writeClips, type NameScheme } from "../../core/src/index.ts";
import { loadSkinScene, restVerts, skinFrame, skinTopology } from "./skin.ts";
import { recipeVectors } from "./recipe-vectors.ts";

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
export const GODOT = process.env.GODOT ?? "/Applications/Godot.app/Contents/MacOS/Godot";
export const BLENDER = process.env.BLENDER ?? "/Applications/Blender.app/Contents/MacOS/Blender";
// Свой каталог пользователя Blender: наши фоновые запуски не видят расширений владельца. Иначе каждый запуск
// синхронизирует колёса расширений в его site-packages, и параллельные запуски (плитки бестиария, авториг)
// стирают пакеты друг у друга — так однажды пропал blmcp у Blender MCP.
const BLENDER_ENV = { ...process.env, BLENDER_USER_RESOURCES: join(tmpdir(), "animforge-blender-user") };
const io = new NodeIO();

export const projectFile = (dir: string) => join(dir, "animforge.json");

// Примерка: пока идёт dryRun, проект читается из песочницы и пишется в неё же — файл на диске не трогается
let sandbox: { project: Project } | null = null;

export async function loadCtx(dir: string): Promise<Ctx & { dir: string }> {
  const project: Project = sandbox ? structuredClone(sandbox.project) : JSON.parse(readFileSync(projectFile(dir), "utf8"));
  const doc = await io.read(join(dir, project.model));
  return { project, skeleton: readSkeleton(doc), dir };
}

export function saveProject(dir: string, p: Project) {
  if (sandbox) return void (sandbox.project = structuredClone(p));
  writeFileSync(projectFile(dir), JSON.stringify(p, null, 2) + "\n");
}

type Preset = LibPreset;

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
export async function exportGlb(ctx: Ctx & { dir: string }, out: string, names?: NameScheme) {
  const doc = await io.read(join(ctx.dir, ctx.project.model));
  const rig = buildRig(ctx.skeleton);
  const report = writeClips(doc, ctx.project, rig);
  // стандартные имена костей (Mixamo / Unreal): узлы glb переименовываются уже после записи клипов — каналы
  // анимации ссылаются на узлы, а не на имена
  const rename = names ? standardNames(ctx.project, rig, names) : new Map<string, string>();
  const joints = new Set(doc.getRoot().listSkins().flatMap((sk) => sk.listJoints().map((j) => j.getName())));
  for (const n of doc.getRoot().listNodes()) if (rename.has(n.getName())) n.setName(rename.get(n.getName())!);
  const nm = <T>(o: Map<string, T>) => Object.fromEntries([...o].map(([k, v]) => [rename.get(k) ?? k, v]));
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
      // мировые положения суставов — для сверки FBX: там повороты костей относительно своих осей, а суставы — те же
      const w = worldPose(rig, pose).T;
      const world = new Map(ctx.skeleton.nodes.flatMap((n, i) => (joints.has(n.name) ? [[n.name, w[i].map((x) => +x.toFixed(6))] as const] : [])));
      return { t, rotations: nm(pose.rot), positions: nm(pose.pos), scales: nm(pose.scl), world: nm(world) };
    }),
  }));
  // живые рецепты: аддон Godot считает позу сам (AnimForgeLive) — ему нужны скелет, цепочки, пределы и слои клипов
  // (с чужими именами костей — не пишем: аддон ищет кости по именам проекта)
  if (!rename.size) writeFileSync(out.replace(/\.glb$/, ".af.json"), JSON.stringify((await import("./live.ts")).liveData(ctx)));
  writeFileSync(out.replace(/\.glb$/, ".samples.json"), JSON.stringify(samples.filter((s) => report.find((r) => r.clip === s.clip)!.bones > 0), null, 1));
  // события — отдельным файлом рядом с glb: аддон Godot превращает их в вызовы методов (AnimForge.attach_events)
  const events = Object.fromEntries(ctx.project.clips.map((c) => [c.name, clipEvents(c).map(({ t, name }) => ({ t, name }))]).filter(([, e]) => (e as unknown[]).length));
  if (Object.keys(events).length) writeFileSync(out.replace(/\.glb$/, ".events.json"), JSON.stringify(events, null, 1));
  const empty = report.filter((r) => r.bones === 0).map((r) => r.clip);
  return { out, clips: report, ...(rename.size ? { renamed: Object.fromEntries(rename) } : {}), ...(empty.length ? { warning: `пустые клипы не записаны (нет слоёв, двигающих кости): ${empty.join(", ")}` } : {}) };
}

/** Экспорт в glb или FBX. FBX собирает Blender из того же glb: скин, клипы тейками, единицы под движок. */
export async function exportFile(ctx: Ctx & { dir: string }, out: string, names?: string, units?: string) {
  if (names && !["mixamo", "unreal"].includes(names)) throw new Error(`names: mixamo или unreal, а не «${names}»`);
  if (!/\.fbx$/i.test(out)) {
    if (units) throw new Error("units — только для FBX");
    return exportGlb(ctx, out, names as NameScheme | undefined);
  }
  const u = units ?? "blender";
  if (!["blender", "maya", "unity", "unreal"].includes(u)) throw new Error(`units: blender, maya, unity или unreal, а не «${u}»`);
  const tmp = mkdtempSync(join(tmpdir(), "animforge-fbx-"));
  try {
    const r = await exportGlb(ctx, join(tmp, "clip.glb"), names as NameScheme | undefined);
    mkdirSync(dirname(out), { recursive: true });
    const log = execFileSync(BLENDER, ["-b", "--factory-startup", "--python", join(ROOT, "bridge/blender/export_fbx.py"), "--", join(tmp, "clip.glb"), out, u], { env: BLENDER_ENV, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 64 << 20 });
    const ok = log.split("\n").find((l) => l.startsWith("FBX_OK"));
    if (!ok) throw new Error("Blender не записал FBX:\n" + log.split("\n").filter((l) => /FBX|Error|Traceback/.test(l)).join("\n"));
    // эталон для сверки и события — рядом с FBX, как у glb
    for (const ext of [".samples.json", ".events.json"]) if (existsSync(join(tmp, "clip" + ext))) writeFileSync(out.replace(/\.fbx$/i, ext), readFileSync(join(tmp, "clip" + ext)));
    const { out: _o, ...rest } = r;
    return { out, units: u, ...rest, log: ok };
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

/** «Глаза»: кадры клипа. Позу считает ядро, кожу — skin.ts по спецификации glTF, Blender только рисует треугольники.
 * Кадр k из count — момент duration·k/count. */
async function renderFrames(ctx: Ctx & { dir: string }, clip: Clip, dir: string, count: number, view: string, dist = 1, size: [number, number] = [480, 300], times?: number[]) {
  const sc = loadSkinScene(await io.read(join(ctx.dir, ctx.project.model)));
  if (!sc.parts.length) throw new Error("в модели нет мешей — рисовать нечего");
  const rig = buildRig(ctx.skeleton);
  const fw = bodyFrame(ctx.project).forward;
  const yaw = Math.abs(ctx.project.up[1]) > 0.99 ? -Math.atan2(fw[0], fw[2]) : 0; // лицом на +Z, только для Y-up
  const at = times ?? Array.from({ length: count }, (_, k) => (clip.duration * k) / count);
  count = at.length;
  const frames = at.map((t) => skinFrame(sc, posePartsAt(ctx.project, rig, clip, t), yaw));
  const topo = join(dir, "topo.json"), bin = join(dir, "frames.bin");
  writeFileSync(topo, JSON.stringify(skinTopology(sc)));
  writeFileSync(bin, Buffer.concat(frames.map((f) => Buffer.from(f.buffer, f.byteOffset, f.byteLength))));
  const log = execFileSync(BLENDER, ["-b", "--factory-startup", "--python", join(ROOT, "bridge/blender/render_mesh.py"), "--", topo, bin, dir, String(count), view, String(dist), String(size[0]), String(size[1])], { env: BLENDER_ENV, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 64 << 20 });
  if (!log.includes("SHEET_OK")) throw new Error("Blender не отрендерил кадры:\n" + log.split("\n").filter((l) => /SHEET|Error|Traceback/.test(l)).join("\n"));
  return readdirSync(dir).filter((f) => f.endsWith(".png")).sort().map((f) => join(dir, f));
}

const findClip = (ctx: Ctx, name: string) => {
  const clip = ctx.project.clips.find((c) => c.name === name);
  if (!clip) throw new Error(`нет клипа «${name}»`);
  return clip;
};

/** Видео клипа: один проход рендерится в Blender, ffmpeg повторяет его loops раз. */
export async function renderVideo(ctx: Ctx & { dir: string }, clipName: string, view: string, loops: number, dist: number, out: string, caption?: string) {
  const clip = findClip(ctx, clipName);
  const tmp = mkdtempSync(join(tmpdir(), "af-video-"));
  try {
    const n = Math.max(2, Math.round(clip.duration * clip.fps));
    await renderFrames(ctx, clip, tmp, n, view, dist, [720, 720]);
    // подпись внизу кадра (ffmpeg без drawtext — пишем на кадры ImageMagick)
    if (caption) execFileSync("magick", ["mogrify", "-font", "/System/Library/Fonts/Supplemental/Arial.ttf", "-pointsize", "30", "-fill", "#222", "-gravity", "south", "-annotate", "+0+24", caption, ...readdirSync(tmp).filter((f) => f.endsWith(".png")).map((f) => join(tmp, f))]);
    mkdirSync(dirname(out), { recursive: true });
    execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-stream_loop", String(Math.max(0, loops - 1)), "-framerate", String(n / clip.duration), "-i", join(tmp, "f_%03d.png"), "-pix_fmt", "yuv420p", "-vf", "scale=720:720", out]);
    return { out, frames: n, loops, seconds: +(clip.duration * loops).toFixed(2) };
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

export async function renderSheet(ctx: Ctx & { dir: string }, clip: string, frames: number, view: string, out: string, dist = 1) {
  const tmp = mkdtempSync(join(tmpdir(), "af-sheet-"));
  try {
    const pngs = await renderFrames(ctx, findClip(ctx, clip), tmp, frames, view, dist);
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

/** Лист для критика: два ряда — спереди в три четверти и в профиль; на каждом кадре номер и время.
 * Кадров — по длине клипа (≈6 в секунду, 6–12), и кадры событий удара всегда в листе: на редком листе задержка
 * в замахе и контакт пролетают между кадрами (так критик однажды не увидел замаха, который был). */
export function reviewTimes(clip: Clip, n?: number): number[] {
  const k = n ?? Math.max(6, Math.min(12, Math.round(clip.duration * 6)));
  const ts = Array.from({ length: k }, (_, i) => (clip.duration * i) / k);
  for (const e of clipEvents(clip).filter((e) => e.name === "hit")) {
    let j = 0;
    for (let i = 1; i < ts.length; i++) if (Math.abs(ts[i] - e.t) < Math.abs(ts[j] - e.t)) j = i;
    if (j > 0) ts[j] = e.t; // первый кадр — всегда начало клипа
  }
  return [...new Set(ts.map((t) => +t.toFixed(3)))].sort((a, b) => a - b);
}

export async function renderReviewSheet(ctx: Ctx & { dir: string }, clip: string, out: string, n?: number) {
  const tmp = mkdtempSync(join(tmpdir(), "af-review-"));
  try {
    const c = findClip(ctx, clip);
    const times = reviewTimes(c, n);
    const rows: string[] = [];
    for (const view of ["front_3q", "profile"]) {
      const d = join(tmp, view);
      mkdirSync(d);
      const pngs = await renderFrames(ctx, c, d, times.length, view, 0.9, [300, 360], times);
      pngs.forEach((p, k) => execFileSync("magick", [p, "-font", "/System/Library/Fonts/Supplemental/Arial.ttf", "-pointsize", "20", "-fill", "#222", "-gravity", "northwest", "-annotate", "+8+6", `${view === "profile" ? "профиль" : "спереди"} ${k} · ${times[k].toFixed(2)} с`, p]));
      rows.push("(", ...pngs, "-bordercolor", "#c4c8cf", "-border", "1", "+append", ")");
    }
    mkdirSync(dirname(out), { recursive: true });
    execFileSync("magick", [...rows, "-append", out]);
    return { out, times };
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

/** Шаблон тела через Blender: меш + кости + автоматические веса. */
export function makeTemplate(type: string, out: string, bones?: number) {
  const script = join(ROOT, `bridge/blender/template_${type}.py`);
  if (!existsSync(script)) throw new Error(`нет шаблона «${type}»`);
  mkdirSync(dirname(out), { recursive: true });
  const log = execFileSync(BLENDER, ["-b", "--factory-startup", "--python", script, "--", out, ...(bones ? [String(bones)] : [])], { env: BLENDER_ENV, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  const ok = log.split("\n").find((l) => l.includes("_OK"));
  if (!ok) throw new Error("шаблон не собрался");
  return { out, log: ok };
}

/** Руки, которые нельзя выравнивать по костям: рука меша (вершины, где главная кость — из цепочки руки или ниже)
 * от плеча уже смотрит вниз — ближе 45° к вертикали. Мало вершин (жёсткая рука-деталь) — проверять нечего. */
async function meshArmCheck(ctx: Ctx & { dir: string }, arms: string[]): Promise<Record<string, string>> {
  if (!arms.length) return {};
  const sc = loadSkinScene(await io.read(join(ctx.dir, ctx.project.model)));
  if (!sc.parts.length) return {};
  const rig = buildRig(ctx.skeleton);
  const { p, dom } = restVerts(sc);
  const out: Record<string, string> = {};
  for (const arm of arms) {
    const chain = ctx.project.chains[arm];
    const root = rig.index.get(chain[0])!;
    // кости руки и всё, что ниже (кисть, пальцы, twist-кости)
    const under = new Set<string>();
    ctx.skeleton.nodes.forEach((n, i) => { for (let q = i; q >= 0; q = rig.parent[q]) if (q === root) { under.add(n.name); break; } });
    const s: number[] = [0, 0, 0];
    let n = 0;
    dom.forEach((d, i) => { if (d && under.has(d)) { s[0] += p[i * 3]; s[1] += p[i * 3 + 1]; s[2] += p[i * 3 + 2]; n++; } });
    if (n < 30) continue;
    const sh = rig.worldT[root];
    const md = [s[0] / n - sh[0], s[1] / n - sh[1], s[2] / n - sh[2]];
    // от «вниз» тела: рецепты пишутся от висящей руки — уже висит в меше, значит, опускать нечего
    const down = bodyFrame(ctx.project).up.map((x) => -x);
    const cos = (md[0] * down[0] + md[1] * down[1] + md[2] * down[2]) / (Math.hypot(...md) || 1);
    const deg = Math.acos(Math.max(-1, Math.min(1, cos))) * 180 / Math.PI;
    if (deg < 45) out[arm] = `рука меша уже опущена (${deg.toFixed(0)}° от вертикали), отведены только кости`;
  }
  return out;
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

/** Копирует библиотеку твинов и idle-вставок в аддон Godot (аддон читает только свою папку presets). */
export function syncTweens() {
  mkdirSync(join(ADDON_PRESETS(), "idle"), { recursive: true });
  const files = readdirSync(TWEEN_LIB()).filter((f) => f.endsWith(".json"));
  for (const f of files) writeFileSync(join(ADDON_PRESETS(), f), readFileSync(join(TWEEN_LIB(), f)));
  const idle = join(ROOT, "library/idle");
  const idleFiles = readdirSync(idle).filter((f) => f.endsWith(".json"));
  for (const f of idleFiles) writeFileSync(join(ADDON_PRESETS(), "idle", f), readFileSync(join(idle, f)));
  return { copied: [...files, ...idleFiles.map((f) => `idle/${f}`)], to: ADDON_PRESETS() };
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
  "model.autorig": {
    help: "Авториг модели без скелета: кости по форме тела (воксели → граф уровней от самой толстой точки) и веса кожи; выход — glb со скином. Любое тело: человек, зверь, рыба, щупальце.",
    args: {
      file: { type: "string", required: true, help: "исходный файл (FBX, glTF/GLB, OBJ, DAE, STL, PLY)" },
      out: { type: "string", help: "куда (по умолчанию assets/model.glb)" },
      res: { type: "number", help: "вокселей вдоль длинной стороны, по умолчанию 128 (тоньше — дольше; 64 — если ноги не касаются)" },
      bones: { type: "number", help: "костей вдоль тела, по умолчанию 10" },
      fingers: { type: "boolean", help: "пальцы: кисти вокселит мельче и ищет 4–6 раздельных пальцев (дольше; у сомкнутых пальцев, как у Xbot, не найдёт)" },
    },
    async run(dir, a) {
      const src = resolve(process.env.INIT_CWD ?? process.cwd(), a.file);
      const out = resolve(dir, a.out ?? "assets/model.glb");
      mkdirSync(dirname(out), { recursive: true });
      const log = execFileSync(BLENDER, ["-b", "--factory-startup", "--python", join(ROOT, "bridge/blender/autorig.py"), "--", src, out, String(a.res ?? 128), String(a.bones ?? 10)], { env: { ...BLENDER_ENV, AUTORIG_FINGERS: a.fingers ? "1" : "0" }, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 64 << 20 });
      const ok = log.split("\n").find((l) => l.startsWith("AUTORIG_OK"));
      if (!ok) throw new Error("авториг не удался:\n" + log.split("\n").filter((l) => /AUTORIG|Error|Traceback/.test(l)).join("\n"));
      return { out, log: ok };
    },
  },
  "project.new": {
    help: "Новый проект из чужой модели одним шагом: импорт через Blender (FBX, glTF/GLB, DAE, OBJ) → assets/model.glb, авториг, если скелета нет, проект, rig.detect.",
    args: { file: { type: "string", required: true, help: "исходный файл модели" }, name: { type: "string", help: "имя проекта" } },
    async run(dir, a) {
      if (existsSync(projectFile(dir))) throw new Error(`проект уже есть: ${dir}`);
      mkdirSync(dir, { recursive: true });
      try {
        await NODE_COMMANDS["model.import"].run(dir, { file: a.file, out: "assets/model.glb" });
        await NODE_COMMANDS.init.run(dir, { model: "assets/model.glb", name: a.name });
        const ctx = await loadCtx(dir);
        // скелета нет — строим сами по форме тела
        let autorig: unknown;
        if (!ctx.skeleton.nodes.some((n) => n.isJoint)) autorig = await NODE_COMMANDS["model.autorig"].run(dir, { file: a.file, out: "assets/model.glb" });
        const detect = await NODE_COMMANDS["rig.detect"].run(dir, {});
        return { dir, detect, autorig };
      } catch (e) {
        rmSync(dir, { recursive: true, force: true }); // полупроект не оставляем
        throw e;
      }
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
    help: "Запечь все клипы в glb (+ .samples.json для проверки в Godot) или FBX (через Blender, каждый клип — тейк). names — стандартные имена костей для авто-ретаргета в движке.",
    args: {
      out: { type: "string", required: true, help: "путь к .glb или .fbx" },
      names: { type: "string", help: "mixamo | unreal — переименовать кости по цепочкам (иначе — свои имена)" },
      units: { type: "string", help: "для FBX: blender (по умолчанию, метры, Y вверх; так же для Godot и Maya) | unity | unreal (сантиметры, Z вверх)" },
    },
    run: async (dir, a) => exportFile(await loadCtx(dir), resolve(dir, a.out), a.names, a.units),
  },
  verify: {
    help: "Проверка в Godot без окна: экспорт → загрузка в Godot → сверка с ядром. glb — повороты костей; FBX — положения суставов в метрах (так проверяются и оси, и единицы пресета).",
    args: {
      out: { type: "string", help: "куда экспортировать (.glb или .fbx), по умолчанию out/<имя>.glb" },
      names: { type: "string", help: "mixamo | unreal — как в export" },
      units: { type: "string", help: "для FBX — как в export" },
    },
    async run(dir, a) {
      const ctx = await loadCtx(dir);
      const out = resolve(dir, a.out ?? `out/${ctx.project.name}.glb`);
      const fbx = /\.fbx$/i.test(out);
      await exportFile(ctx, out, a.names, a.units);
      let log = "";
      try {
        log = execFileSync(GODOT, ["--headless", "--path", join(ROOT, "godot/verify"), "--script", fbx ? "verify_fbx.gd" : "verify.gd", "--", out, out.replace(/\.(glb|fbx)$/i, ".samples.json")], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 300_000 });
      } catch (e: any) {
        log = String(e.stdout ?? "") + String(e.stderr ?? "");
      }
      const lines = log.split("\n").filter((l) => /CLIP|VERIFY/.test(l));
      return { ok: lines.some((l) => l.includes("VERIFY_OK")), godot: lines };
    },
  },
  "model.import": {
    help: "Импорт чужой модели (FBX, OBJ, glTF, DAE) через Blender → glb со скином, без исходных анимаций.",
    args: { file: { type: "string", required: true, help: "исходный файл" }, out: { type: "string", help: "куда (по умолчанию assets/<имя>.glb)" } },
    async run(dir, a) {
      // путь к исходнику — от папки, где запустили команду (pnpm --dir меняет cwd; исходную он кладёт в INIT_CWD)
      const src = resolve(process.env.INIT_CWD ?? process.cwd(), a.file);
      const out = resolve(dir, a.out ?? `assets/${src.replace(/^.*\//, "").replace(/\.[^.]+$/, "")}.glb`);
      mkdirSync(dirname(out), { recursive: true });
      const log = execFileSync(BLENDER, ["-b", "--factory-startup", "--python", join(ROOT, "bridge/blender/import_model.py"), "--", src, out], { env: BLENDER_ENV, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 64 << 20 });
      const ok = log.split("\n").find((l) => l.startsWith("IMPORT_OK"));
      if (!ok) throw new Error("Blender не импортировал модель:\n" + log.split("\n").filter((l) => /IMPORT|Error|Traceback/.test(l)).join("\n"));
      return { out, log: ok };
    },
  },
  "rig.detect": {
    help: "Распознать скелет модели (по именам Mixamo/Unreal/Unity/Rigify/3ds Max или по геометрии) и записать стандартные цепочки: pelvis, spine, chest, neck, head, arm_l/r, leg_l/r, tail, eye_l/r.",
    args: { write: { type: "boolean", help: "записать цепочки в проект (по умолчанию да)" } },
    async run(dir, a) {
      const ctx = await loadCtx(dir);
      // сначала — куда смотрит персонаж (от этого зависят «лево/право» и плоскости маха)
      // четвероногое узнаём по геометрии лап, и «вперёд» у него — к голове
      const quad = detectQuadruped(ctx.skeleton, ctx.project.up) ?? detectMultiLeg(ctx.skeleton, ctx.project.up);
      const fw = quad ? { forward: quad.forward, by: "head" as const } : detectForward(ctx.skeleton, ctx.project.up);
      ctx.project.forward = fw.forward.map((x) => +x.toFixed(4)) as [number, number, number];
      const fresh = quad ? null : detectRig(ctx.skeleton, ctx.project);
      // ласты проверяем до «двуногого»: записанные прошлым разом leg_l у черепахи — это задние ласты, а не ноги
      const finCheck = !quad && !fresh!.chains.leg_l ? detectFins(ctx.skeleton, ctx.project.up) : null;
      const det = { ...(quad ?? fresh!), body: quad ? ("legCount" in quad ? "multileg" : "quadruped") : finCheck ? "other" : fresh!.chains.leg_l ? "biped" : "other", forward: ctx.project.forward, forwardBy: fw.by };
      // крылья: длинные «руки» — цепочки wing_l/wing_r на всю длину, руки не выравниваем
      const wings = quad ? null : detectWings(ctx.skeleton, ctx.project.up, det);
      if (wings) {
        det.chains = { ...det.chains, wing_l: wings.wing_l, wing_r: wings.wing_r } as typeof det.chains;
        delete det.chains.arm_l; delete det.chains.arm_r;
        (det as { body: string }).body = "winged";
        det.notes.push(`крылатое: размах ${wings.span.toFixed(2)}, крылья — wing_l/wing_r`);
        delete ctx.project.chains.arm_l; delete ctx.project.chains.arm_r;
        if (ctx.project.align) { delete ctx.project.align.arm_l; delete ctx.project.align.arm_r; }
      }
      // без ног и без крыльев — может быть, ласты или плавники (черепаха, скат): пары веток в стороны
      if (det.body === "other") {
        const fins = finCheck;
        if (fins) {
          // догадки detectRig по геометрии для такого тела ложны (голова на кончике ласта) — берём только найденное здесь
          for (const k of ["pelvis", "spine", "chest", "neck", "head", "arm_l", "arm_r", "leg_l", "leg_r", "tail"]) {
            delete (det.chains as Record<string, unknown>)[k];
            if (ctx.project.chains[k] && det.method[k as keyof typeof det.method] !== "names") delete ctx.project.chains[k];
          }
          det.chains = { ...det.chains, ...fins.chains } as typeof det.chains;
          // широкая передняя пара — крылья (птица без имён костей), иначе ласты
          const rg = buildRig(ctx.skeleton), U = ctx.project.up;
          const tip = (c?: string[]) => rg.worldT[rg.index.get(c![c!.length - 1])!];
          const hs = ctx.skeleton.nodes.map((n, i) => (n.isJoint ? rg.worldT[i][0] * U[0] + rg.worldT[i][1] * U[1] + rg.worldT[i][2] * U[2] : NaN)).filter((x) => !Number.isNaN(x));
          const span = Math.hypot(...[0, 1, 2].map((k) => tip(fins.chains.wing_l)[k] - tip(fins.chains.wing_r)[k]));
          (det as { body: string }).body = span > 1.6 * (Math.max(...hs) - Math.min(...hs) || 1) ? "winged" : "finned";
          ctx.project.forward = fins.forward.map((x) => +x.toFixed(4)) as [number, number, number];
          det.forward = ctx.project.forward;
          det.notes.push(...fins.notes);
        }
      }
      // тело-линия (рыба, змея, щупальце): цепочка body — самый длинный путь от корня, для волны и изгибов
      if (det.body === "other" && !ctx.project.chains.body) {
        const rg = buildRig(ctx.skeleton);
        const js = ctx.skeleton.nodes.map((n, i) => i).filter((i) => ctx.skeleton.nodes[i].isJoint);
        const root = js.find((i) => !js.includes(rg.parent[i]));
        if (root != null) {
          let best: number[] = [];
          const walk = (i: number, path: number[]) => {
            const kids = js.filter((j) => rg.parent[j] === i);
            if (!kids.length && path.length > best.length) best = path;
            for (const k of kids) walk(k, [...path, k]);
          };
          walk(root, [root]);
          if (best.length >= 3) {
            ctx.project.chains.body = best.map((i) => ctx.skeleton.nodes[i].name);
            det.notes.push(`тело-линия: цепочка body из ${best.length} костей`);
          }
        }
      }
      // стандартные цепочки прошлого распознавания, которых теперь нет, убираем: иначе устаревшие leg_l у рыбы
      // делают её «двуногой». Свои цепочки с другими именами (body, hem_0…) не трогаем
      const std = (k: string) => /^(pelvis|spine|chest|neck|head|tail|arm_[lr]|leg_[lr]\d*|wing_[lr]|eye_[lr])$/.test(k);
      for (const k of Object.keys(ctx.project.chains)) if (std(k) && !(det.chains as Record<string, unknown>)[k]) delete ctx.project.chains[k];
      for (const [k, v] of Object.entries(det.chains)) if (v) ctx.project.chains[k] = v;
      // руки в T/A-позе сначала опускаются вниз — от этой позы считаются все махи рецептов
      const al = suggestAlign(buildRig(ctx.skeleton), ctx.project);
      // кости говорят «T-поза», а меш может быть вылеплен иначе (у пекаря CC-скелет в T-позе, а ручки — перед животом):
      // опускать такие руки — рвать кожу. Выравниваем, только если рука меша идёт вдоль костей
      for (const [arm, why] of Object.entries(await meshArmCheck(ctx, Object.keys(al.align)))) {
        delete al.align[arm];
        if (ctx.project.align) delete ctx.project.align[arm];
        det.notes.push(`${arm}: ${why} — руку не выравниваем`);
      }
      if (Object.keys(al.align).length) ctx.project.align = { ...ctx.project.align, ...al.align };
      if (a.write !== false) saveProject(dir, ctx.project);
      return { ...det, armAngles: al.angles, align: ctx.project.align ?? {} };
    },
  },
  "recipe.rig": {
    help: "Поставить рецепт сразу на всё тело: по слою на каждую роль рецепта (ходьба — таз, грудь, голова, руки, ноги; удар — рука, корпус, таз), на стандартные цепочки из rig.detect.",
    args: {
      clip: { type: "string", required: true, help: "клип" },
      recipe: { type: "string", required: true, help: "рецепт с ролями: waddle-walk, melee-strike, charge-release, compass-step, blink" },
      preset: { type: "string", help: "пресет библиотеки" },
      params: { type: "json", help: "поверх пресета" },
      side: { type: "string", help: "рука для ударов: r (по умолчанию) | l" },
    },
    async run(dir, a) {
      const ctx = await loadCtx(dir);
      const def = RECIPES[a.recipe];
      if (!def?.roles) throw new Error(`у рецепта «${a.recipe}» нет ролей. С ролями: ${Object.entries(RECIPES).filter(([, d]) => d.roles).map(([n]) => n).join(", ")}`);
      const base = a.preset ? findPreset(a.preset).preset.params : {};
      const added: string[] = [], skipped: string[] = [];
      for (const [role, r] of Object.entries(def.roles)) {
        const chain = typeof r.chain === "function" ? r.chain(a.side === "l" ? "l" : "r") : r.chain;
        if (!ctx.project.chains[chain]) { if (!r.optional) skipped.push(`${role} (нет цепочки ${chain})`); continue; }
        const id = `${chain}_${a.recipe}`;
        const clip = ctx.project.clips.find((c) => c.name === a.clip);
        if (clip) clip.layers = clip.layers.filter((l) => l.id !== id); // повторный вызов заменяет слой
        runCommand(ctx, "recipe.add", { clip: a.clip, recipe: a.recipe, chain, id, preset: a.preset, params: { ...base, ...(def.params.role ? { role } : {}), ...(r.params ?? {}), ...(a.params ?? {}) } });
        added.push(id);
      }
      saveProject(dir, ctx.project);
      return { added, skipped };
    },
  },
  "clip.events": {
    help: "События клипа от рецептов (hit, whoosh, trail_on/off, window_open/close…) с временем в секундах.",
    args: { clip: { type: "string", required: true, help: "клип" } },
    async run(dir, a) {
      const ctx = await loadCtx(dir);
      const clip = ctx.project.clips.find((c) => c.name === a.clip);
      if (!clip) throw new Error(`нет клипа «${a.clip}»`);
      return clipEvents(clip);
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
    help: "Проверка аддона Godot без окна: выборки всех твинов против ядра, живые твины, события клипов, вставки в idle.",
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
      const lines = log.split("\n").filter((l) => /SAMPLES|LIVE|EVENTS|IDLE|TWEENS|ERROR|error/.test(l));
      return { ok: lines.some((l) => l.includes("TWEENS_OK")), presets: Object.keys(samples).length, synced: sync.copied, godot: lines };
    },
  },
  "recipes.verify": {
    help: "Сверка рецептов аддона Godot (live/af_recipes.gd) с ядром без окна: evaluate, events и length по всем рецептам, пресетам и вариантам enum.",
    args: {},
    async run() {
      const tmp = mkdtempSync(join(tmpdir(), "af-rc-"));
      const file = join(tmp, "vectors.json");
      writeFileSync(file, JSON.stringify(recipeVectors()));
      let log = "";
      try {
        log = execFileSync(GODOT, ["--headless", "--path", join(ROOT, "godot/sandbox"), "--script", "res://tests/recipes_verify.gd", "--", file], { encoding: "utf8", timeout: 180_000, maxBuffer: 64 << 20, stdio: ["ignore", "pipe", "pipe"] });
      } catch (e: any) {
        log = String(e.stdout ?? "") + String(e.stderr ?? "");
      }
      rmSync(tmp, { recursive: true, force: true });
      const lines = log.split("\n").filter((l) => /RECIPE|ERROR|error/.test(l));
      const recipes = Object.fromEntries(lines.flatMap((l) => { const m = /^RECIPE (\S+) (\S+)/.exec(l); return m ? [[m[1], Number(m[2])]] : []; }));
      return { ok: lines.some((l) => l.includes("RECIPES_OK")), recipes, godot: lines };
    },
  },
  sheet: {
    help: "Глаза агента: отрендерить клип в лист кадров PNG через Blender.",
    args: {
      clip: { type: "string", required: true, help: "клип" },
      out: { type: "string", required: true, help: "png" },
      frames: { type: "number", help: "сколько кадров, по умолчанию 8" },
      view: { type: "string", help: "side | top | three_quarter (по умолчанию) — тела вдоль X; front | profile | profile_r | front_3q | front_3q_r — персонажи" },
      dist: { type: "number", help: "отдаление камеры: 1 — персонаж во всех позах клипа целиком (по умолчанию), 0.6 — крупнее, 1.5 — дальше" },
    },
    run: async (dir, a) => renderSheet(await loadCtx(dir), a.clip, a.frames ?? 8, a.view ?? "three_quarter", resolve(dir, a.out), a.dist ?? 1),
  },
  video: {
    help: "Видео клипа (mp4, 720×720) через Blender + ffmpeg: один проход, повторённый loops раз.",
    args: {
      clip: { type: "string", required: true, help: "клип" },
      out: { type: "string", required: true, help: "mp4" },
      view: { type: "string", help: "как у sheet, по умолчанию three_quarter" },
      loops: { type: "number", help: "сколько раз повторить, по умолчанию 4" },
      dist: { type: "number", help: "отдаление камеры: 1 — персонаж во всех позах клипа целиком (по умолчанию)" },
    },
    run: async (dir, a) => renderVideo(await loadCtx(dir), a.clip, a.view ?? "three_quarter", a.loops ?? 4, a.dist ?? 1, resolve(dir, a.out)),
  },
};

NODE_COMMANDS.make = {
  help: "От модели до готового файла одним вызовом: проект и авториг (если их нет), клипы из библиотеки, анатомические пределы, glb, видео всех клипов с подписями, копия в игру на Godot. Сомнительный риг — остановка с картинкой.",
  args: {
    clips: { type: "string", required: true, help: "клипы через «;» (или запятую): «имя=пресет{json-параметры}», «пресет» или слова «ленивая ходьба» — тогда поиск по библиотеке" },
    file: { type: "string", help: "модель (FBX, glTF/GLB, OBJ, DAE) — если проекта в папке ещё нет" },
    name: { type: "string", help: "имя проекта" },
    style: { type: "json", help: "карточка стиля: {genre, stylization, role: player|enemy|npc, fps, refs[], notes} — запоминается в проекте" },
    godot: { type: "string", help: "папка внутри проекта Godot, куда класть glb — запоминается в проекте" },
    force: { type: "boolean", help: "не останавливаться на сомнительном риге" },
    check: { type: "boolean", help: "автопроверки с починкой (по умолчанию да)" },
    review: { type: "boolean", help: "пакет для критика: true — всегда, false — никогда, без флага — когда проверки нашли брак" },
    video: { type: "boolean", help: "рендерить видео (по умолчанию да)" },
    view: { type: "string", help: "ракурс видео, как у sheet (по умолчанию по телу)" },
    out: { type: "string", help: "куда glb, по умолчанию out/<имя>.glb" },
    send: { type: "boolean", help: "прислать видео и glb в Telegram (harbor-send)" },
  },
  run: async (dir, a) => (await import("./make.ts")).make(dir, a),
};

NODE_COMMANDS["live.verify"] = {
  help: "Сверка живого вычисления позы в Godot (addons/animforge/live/af_core.gd) с ядром: все клипы демо-проектов (или --dirs), кость в кость.",
  args: { dirs: { type: "string", help: "папки проектов через запятую (по умолчанию все projects/*)" } },
  run: async (_dir, a) => (await import("./live.ts")).liveVerify(a.dirs ? String(a.dirs).split(",").map((d: string) => resolve(d.trim())) : undefined),
};

NODE_COMMANDS["weights.smooth"] = {
  help: "Сгладить веса кожи у границ соседних костей: где вершины жёстко поделены между бедром и голенью (или плечом и предплечьем), при сгибе открывается щель. Исходник модели — рядом, *.orig.glb.",
  args: {
    rings: { type: "number", help: "насколько широко от границы, в рёбрах; по умолчанию 3" },
    iters: { type: "number", help: "проходов сглаживания, по умолчанию 6" },
  },
  run: async (dir, a) => smoothWeights(dir, a.rings ?? 3, a.iters ?? 6),
};

NODE_COMMANDS.publish = {
  help: "Запечь все клипы в glb (out/<имя>.glb) и положить копию в игру на Godot — в папку, записанную в проекте (make --godot).",
  args: { out: { type: "string", help: "куда glb, по умолчанию out/<имя>.glb" } },
  run: async (dir, a) => (await import("./make.ts")).publish(dir, a.out),
};

NODE_COMMANDS["review.pack"] = {
  help: "Пакет для критика (critic/CRITIC.md): на каждый клип лист кадров спереди и в профиль с номерами, review.json — карточка стиля, клипы, события и отчёт автопроверок. Критик — отдельный агент, он только судит.",
  args: {
    clip: { type: "string", help: "клипы через запятую (по умолчанию все)" },
    out: { type: "string", help: "папка пакета, по умолчанию out/review" },
    frames: { type: "number", help: "кадров в ряду, по умолчанию по длине клипа (≈6 в секунду, 6–12; кадры удара — всегда)" },
  },
  async run(dir, a) {
    const { checkProject } = await import("./checks.ts");
    const ctx = await loadCtx(dir);
    const names = a.clip ? String(a.clip).split(",").map((x: string) => x.trim()) : ctx.project.clips.map((c) => c.name);
    const out = resolve(dir, a.out ?? "out/review");
    rmSync(out, { recursive: true, force: true });
    mkdirSync(out, { recursive: true });
    const checks = await checkProject(dir, names, false);
    const sheets: string[] = [], times: Record<string, number[]> = {};
    for (const name of names) {
      const r = await renderReviewSheet(ctx, name, join(out, `${name}.png`), a.frames);
      sheets.push(r.out);
      times[name] = r.times;
    }
    const clips = ctx.project.clips.filter((c) => names.includes(c.name)).map((c) => ({
      clip: c.name, duration: c.duration, loop: c.loop, frameTimes: times[c.name],
      layers: c.layers.map((l) =>
        l.type === "recipe"
          ? { recipe: l.recipe, preset: l.preset, chain: l.target.chain, weight: l.weight ?? 1 }
          : l.type === "keys"
            ? { type: "keys", tracks: l.tracks.map((tr) => ({ bone: tr.bone, axis: tr.axis, keys: tr.keys.map((k) => [k.t, k.v]) })) }
            : { type: l.type },
      ),
      events: clipEvents(c).map(({ t, name }) => ({ t: +t.toFixed(3), name })),
    }));
    writeFileSync(join(out, "review.json"), JSON.stringify({ project: ctx.project.name, style: ctx.project.style ?? null, clips, checks }, null, 1));
    return { dir: out, sheets, prompt: join(ROOT, "critic/CRITIC.md") };
  },
};

NODE_COMMANDS.check = {
  help: "Автопроверки клипов по коже модели: кожа рвётся (с поиском виноватого слоя), провал в пол и парение, шов цикла, рывки, упор в пределы, тайминг удара под роль из карточки стиля, клип короче событий. fix — чинить, что умеется (ослабить рвущий слой, поставить на пол).",
  args: {
    clip: { type: "string", help: "клип или несколько через запятую (по умолчанию все)" },
    fix: { type: "boolean", help: "чинить и записать правки в проект" },
  },
  async run(dir, a) {
    const { checkProject } = await import("./checks.ts");
    return checkProject(dir, a.clip ? String(a.clip).split(",").map((x: string) => x.trim()) : undefined, !!a.fix);
  },
};

/** Веса модели проекта: сгладить у суставов (smoothJointWeights) и записать glb; исходник — *.orig.glb рядом. */
export async function smoothWeights(dir: string, rings = 3, iters = 6) {
  const ctx = await loadCtx(dir);
  const file = join(dir, ctx.project.model);
  const orig = file.replace(/\.glb$/, ".orig.glb");
  if (!existsSync(orig)) writeFileSync(orig, readFileSync(file));
  const doc = await io.read(file);
  const parentOf = new Map<unknown, unknown>();
  for (const n of doc.getRoot().listNodes()) for (const c of n.listChildren()) parentOf.set(c, n);
  let changed = 0, total = 0;
  const e: number[] = [];
  for (const node of doc.getRoot().listNodes()) {
    const skin = node.getSkin(), mesh = node.getMesh();
    if (!skin || !mesh) continue;
    const joints = skin.listJoints();
    const parent = joints.map((jn) => { for (let p = parentOf.get(jn); p; p = parentOf.get(p)) { const k = joints.indexOf(p as never); if (k >= 0) return k; } return -1; });
    for (const prim of mesh.listPrimitives()) {
      const J = prim.getAttribute("JOINTS_0"), W = prim.getAttribute("WEIGHTS_0"), P = prim.getAttribute("POSITION");
      if (!J || !W || !P) continue;
      const n = J.getCount(), j = new Uint16Array(n * 4), w = new Float32Array(n * 4), pos = new Float32Array(n * 3);
      for (let i = 0; i < n; i++) { J.getElement(i, e); j.set(e.slice(0, 4), i * 4); W.getElement(i, e); w.set(e.slice(0, 4), i * 4); P.getElement(i, e); pos.set(e.slice(0, 3), i * 3); }
      const idx = prim.getIndices();
      const faces = idx ? Array.from({ length: idx.getCount() }, (_, i) => idx.getScalar(i)) : Array.from({ length: n }, (_, i) => i);
      changed += smoothJointWeights(j, w, pos, faces, parent, rings, iters);
      total += n;
      for (let i = 0; i < n; i++) { J.setElement(i, Array.from(j.subarray(i * 4, i * 4 + 4))); W.setElement(i, Array.from(w.subarray(i * 4, i * 4 + 4))); }
    }
  }
  await io.write(file, doc);
  return { changed, total, backup: orig };
}

/** Единая точка вызова любой команды: и ядра, и адаптера. Команды ядра, меняющие проект, сохраняют его. */
export async function call(dir: string, name: string, args: Record<string, any>) {
  if (NODE_COMMANDS[name]) return NODE_COMMANDS[name].run(dir, args);
  const ctx = await loadCtx(dir);
  const res = runCommand(ctx, name, args);
  if (COMMANDS[name].mutates) saveProject(dir, ctx.project);
  return res;
}

/** Команды, которые меняют только animforge.json, — их можно примерять (рендер и экспорт пишут другие файлы). */
export const DRY_OK = new Set(["clip.add", "recipe.add", "recipe.set", "recipe.rig", "preset.apply", "clip.ground", "key.set", "key.clear", "chain.set", "layer.remove", "layer.set", "clip.remove"]);

/** Выполнить шаги на копии проекта (base или с диска) и вернуть, что получилось, ничего не записывая.
 * Вызывать строго по очереди (как и call): песочница одна на процесс. */
export async function dryRun(dir: string, steps: { name: string; args: Record<string, any> }[], base?: Project) {
  for (const s of steps) if (!DRY_OK.has(s.name)) throw new Error(`«${s.name}» нельзя примерить — только ${[...DRY_OK].join(", ")}`);
  sandbox = { project: structuredClone(base ?? JSON.parse(readFileSync(projectFile(dir), "utf8"))) };
  try {
    const results = [];
    for (const s of steps) results.push(await call(dir, s.name, s.args));
    return { results, project: sandbox.project };
  } finally {
    sandbox = null;
  }
}

export function listAll() {
  return [
    ...Object.values(COMMANDS).map((c) => ({ name: c.name, help: c.help, args: c.args })),
    ...Object.entries(NODE_COMMANDS).map(([name, c]) => ({ name, help: c.help, args: c.args })),
  ];
}

export { RECIPES };
