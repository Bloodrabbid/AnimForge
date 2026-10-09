// make — от модели до готового файла одним вызовом: проект и риг (если их нет), клипы из пресетов библиотеки
// (по имени или по словам), анатомические пределы, glb, видео всех клипов с подписями, копия в игру на Godot.
// Сомнительный риг — остановка с картинкой модели, дальше только с force.
import { NodeIO } from "@gltf-transform/core";
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { categoryOf, clipSteps, libRoles, missingChains, parseClips, searchPresets, uniqueClipName, type LibRecipe, type StyleCard } from "../../core/src/index.ts";
import { checkProject } from "./checks.ts";
import { loadSkinScene } from "./skin.ts";
import { NODE_COMMANDS, call, exportGlb, loadCtx, loadPresets, projectFile, renderSheet, renderVideo, saveProject } from "./node.ts";

export interface MadeClip {
  name: string;
  preset: string;
  recipe: string;
  how: "по имени" | "по словам";
  query: string;
  duration: number;
  loop: boolean;
  alternatives?: string[];
  warning?: string;
}

const home = (p: string) => (p.startsWith("~/") ? join(homedir(), p.slice(2)) : p);

/** Папка проекта Godot (с project.godot) над путём — или null. */
function godotRoot(p: string): string | null {
  for (let d = p; d !== dirname(d); d = dirname(d)) if (existsSync(join(d, "project.godot"))) return d;
  return null;
}

/** Ракурс видео по телу: персонажей — спереди в три четверти, тела-линии — сбоку сверху. */
const viewFor = (body: string) => (["biped", "winged", "quadruped", "multileg"].includes(body) ? "front_3q" : "three_quarter");

