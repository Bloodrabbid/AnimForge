// Пропсы в руках (prop.attach): свой glb или коробка-заглушка крепится к кости — в экспорт glb (узел-ребёнок кости,
// Godot делает из него BoneAttachment3D, Blender — дочерний объект кости) и во вьюпорт редактора. Смещение и поворот
// задаются в осях мира позы покоя (как у целей констрейнов), размер — в метрах, независимо от масштаба кости.
import { Document, NodeIO, type Node } from "@gltf-transform/core";
import { mergeDocuments, unpartition } from "@gltf-transform/functions";
import { resolve } from "node:path";
import { DEG, qaxis, qinv, qmul, qnorm, qrot, standardNames, type Prop, type Project, type Quat, type Rig, type Vec3 } from "../../core/src/index.ts";

const vdiv = (a: Vec3, b: Vec3): Vec3 => [a[0] / b[0], a[1] / b[1], a[2] / b[2]];

/** Поворот из углов (°) вокруг мировых X, затем Y, затем Z. */
export function eulerQuat(r: Vec3 = [0, 0, 0]): Quat {
  return qnorm(qmul(qaxis([0, 0, 1], r[2] * DEG), qmul(qaxis([0, 1, 0], r[1] * DEG), qaxis([1, 0, 0], r[0] * DEG))));
}

/** Кость кисти: по стандартным именам (ребёнок последней кости руки), без кисти — сама последняя кость руки. */
export function handBone(project: Project, rig: Rig, side: "l" | "r"): string | undefined {
  const std = [...standardNames(project, rig, "unreal")].find(([, n]) => n === `hand_${side}`)?.[0];
  return std ?? project.chains[`arm_${side}`]?.at(-1);
}

/** Локальный сдвиг, поворот и масштаб держателя пропа под костью: смещение и поворот — в мировых осях покоя. */
export function propLocal(rig: Rig, p: Prop): { t: Vec3; r: Quat; s: Vec3 } {
  const i = rig.index.get(p.bone)!;
  const R = rig.worldR[i], S = rig.worldS[i];
  return { t: vdiv(qrot(qinv(R), p.offset ?? [0, 0, 0]), S), r: qnorm(qmul(qinv(R), eulerQuat(p.rot))), s: [1 / S[0], 1 / S[1], 1 / S[2]] };
}

/** Коробка-заглушка: size — по осям X, Y, Z пропа, м; центр — в начале координат пропа. */
export function boxDoc(size: Vec3 = [0.04, 0.04, 0.6], color: [number, number, number] = [0.55, 0.42, 0.3]): Document {
  const doc = new Document();
  const buf = doc.createBuffer();
  const [x, y, z] = size.map((v) => v / 2);
  const pos: number[] = [], nor: number[] = [], idx: number[] = [];
  const face = (n: Vec3, u: Vec3, v: Vec3) => {
    const k = pos.length / 3;
    for (const [a, b] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
      pos.push(n[0] * x + a * u[0] * x + b * v[0] * x, n[1] * y + a * u[1] * y + b * v[1] * y, n[2] * z + a * u[2] * z + b * v[2] * z);
      nor.push(...n);
    }
    idx.push(k, k + 1, k + 2, k, k + 2, k + 3);
  };
  face([1, 0, 0], [0, 1, 0], [0, 0, 1]); face([-1, 0, 0], [0, 0, 1], [0, 1, 0]);
  face([0, 1, 0], [0, 0, 1], [1, 0, 0]); face([0, -1, 0], [1, 0, 0], [0, 0, 1]);
  face([0, 0, 1], [1, 0, 0], [0, 1, 0]); face([0, 0, -1], [0, 1, 0], [1, 0, 0]);
  const prim = doc.createPrimitive()
    .setAttribute("POSITION", doc.createAccessor().setType("VEC3").setArray(new Float32Array(pos)).setBuffer(buf))
    .setAttribute("NORMAL", doc.createAccessor().setType("VEC3").setArray(new Float32Array(nor)).setBuffer(buf))
    .setIndices(doc.createAccessor().setType("SCALAR").setArray(new Uint16Array(idx)).setBuffer(buf))
    .setMaterial(doc.createMaterial("prop").setBaseColorFactor([...color, 1]).setRoughnessFactor(0.7).setDoubleSided(true));
  const node = doc.createNode("box").setMesh(doc.createMesh("box").addPrimitive(prim));
  doc.createScene("prop").addChild(node);
  return doc;
}

/** Документ пропа: свой glb (без анимаций) или коробка. */
export async function propDoc(io: NodeIO, dir: string, p: Prop): Promise<Document> {
  if (!p.file) return boxDoc(p.size, p.color);
  const d = await io.read(resolve(dir, p.file));
  for (const a of d.getRoot().listAnimations()) a.dispose();
  return d;
}

/** Повесить пропы проекта на кости в документе модели: держатель «prop_<id>» — ребёнок узла кости. */
export async function attachProps(io: NodeIO, doc: Document, dir: string, project: Project, rig: Rig): Promise<string[]> {
  const props = project.props ?? [];
  if (!props.length) return [];
  const byName = new Map(doc.getRoot().listNodes().map((n) => [n.getName(), n]));
  const done: string[] = [];
  for (const p of props) {
    const bone = byName.get(p.bone);
    if (!bone || !rig.index.has(p.bone)) continue;
    const src = await propDoc(io, dir, p);
    const scene = src.getRoot().getDefaultScene() ?? src.getRoot().listScenes()[0];
    const map = mergeDocuments(doc, src);
    const merged = map.get(scene) as typeof scene;
    const { t, r, s } = propLocal(rig, p);
    const holder = doc.createNode(`prop_${p.id}`).setTranslation(t).setRotation(r).setScale(s);
    for (const c of merged.listChildren() as Node[]) {
      merged.removeChild(c);
      holder.addChild(c);
    }
    merged.dispose();
    bone.addChild(holder);
    done.push(p.id);
  }
  // glb — один буфер
  await doc.transform(unpartition());
  return done;
}
