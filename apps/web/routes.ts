// API веб-интерфейса без привязки к транспорту: один и тот же обработчик работает в dev-сервере (server.ts, настоящий
// диск) и в Service Worker сайта (sw/sw.ts, виртуальная файловая система в памяти браузера).
// Логики анимации здесь нет: проект читается через loadCtx, любое действие — call() из packages/cli/src/node.ts.
import { copyFileSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { NodeIO } from "@gltf-transform/core";
import { tmpdir } from "node:os";
import { join, relative, resolve, sep } from "node:path";
import { bodyFrame, buildRig, clipSteps, importPlan, libRoles, vdot } from "../../packages/core/src/index.ts";
import { RECIPES, ROOT, call, clipPacks, dryRun, exportFile, findPreset, loadCtx, loadPresets, projectFile } from "../../packages/cli/src/node.ts";
import { stickAnim } from "../../packages/cli/src/stickpreview.ts";

export class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

export interface Req {
  method: string;
  url: URL;
  headers: Record<string, string | undefined>;
  /** тело запроса целиком */
  body: Uint8Array;
}

export type Reply = { status: number; json: unknown } | { status: number; bytes: Uint8Array; type: string; filename?: string };

/** Хуки окружения. Сайт подставляет свои: подгрузка файлов библиотеки по сети и импорт модели без Blender. */
export const env = {
  /** файл из репозитория нужен на «диске» — в браузере его докачивают, на маке он уже есть */
  ensure: async (_abs: string): Promise<void> => {},
  /** новый проект из файла модели (на маке — project.new через Blender) */
  newProject: async (dir: string, file: string, name: string): Promise<{ detect?: { body?: string } }> =>
    (await call(dir, "project.new", { file, name })) as { detect?: { body?: string } },
  /** проекты, которых ещё нет на «диске», но которые можно открыть (сайт докачивает демо-проекты по требованию) */
  projects: (): string[] => [],
  /** папка проекта нужна на «диске» целиком (сайт докачивает демо-проект при первом открытии) */
  ensureDir: async (_rel: string): Promise<void> => {},
  /** проект изменился (сайт сохраняет его в хранилище браузера) */
  changed: async (_dir: string): Promise<void> => {},
};

const json = (status: number, body: unknown): Reply => ({ status, json: body });
const file = (bytes: Uint8Array, type: string, filename?: string): Reply => ({ status: 200, bytes, type, filename });

let clipCache: unknown[] | undefined;
const stickCache = new Map<string, string>();

/** Папка проекта из запроса — только внутри репозитория и только там, где лежит animforge.json. */
export function projectDir(raw: string | null | undefined): string {
  if (!raw) throw new HttpError(400, "нужен параметр dir, например projects/fish-demo");
  const dir = resolve(ROOT, raw);
  if (dir !== ROOT && !dir.startsWith(ROOT + sep)) throw new HttpError(400, "dir должен быть внутри репозитория");
  if (!existsSync(projectFile(dir))) throw new HttpError(404, `нет проекта: ${relative(ROOT, dir)}/animforge.json`);
  return dir;
}

function parse(req: Req): any {
  const text = new TextDecoder().decode(req.body);
  try {
    return text ? JSON.parse(text) : {};
  } catch {
    throw new HttpError(400, "тело запроса — не JSON");
  }
}

// Команды выполняются строго по очереди: каждая читает файл, меняет и пишет — параллельные затёрли бы друг друга.
let queue: Promise<unknown> = Promise.resolve();
export function serial<T>(fn: () => Promise<T>): Promise<T> {
  const p = queue.then(fn, fn);
  queue = p.catch(() => {});
  return p;
}

/** Паки клипов, которые понадобятся шагам (clip.import из пака), — докачать заранее. */
async function ensureSteps(steps: { name: string; args?: Record<string, any> }[]) {
  for (const s of steps) {
    if (s.name !== "clip.import" || !s.args?.pack) continue;
    const pack = clipPacks().find((p) => p.id === s.args!.pack);
    if (pack) await env.ensure(join(ROOT, "library/clips", pack.file));
  }
}

export async function handle(req: Req): Promise<Reply> {
  const { url } = req;
  // проект из запроса (dir в адресе или в теле) — докачать, если это ещё не открытый демо-проект
  const rawDir = url.searchParams.get("dir") ?? (req.body.length && req.body[0] === 123 ? (() => { try { return JSON.parse(new TextDecoder().decode(req.body)).dir; } catch { return undefined; } })() : undefined);
  if (typeof rawDir === "string" && !rawDir.includes("..")) await env.ensureDir(rawDir.replace(/^\/+|\/+$/g, ""));
  const path = url.pathname.replace(/^.*\/api\//, "/api/");
  const q = (k: string) => url.searchParams.get(k);
  if (req.method === "GET" && path === "/api/project") {
    const dir = projectDir(q("dir"));
    const ctx = await loadCtx(dir);
    return json(200, { dir: relative(ROOT, dir), project: ctx.project, skeleton: ctx.skeleton });
  }
  if (req.method === "POST" && path === "/api/command") {
    const body = parse(req);
    const dir = projectDir(body.dir);
    if (typeof body.name !== "string") throw new HttpError(400, "нужно имя команды: name");
    try {
      await ensureSteps([body]);
      const result = await serial(() => call(dir, body.name, body.args ?? {}));
      await env.changed(dir);
      return json(200, { ok: true, result });
    } catch (e: any) {
      return json(400, { ok: false, error: String(e?.message ?? e) });
    }
  }
  if (req.method === "POST" && path === "/api/preview") {
    // примерка: шаги выполняются на копии проекта (body.project или с диска), ответ — получившийся проект, диск не трогается
    const body = parse(req);
    const dir = projectDir(body.dir);
    try {
      await ensureSteps(body.steps ?? []);
      const r = await serial(() => dryRun(dir, body.steps ?? [], body.project));
      return json(200, { ok: true, ...r });
    } catch (e: any) {
      return json(400, { ok: false, error: String(e?.message ?? e) });
    }
  }
  if (req.method === "POST" && path === "/api/upload") {
    // своя модель перетаскиванием: файл телом запроса, имя в заголовке → новый проект в out/uploads (в git не попадает)
    const raw = decodeURIComponent(String(req.headers["x-filename"] ?? ""));
    const ext = raw.match(/\.(glb|gltf|fbx|dae|afproj)$/i)?.[0].toLowerCase();
    if (!ext) throw new HttpError(400, "нужен файл .glb, .gltf (одним файлом), .fbx, .dae или проект .afproj");
    if (req.body.length > 300 << 20) throw new HttpError(413, "файл больше 300 МБ");
    const base = raw.replace(/\.[^.]+$/, "").replace(/[^\p{L}\p{N}_-]+/gu, "_").replace(/^_+|_+$/g, "").slice(0, 40) || "model";
    let rel = `out/uploads/${base}`;
    for (let i = 2; existsSync(join(ROOT, rel)); i++) rel = `out/uploads/${base}-${i}`;
    const tmp = mkdtempSync(join(tmpdir(), "af-up-"));
    try {
      const src = join(tmp, `source${ext}`);
      writeFileSync(src, req.body);
      // проект одним файлом — распаковать как есть; модель — новый проект
      if (ext === ".afproj") {
        await serial(() => call(join(ROOT, rel), "project.unpack", { file: src }));
        await env.changed(join(ROOT, rel));
        return json(200, { ok: true, dir: rel });
      }
      const r = await serial(() => env.newProject(join(ROOT, rel), src, base));
      await env.changed(join(ROOT, rel));
      return json(200, { ok: true, dir: rel, body: r.detect?.body });
    } catch (e: any) {
      return json(400, { ok: false, error: String(e?.message ?? e).split("\n").slice(0, 6).join("\n") });
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  }
  if (req.method === "POST" && path === "/api/weights") {
    // веса кожи из редактора: для каждого примитива — индексы костей и веса по 4 на вершину (порядок вершин и
    // костей — как в glb: GLTFLoader их не переставляет). Первая запись сохраняет исходник рядом: <модель>.orig.glb
    const body = parse(req);
    const dir = projectDir(body.dir);
    const project = JSON.parse(readFileSync(projectFile(dir), "utf8"));
    const model = resolve(dir, project.model);
    const orig = model.replace(/\.glb$/i, ".orig.glb");
    if (body.restore) {
      if (!existsSync(orig)) throw new HttpError(400, "исходных весов нет — модель ещё не правили");
      await serial(async () => copyFileSync(orig, model));
      await env.changed(dir);
      return json(200, { ok: true, restored: true });
    }
    const io = new NodeIO();
    const result = await serial(async () => {
      const doc = await io.read(model);
      const meshes = doc.getRoot().listMeshes();
      const buf = doc.getRoot().listBuffers()[0];
      let changed = 0;
      for (const part of body.parts ?? []) {
        const prim = meshes[part.mesh]?.listPrimitives()[part.primitive];
        if (!prim) throw new HttpError(400, `нет примитива ${part.mesh}/${part.primitive}`);
        const n = prim.getAttribute("POSITION")!.getCount();
        if (part.joints.length !== n * 4 || part.weights.length !== n * 4) throw new HttpError(400, `${part.mesh}/${part.primitive}: ждали ${n * 4} значений`);
        const old = [prim.getAttribute("JOINTS_0"), prim.getAttribute("WEIGHTS_0")];
        prim.setAttribute("JOINTS_0", doc.createAccessor().setType("VEC4").setBuffer(buf).setArray(new Uint16Array(part.joints)));
        prim.setAttribute("WEIGHTS_0", doc.createAccessor().setType("VEC4").setBuffer(buf).setArray(new Float32Array(part.weights)));
        for (const a of old) if (a && a.listParents().every((x) => x === doc.getRoot())) a.dispose(); // старые веса больше никому не нужны
        changed++;
      }
      if (!existsSync(orig)) copyFileSync(model, orig);
      await io.write(model, doc);
      return changed;
    });
    await env.changed(dir);
    return json(200, { ok: true, parts: result });
  }
  if (req.method === "POST" && path === "/api/autorig") {
    // скелет заново по ручным точкам (model.autorig с markers) поверх модели проекта, затем rig.detect.
    // Прежняя модель — рядом, <модель>.prerig.glb; правленые веса (.orig.glb) к новому скелету уже не относятся
    const body = parse(req);
    const dir = projectDir(body.dir);
    const project = JSON.parse(readFileSync(projectFile(dir), "utf8"));
    const model = resolve(dir, project.model);
    const r = await serial(async () => {
      const tmp = mkdtempSync(join(tmpdir(), "af-rig-"));
      try {
        const src = join(tmp, "source.glb");
        copyFileSync(model, src);
        const out = (await call(dir, "model.autorig", { file: src, out: project.model, markers: body.markers, forward: project.forward ?? [0, 0, 1], count: body.count ?? 5 })) as { log: string };
        copyFileSync(src, model.replace(/\.glb$/i, ".prerig.glb"));
        rmSync(model.replace(/\.glb$/i, ".orig.glb"), { force: true });
        const detect = (await call(dir, "rig.detect", {})) as { body?: string };
        return { log: out.log, body: detect.body };
      } finally {
        rmSync(tmp, { recursive: true, force: true });
      }
    });
    await env.changed(dir);
    return json(200, { ok: true, ...r });
  }
  if (req.method === "GET" && path === "/api/library") {
    // пресеты с происхождением и что нужно рецепту от скелета: роли → цепочки
    const lib = loadPresets().map((l) => ({ recipe: l.recipe, help: RECIPES[l.recipe]?.help ?? "", roles: libRoles(l.recipe), presets: l.presets }));
    return json(200, lib);
  }
  if (req.method === "GET" && path === "/api/clips") {
    // библиотека готовых клипов: паки с происхождением и дубли (имя, длина) — для clip.import.
    // Готовый список (library/clips/takes.json, его пишет сборка сайта) избавляет от чтения всех паков
    const index = join(ROOT, "library/clips/takes.json");
    if (!clipCache && existsSync(index)) clipCache = JSON.parse(readFileSync(index, "utf8"));
    clipCache ??= await clipTakes();
    return json(200, clipCache);
  }
  if (req.method === "GET" && path === "/api/projects") {
    // все проекты внутри репозитория: projects/* и out/*/* (тестовые с чужими моделями)
    const found: string[] = [];
    const scan = (rel: string, depth: number) => {
      const abs = join(ROOT, rel);
      if (!existsSync(abs)) return;
      for (const e of readdirSync(abs, { withFileTypes: true })) {
        if (!e.isDirectory() || e.name.startsWith(".") || e.name === "node_modules") continue;
        const r = `${rel}/${e.name}`;
        if (existsSync(projectFile(join(ROOT, r)))) found.push(r);
        else if (depth > 1) scan(r, depth - 1);
      }
    };
    scan("projects", 1);
    scan("out", 2);
    for (const d of env.projects()) if (!found.includes(d)) found.push(d);
    found.sort((a, b) => Number(b.startsWith("out/uploads/")) - Number(a.startsWith("out/uploads/")) || (a < b ? -1 : 1)); // свои модели — первыми
    return json(200, found);
  }
  if (req.method === "GET" && path === "/api/download") {
    // запечь все клипы в glb или FBX (format=fbx, units, names — как у команды export) и отдать файлом
    const dir = projectDir(q("dir"));
    const fbx = q("format") === "fbx";
    const names = q("names") || undefined;
    const tmp = mkdtempSync(join(tmpdir(), "af-dl-"));
    try {
      const ctx = await loadCtx(dir);
      const base = `${ctx.project.name || "animforge"}${names ? "_" + names : ""}.${fbx ? "fbx" : "glb"}`;
      const out = join(tmp, base);
      await serial(() => exportFile(ctx, out, names, fbx ? q("units") || undefined : undefined));
      return file(readFileSync(out), fbx ? "application/octet-stream" : "model/gltf-binary", base);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  }
  if (req.method === "POST" && path === "/api/mapping") {
    // сопоставление костей бок о бок: скелет пака (источник) и модели проекта в покое (вид спереди, 2D), пары —
    // найденные сами и ручные (body.map), как их увидит clip.import
    const body = parse(req);
    const dir = projectDir(body.dir);
    const pack = clipPacks().find((p) => p.id === body.pack);
    if (!pack) throw new HttpError(400, "нет пака");
    await env.ensure(join(ROOT, "library/clips", pack.file));
    const { ALL_EXTENSIONS } = await import("@gltf-transform/extensions");
    const { animSkeleton } = await import("../../packages/cli/src/animfile.ts");
    const { detectSide } = await import("../../packages/cli/src/node.ts");
    const doc = await new NodeIO().registerExtensions(ALL_EXTENSIONS).read(join(ROOT, "library/clips", pack.file));
    const src = detectSide(animSkeleton(doc));
    const ctx = await loadCtx(dir);
    const dst = { project: ctx.project, rig: buildRig(ctx.skeleton) };
    const auto = importPlan(src, dst).from;
    let plan;
    try {
      plan = importPlan(src, dst, body.map ?? {}).from;
    } catch (e: any) {
      return json(400, { ok: false, error: String(e?.message ?? e) });
    }
    const view = (s: { project: any; rig: ReturnType<typeof buildRig> }) => {
      const f = bodyFrame(s.project);
      const js = s.rig.skel.nodes.flatMap((n, i) => (n.isJoint ? [i] : []));
      const pts = js.map((i) => [vdot(s.rig.worldT[i], f.side), vdot(s.rig.worldT[i], f.up)]);
      const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
      const sc = Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys), 1e-6) * 1.1;
      const cx = (Math.max(...xs) + Math.min(...xs)) / 2, cy = (Math.max(...ys) + Math.min(...ys)) / 2;
      const slot = new Map(js.map((j, k) => [j, k]));
      const parent = js.map((j) => { let p = s.rig.parent[j]; while (p >= 0 && !slot.has(p)) p = s.rig.parent[p]; return p >= 0 ? slot.get(p)! : -1; });
      const chainOf = js.map((j) => Object.entries(s.project.chains as Record<string, string[]>).find(([, c]) => c.includes(s.rig.skel.nodes[j].name))?.[0] ?? null);
      return { names: js.map((j) => s.rig.skel.nodes[j].name), parent, chain: chainOf, pos: pts.map(([x, y]) => [+(0.5 + (x - cx) / sc).toFixed(4), +(0.5 - (y - cy) / sc).toFixed(4)]), slot };
    };
    const S = view(src), D = view(dst);
    const pairs = [...plan].flatMap(([j, i]) => (S.slot.has(i) && D.slot.has(j) ? [{ src: S.slot.get(i)!, dst: D.slot.get(j)!, manual: auto.get(j) !== i }] : []));
    const strip = ({ slot, ...v }: ReturnType<typeof view>) => v;
    return json(200, { ok: true, src: strip(S), dst: strip(D), pairs });
  }
  if (req.method === "GET" && path === "/api/stick") {
    // живое превью для карточки библиотеки: пресет (preset) или готовый клип (pack + take) на скелете модели проекта —
    // шаги примерки на копии проекта, кадры суставов в 2D; кэш по проекту и движению
    const dir = projectDir(q("dir"));
    const preset = q("preset"), pack = q("pack"), take = q("take");
    const key = `${dir}|${statSync(projectFile(dir)).mtimeMs}|${preset}|${pack}|${take}`;
    let hit = stickCache.get(key);
    if (!hit) {
      if (pack) await ensureSteps([{ name: "clip.import", args: { pack } }]);
      hit = await serial(async () => {
        const name = "__preview";
        let steps: { name: string; args: Record<string, unknown> }[];
        const ctx = await loadCtx(dir);
        if (preset) {
          const { recipe, preset: pr } = findPreset(preset);
          const det = (await call(dir, "rig.detect", { write: false })) as { paws?: string[] };
          steps = clipSteps({ recipe, preset: pr, name, chains: ctx.project.chains, paws: det.paws });
        } else if (pack && take) steps = [{ name: "clip.import", args: { pack, take, as: name } }];
        else throw new HttpError(400, "нужен preset или pack и take");
        const r = await dryRun(dir, steps);
        const clip = r.project.clips.find((c: { name: string }) => c.name === name)!;
        return JSON.stringify(stickAnim(r.project, ctx.skeleton, clip));
      });
      if (stickCache.size > 400) stickCache.clear();
      stickCache.set(key, hit);
    }
    return json(200, JSON.parse(hit));
  }
  if (req.method === "GET" && path === "/api/pack") {
    // проект одним файлом (project.pack) — скачать
    const dir = projectDir(q("dir"));
    const tmp = mkdtempSync(join(tmpdir(), "af-pack-"));
    try {
      const r = (await serial(() => call(dir, "project.pack", { out: join(tmp, "p.afproj") }))) as { out: string };
      const name = `${JSON.parse(readFileSync(projectFile(dir), "utf8")).name || "project"}.afproj`;
      return file(readFileSync(r.out), "application/zip", name);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  }
  if (req.method === "GET" && path === "/api/directions") {
    // восемь направлений одним архивом (export.directions): файлы, общий файл и BlendSpace2D; проект не меняется
    const dir = projectDir(q("dir"));
    const clip = q("clip") ?? "";
    const tmp = mkdtempSync(join(tmpdir(), "af-8dir-dl-"));
    try {
      const out = join(tmp, `${clip}_8dir.zip`);
      await serial(() => call(dir, "export.directions", { clip, out, format: q("format") || "glb" }));
      return file(readFileSync(out), "application/zip", `${clip}_8dir.zip`);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  }
  if (req.method === "GET" && path === "/api/prop") {
    // проп во вьюпорт: glb, где корень — держатель с локальным сдвигом и поворотом под костью (как в экспорте)
    const dir = projectDir(q("dir"));
    const ctx = await loadCtx(dir);
    const p = ctx.project.props?.find((x) => x.id === q("id"));
    if (!p) throw new HttpError(404, "нет пропа");
    const { propDoc, propLocal } = await import("../../packages/cli/src/props.ts");
    const io = new NodeIO();
    const doc = await propDoc(io, dir, p);
    const { t, r, s: sc } = propLocal(buildRig(ctx.skeleton), p);
    const scene = doc.getRoot().getDefaultScene() ?? doc.getRoot().listScenes()[0];
    const holder = doc.createNode(`prop_${p.id}`).setTranslation(t).setRotation(r).setScale(sc);
    for (const c of scene.listChildren()) { scene.removeChild(c); holder.addChild(c); }
    scene.addChild(holder);
    return file(await io.writeBinary(doc), "model/gltf-binary");
  }
  if (req.method === "GET" && path === "/api/model") {
    const dir = projectDir(q("dir"));
    const project = JSON.parse(readFileSync(projectFile(dir), "utf8"));
    const model = resolve(dir, project.model);
    if (!existsSync(model)) throw new HttpError(404, `нет модели ${project.model}`);
    return file(readFileSync(model), "model/gltf-binary");
  }
  throw new HttpError(404, `нет такого API: ${req.method} ${path}`);
}

/** Дубли всех паков (имя, длина) — чтение каждого glb. Сборка сайта сохраняет результат в library/clips/takes.json. */
export async function clipTakes() {
  return Promise.all(
    clipPacks().map(async (p) => {
      const doc = await new NodeIO().read(join(ROOT, "library/clips", p.file));
      const takes = doc.getRoot().listAnimations().map((a) => ({
        name: a.getName(),
        duration: +Math.max(0, ...a.listSamplers().map((s) => s.getInput()?.getMax([])[0] ?? 0)).toFixed(3),
      }));
      return { ...p, takes };
    }),
  );
}

/** Ошибка → ответ, как раньше отвечал сервер. */
export function failure(e: any): Reply {
  return json(e instanceof HttpError ? e.status : 500, { ok: false, error: String(e?.message ?? e) });
}
