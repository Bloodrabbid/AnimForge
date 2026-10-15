// Чтение готовых клипов: glb/gltf — напрямую, FBX/BVH/DAE — через Blender в glb. Кадры — локальные повороты и сдвиги
// узлов с частотой fps (сэмплеры glTF: LINEAR, STEP, CUBICSPLINE). Скелет без скина (BVH) — узлы с анимацией и их
// потомки считаются костями.
import { NodeIO, type Document, type Node } from "@gltf-transform/core";
import { ALL_EXTENSIONS } from "@gltf-transform/extensions";
import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { extname, join } from "node:path";
import { qnorm, readSkeleton, type Quat, type Skeleton, type SourceFrame, type Vec3 } from "../../core/src/index.ts";

export interface Take {
  name: string;
  duration: number;
  frames: SourceFrame[];
}

function slerp(a: number[], b: number[], u: number): number[] {
  let d = a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3];
  const s = d < 0 ? -1 : 1;
  d *= s;
  if (d > 0.9995) return qnorm(a.map((x, k) => x + (s * b[k] - x) * u) as Quat);
  const th = Math.acos(d), sn = Math.sin(th);
  const wa = Math.sin((1 - u) * th) / sn, wb = (s * Math.sin(u * th)) / sn;
  return a.map((x, k) => wa * x + wb * b[k]);
}

export async function readAnimDoc(file: string, blender: string, env: NodeJS.ProcessEnv, bridge: string): Promise<Document> {
  // расширения glTF (unlit, texture_transform…) — у чужих файлов они бывают обязательными
  const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);
  const ext = extname(file).toLowerCase();
  if (ext === ".glb" || ext === ".gltf") return io.read(file);
  const out = join(mkdtempSync(join(tmpdir(), "af-anim-")), "anim.glb");
  const log = execFileSync(blender, ["-b", "--factory-startup", "--python", bridge, "--", file, out], { env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 64 << 20 });
  if (!log.includes("ANIM_OK")) throw new Error("Blender не прочитал клипы:\n" + log.split("\n").filter((l) => /ANIM|Error|Traceback/.test(l)).join("\n"));
  return io.read(out);
}

/** Скелет файла клипов: со скином — как у модели; без скина — анимированные узлы и их потомки. */
export function animSkeleton(doc: Document): Skeleton {
  const skel = uniqueNames(readSkeleton(doc));
  if (skel.nodes.some((n) => n.isJoint)) return mainTree(skel);
  const animated = new Set<string>();
  for (const a of doc.getRoot().listAnimations()) for (const c of a.listChannels()) { const n = c.getTargetNode(); if (n) animated.add(n.getName()); }
  const joint = new Set<string>();
  for (const n of skel.nodes) if (animated.has(n.name) || (n.parent && joint.has(n.parent))) joint.add(n.name);
  return mainTree({ nodes: skel.nodes.map((n) => ({ ...n, isJoint: joint.has(n.name) })) });
}

/** Одинаковые имена (меш и кость «Head», у роботов Quaternius) ломают поиск по имени: повторы не-костей — с суффиксом. */
function uniqueNames(skel: Skeleton): Skeleton {
  const par = skel.nodes.map((n, i) => {
    if (n.parent == null) return -1;
    for (let j = i - 1; j >= 0; j--) if (skel.nodes[j].name === n.parent) return j;
    return -1;
  });
  const count = new Map<string, number>();
  skel.nodes.forEach((n) => count.set(n.name, (count.get(n.name) ?? 0) + 1));
  if ([...count.values()].every((c) => c === 1)) return skel;
  const seen = new Map<string, number>();
  const names = skel.nodes.map((n) => {
    if (count.get(n.name)! === 1) return n.name;
    // кость сохраняет имя (на неё ссылаются анимации), остальные — с суффиксом
    const firstJoint = skel.nodes.find((m) => m.name === n.name && m.isJoint);
    if (firstJoint === n || (!firstJoint && !seen.has(n.name))) { seen.set(n.name, 1); return n.name; }
    const k = (seen.get(n.name) ?? 0) + 1;
    seen.set(n.name, k);
    return `${n.name}#${k}`;
  });
  return { nodes: skel.nodes.map((n, i) => ({ ...n, name: names[i], parent: par[i] >= 0 ? names[par[i]] : null })) };
}