export async function make(dir: string, a: Record<string, any>) {
  const notes: string[] = [];
  let fresh = false;
  if (!existsSync(projectFile(dir))) {
    if (!a.file) throw new Error(`в ${dir} нет проекта — укажите file (модель)`);
    await NODE_COMMANDS["project.new"].run(dir, { file: a.file, name: a.name });
    fresh = true;
  } else if (a.file) notes.push("проект уже есть — file не используется (риг прежний)");

  // карточка стиля и папка игры запоминаются в проекте: дальше их не передают
  {
    const ctx = await loadCtx(dir);
    if (a.style) ctx.project.style = { ...ctx.project.style, ...(a.style as StyleCard) };
    if (a.godot) ctx.project.godot = resolve(home(a.godot));
    saveProject(dir, ctx.project);
  }
  const det = (await NODE_COMMANDS["rig.detect"].run(dir, { write: false })) as { body: string; paws?: string[] };
  let ctx = await loadCtx(dir);
  const { chains } = ctx.project;
  const body = det.body ?? "other";

  // сомнительный риг: дальше не идём, показываем модель и что нашлось
  const meshes = loadSkinScene(await new NodeIO().read(join(dir, ctx.project.model))).parts.length;
  if (!meshes) return { stopped: "model", reason: "в модели нет мешей — только скелет; нужен файл с телом", body, chains: Object.keys(chains), fresh };
  const doubt = !Object.keys(chains).length
    ? "скелет не распознан: ни одной цепочки"
    : body === "other" && !chains.body && !chains.spine
      ? "тело не узнано (не двуногое, не четвероногое, не рыба/змея) и нет цепочки вдоль тела"
      : null;
  if (doubt && !a.force) {
    const pic = resolve(dir, "out/make-rig.png");
    ctx.project.clips.push({ name: "_rest", duration: 1, fps: 30, loop: false, layers: [] }); // только для картинки, не сохраняется
    await renderSheet(ctx, "_rest", 2, viewFor(body), pic);
    if (a.send) send([pic], `AnimForge: риг под вопросом — ${doubt}`);
    return { stopped: "rig", reason: doubt, body, chains: Object.keys(chains), picture: pic, next: "проверьте картинку; продолжить как есть — тот же make с force: true", fresh };
  }

  // клипы
  const lib: LibRecipe[] = loadPresets().map((l) => ({ recipe: l.recipe, roles: libRoles(l.recipe), presets: l.presets }));
  const made: MadeClip[] = [], missing: { query: string; reason: string }[] = [];
  const taken: string[] = [];
  for (const req of parseClips(String(a.clips ?? ""))) {
    let pick: { recipe: string; preset: LibRecipe["presets"][number]; clip: string } | undefined;
    let how: MadeClip["how"] = "по имени", alternatives: string[] | undefined;
    const exact = lib.flatMap((l) => l.presets.map((p) => ({ l, p }))).find(({ p }) => p.name === req.query);
    if (exact) {
      const miss = missingChains(exact.l.roles, chains);
      if (miss.length) { missing.push({ query: req.query, reason: `пресет не подходит этому скелету: нет цепочек ${miss.join(", ")}` }); continue; }
      pick = { recipe: exact.l.recipe, preset: exact.p, clip: categoryOf(exact.l.recipe) === "fight" ? "attack" : exact.p.name };
    } else {
      const found = searchPresets(req.query, lib, chains, body, ctx.project.style);
      if (!found.length) { missing.push({ query: req.query, reason: "в библиотеке нет подходящего этому телу" }); continue; }
      pick = found[0];
      how = "по словам";
      alternatives = found.slice(1, 4).map((f) => f.preset.name);
    }
    const name = uniqueClipName({ ...ctx.project, clips: ctx.project.clips.filter((c) => c.name !== (req.name ?? pick.clip)) }, req.name ?? pick.clip, taken);
    taken.push(name);
    // клип с тем же именем заменяется: make можно звать повторно с правками
    if (ctx.project.clips.some((c) => c.name === name)) await call(dir, "clip.remove", { clip: name });
    let warning: string | undefined;
    for (const s of clipSteps({ recipe: pick.recipe, preset: pick.preset, name, chains, paws: det.paws, params: req.params, fps: ctx.project.style?.fps })) {
      const r = (await call(dir, s.name, s.args)) as { warning?: string };
      if (r?.warning) warning = r.warning;
    }
    ctx = await loadCtx(dir);
    const clip = ctx.project.clips.find((c) => c.name === name)!;
    made.push({ name, preset: pick.preset.name, recipe: pick.recipe, how, query: req.query, duration: clip.duration, loop: clip.loop, ...(alternatives?.length ? { alternatives } : {}), ...(warning ? { warning } : {}) });
  }

  // анатомия: колени и локти в свою сторону — если пределов ещё нет
  if (!Object.keys(ctx.project.limits ?? {}).length) {
    try {
      await call(dir, "limit.auto", {});
    } catch (e) {
      notes.push(`пределы не поставлены: ${(e as Error).message}`);
    }
  }
  // автопроверки по коже модели; что умеют — чинят (ослабить рвущий слой, стопы на пол), остальное — в отчёт
  const checks = made.length && a.check !== false ? await checkProject(dir, made.map((m) => m.name), true) : [];
  ctx = await loadCtx(dir);

  const pub = await publish(dir, a.out);
  notes.push(...pub.notes);
  const { glb, godot } = pub;

  let video: string | undefined;
  if (a.video !== false && made.length) {
    const tmp = mkdtempSync(join(tmpdir(), "af-make-"));
    try {
      const parts: string[] = [];
      for (const [i, m] of made.entries()) {
        const part = join(tmp, `${i}.mp4`);
        const loops = m.loop ? Math.max(1, Math.ceil(2 / m.duration)) : 1;
        await renderVideo(ctx, m.name, a.view ?? viewFor(body), loops, 1, part, `${m.name} · ${m.preset}`);
        parts.push(part);
      }
      video = resolve(dir, `out/${ctx.project.name}.mp4`);
      mkdirSync(dirname(video), { recursive: true });
      // у кусков разная частота кадров (кадры клипа на его длительность) — склеиваем фильтром с перекодированием в 30 к/с
      const inputs = parts.flatMap((p) => ["-i", p]);
      const filter = parts.map((_, i) => `[${i}:v]fps=30,setsar=1[v${i}]`).join(";") + ";" + parts.map((_, i) => `[v${i}]`).join("") + `concat=n=${parts.length}:v=1:a=0[out]`;
      execFileSync("ffmpeg", ["-y", "-loglevel", "error", ...inputs, "-filter_complex", filter, "-map", "[out]", "-pix_fmt", "yuv420p", video]);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  }

  // пакет для критика (critic/CRITIC.md): когда автопроверки нашли брак или о нём попросили. Критик — отдельный агент
  let review: string | undefined;
  if (made.length && a.review !== false && (a.review || checks.some((r) => !r.ok))) review = ((await NODE_COMMANDS["review.pack"].run(dir, { clip: made.map((m) => m.name).join(",") })) as { dir: string }).dir;
  if (review) notes.push(`пакет для критика: ${review} (правила — critic/CRITIC.md)`);

  const summary = [
    `${ctx.project.name}: ${made.length} клип(ов)${missing.length ? `, не найдено ${missing.length}` : ""}`,
    ...made.map((m) => `• ${m.name} — ${m.preset} (${m.how}${m.alternatives ? `; ещё: ${m.alternatives.join(", ")}` : ""})`),
    ...missing.map((m) => `• «${m.query}» — ${m.reason}`),
    ...checks.flatMap((r) => r.findings.map((f) => `${f.level === "fail" ? "✗" : "△"} ${r.clip}: ${f.msg}${f.fixed ? ` (починено: ${f.fixed})` : ""}`)),
    ...notes.map((n) => `! ${n}`),
  ].join("\n");
  if (a.send) send([video, glb].filter(Boolean) as string[], summary);
  return { dir, fresh, body, clips: made, missing, checks, review, glb, godot, video, style: ctx.project.style, notes, summary };
}

/** Запечь glb (out/<имя>.glb) и положить копию в игру на Godot, если папка игры записана в проекте. */
export async function publish(dir: string, out?: string) {
  const ctx = await loadCtx(dir);
  const notes: string[] = [];
  const glb = resolve(dir, out ?? `out/${ctx.project.name}.glb`);
  const exp = await exportGlb(ctx, glb);
  if (exp.warning) notes.push(exp.warning);
  let godot: string | undefined;
  if (ctx.project.godot) {
    mkdirSync(ctx.project.godot, { recursive: true });
    godot = join(ctx.project.godot, basename(glb));
    copyFileSync(glb, godot);
    for (const ext of [".events.json", ".af.json"]) {
      const f = glb.replace(/\.glb$/, ext);
      if (existsSync(f)) copyFileSync(f, join(ctx.project.godot, basename(f)));
    }
    if (!godotRoot(ctx.project.godot)) notes.push(`${ctx.project.godot} не внутри проекта Godot (нет project.godot выше) — файл положен, но игра его не увидит`);
  }
  return { glb, godot, notes };
}

/** В Telegram владельцу (harbor-send): видео и glb с подписью-отчётом. */
function send(files: string[], caption: string) {
  try {
    execFileSync("harbor-send", ["-c", caption.slice(0, 1000), ...files], { stdio: "ignore" });
  } catch {
    /* нет harbor-send — не беда, файлы на диске */
  }
}