/** Кости для распознавания: без управляющих корней — IK-цели ног у зверей Quaternius, полюса, контроллеры висят
 * отдельными корнями скелета, и с ними четвероногое не узнаётся. */
function mainTree(skel: Skeleton): Skeleton {
  // родитель — ближайший предыдущий узел с его именем (узлы идут в глубину, родитель раньше ребёнка): с одинаковыми
  // именами у меша и кости поиск по имени зациклился бы
  const par = skel.nodes.map((n, i) => {
    if (n.parent == null) return -1;
    for (let j = i - 1; j >= 0; j--) if (skel.nodes[j].name === n.parent) return j;
    return -1;
  });
  const jointParent = (i: number): number => {
    for (let p = par[i]; p >= 0; p = par[p]) if (skel.nodes[p].isJoint) return p;
    return -1;
  };
  const root = (i: number): number => { let r = i; for (let p = jointParent(i); p >= 0; p = jointParent(p)) r = p; return r; };
  const control = (i: number) => /(^|[^a-z])(ik|pole|target|ctrl|control)/i.test(skel.nodes[root(i)].name);
  return { nodes: skel.nodes.map((n, i) => ({ ...n, isJoint: n.isJoint && !control(i) })) };
}

/** Дубли файла: кадры с шагом 1/fps от 0 до конца дубля включительно. */
export function readTakes(doc: Document, fps = 30, only?: string[]): Take[] {
  const out: Take[] = [];
  for (const a of doc.getRoot().listAnimations()) {
    if (only?.length && !only.includes(a.getName())) continue;
    const chans = a.listChannels().flatMap((c) => {
      const n = c.getTargetNode() as Node | null, s = c.getSampler(), path = c.getTargetPath();
      if (!n || !s || (path !== "rotation" && path !== "translation")) return [];
      const times = Array.from(s.getInput()!.getArray()!), vals = Array.from(s.getOutput()!.getArray()!);
      return [{ name: n.getName(), path, times, vals, interp: s.getInterpolation(), w: path === "rotation" ? 4 : 3 }];
    });
    if (!chans.length) continue;
    const t0 = Math.min(...chans.map((c) => c.times[0])), t1 = Math.max(...chans.map((c) => c.times[c.times.length - 1]));
    // кадры по 1/fps и последний — точно в конце дубля (как frameTimes): время не растягивается
    const span = t1 - t0, full = Math.floor(span * fps + 1e-6);
    const ts = Array.from({ length: full + 1 }, (_, k) => k / fps);
    if (span - ts[full] > 1e-6) ts.push(span);
    const frames: SourceFrame[] = [];
    for (const dt of ts) {
      const t = t0 + dt;
      const fr: SourceFrame = { t: dt, rot: {}, pos: {} };
      for (const c of chans) {
        const T = c.times, cub = c.interp === "CUBICSPLINE";
        const at = (k: number) => (cub ? c.vals.slice((3 * k + 1) * c.w, (3 * k + 2) * c.w) : c.vals.slice(k * c.w, (k + 1) * c.w));
        let k = 0;
        while (k < T.length - 1 && T[k + 1] <= t) k++;
        let v: number[];
        if (k >= T.length - 1 || t <= T[0]) v = at(t <= T[0] ? 0 : T.length - 1);
        else {
          const u = c.interp === "STEP" ? 0 : (t - T[k]) / (T[k + 1] - T[k]);
          const a0 = at(k), a1 = at(k + 1);
          v = c.path === "rotation" ? slerp(a0, a1, u) : a0.map((x, j) => x + (a1[j] - x) * u);
        }
        if (c.path === "rotation") fr.rot[c.name] = qnorm(v as Quat);
        else fr.pos[c.name] = v as Vec3;
      }
      frames.push(fr);
    }
    out.push({ name: a.getName(), duration: span, frames });
  }
  return out;
}
