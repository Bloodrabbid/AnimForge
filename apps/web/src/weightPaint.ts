// Веса кожи во вьюпорте: тепловая карта выбранной кости и кисть (добавить, убрать, сгладить).
// Кисть меряет расстояние по деформированной коже (SkinnedMesh.getVertexPosition) — правишь там, куда смотришь,
// даже посреди шага. Правка сразу в атрибутах skinIndex/skinWeight: three.js скинит на GPU, анимация не встаёт.
import * as THREE from "three";
import { boneWeight, brushFalloff, setBoneWeight } from "../../../packages/core/src/index.ts";

export type BrushMode = "add" | "sub" | "smooth";
export interface Brush {
  mode: BrushMode;
  radius: number; // доля размера модели
  strength: number; // 0…1 за мазок-шаг
}

export interface SkinPart {
  mesh: THREE.SkinnedMesh;
  meshIndex: number; // индекс меша и примитива в glb — куда сервер запишет веса
  primitive: number;
  material: THREE.Material | THREE.Material[];
}

export interface WeightsPart {
  mesh: number;
  primitive: number;
  joints: number[];
  weights: number[];
}

const heat = (w: number, out: THREE.Color) => {
  // 0 — тёмно-синий, 0.5 — зелёный, 1 — красный (как в Blender)
  const stops = [
    [0, 0.05, 0.08, 0.35],
    [0.25, 0.0, 0.45, 0.85],
    [0.5, 0.1, 0.8, 0.3],
    [0.75, 0.95, 0.85, 0.1],
    [1, 0.95, 0.15, 0.1],
  ];
  for (let k = 1; k < stops.length; k++) {
    if (w <= stops[k][0]) {
      const a = stops[k - 1], b = stops[k], f = (w - a[0]) / (b[0] - a[0]);
      return out.setRGB(a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f, a[3] + (b[3] - a[3]) * f);
    }
  }
  return out.setRGB(0.95, 0.15, 0.1);
};

export class WeightPainter {
  private heatMat = new THREE.MeshLambertMaterial({ vertexColors: true });
  private undoStack: { a: Float32Array[]; b: Float32Array[] }[] = [];
  strokes = 0;
  active = false;
  private lastBone: THREE.Object3D | undefined;

  constructor(public parts: SkinPart[]) {}

  /** Кость по объекту: индекс в skeleton.bones каждого меша (у разных мешей порядок свой). */
  private boneIndex(p: SkinPart, bone: THREE.Object3D | undefined) {
    return bone ? p.mesh.skeleton.bones.indexOf(bone as THREE.Bone) : -1;
  }

  setActive(on: boolean) {
    if (on === this.active) return;
    this.active = on;
    for (const p of this.parts) p.mesh.material = on ? this.heatMat : p.material;
  }

  /** Перекрасить по весу кости (−1 — серым: кость не выбрана). */
  recolor(bone: THREE.Object3D | undefined) {
    this.lastBone = bone;
    const c = new THREE.Color();
    for (const p of this.parts) {
      const g = p.mesh.geometry;
      const n = g.attributes.position.count;
      let col = g.attributes.color as THREE.BufferAttribute | undefined;
      if (!col || col.count !== n || col.itemSize !== 3) {
        col = new THREE.BufferAttribute(new Float32Array(n * 3), 3);
        g.setAttribute("color", col);
      }
      const bi = this.boneIndex(p, bone);
      const si = g.attributes.skinIndex, sw = g.attributes.skinWeight;
      for (let i = 0; i < n; i++) {
        if (bi < 0) c.setRGB(0.32, 0.33, 0.36);
        else heat(boneWeight([si.getX(i), si.getY(i), si.getZ(i), si.getW(i)], [sw.getX(i), sw.getY(i), sw.getZ(i), sw.getW(i)], bi), c);
        col.setXYZ(i, c.r, c.g, c.b);
      }
      col.needsUpdate = true;
    }
  }

  beginStroke() {
    this.undoStack.push({
      a: this.parts.map((p) => Float32Array.from(attrArray(p.mesh.geometry.attributes.skinIndex))),
      b: this.parts.map((p) => Float32Array.from(attrArray(p.mesh.geometry.attributes.skinWeight))),
    });
    if (this.undoStack.length > 40) this.undoStack.shift();
    this.strokes++;
  }

  undo(bone: THREE.Object3D | undefined = this.lastBone) {
    const s = this.undoStack.pop();
    if (!s) return false;
    this.parts.forEach((p, k) => {
      writeAttr(p.mesh.geometry.attributes.skinIndex as THREE.BufferAttribute, s.a[k]);
      writeAttr(p.mesh.geometry.attributes.skinWeight as THREE.BufferAttribute, s.b[k]);
    });
    this.strokes = Math.max(0, this.strokes - 1);
    this.recolor(bone);
    return true;
  }

  /** Шаг кисти в мировой точке hit: вершины ближе radius получают правку веса кости bone. */
  dab(hit: THREE.Vector3, bone: THREE.Object3D, fallback: THREE.Object3D | undefined, brush: Brush, modelSize: number) {
    const R = brush.radius * modelSize;
    const v = new THREE.Vector3();
    for (const p of this.parts) {
      const bi = this.boneIndex(p, bone);
      if (bi < 0) continue;
      const fb = Math.max(0, this.boneIndex(p, fallback));
      const g = p.mesh.geometry, n = g.attributes.position.count;
      const si = g.attributes.skinIndex as THREE.BufferAttribute, sw = g.attributes.skinWeight as THREE.BufferAttribute;
      const near: { i: number; f: number; w: number }[] = [];
      for (let i = 0; i < n; i++) {
        p.mesh.getVertexPosition(i, v);
        v.applyMatrix4(p.mesh.matrixWorld);
        const d = v.distanceTo(hit);
        if (d >= R) continue;
        near.push({ i, f: brushFalloff(d, R), w: boneWeight([si.getX(i), si.getY(i), si.getZ(i), si.getW(i)], [sw.getX(i), sw.getY(i), sw.getZ(i), sw.getW(i)], bi) });
      }
      if (!near.length) continue;
      const mean = near.reduce((s, x) => s + x.w, 0) / near.length;
      for (const { i, f, w } of near) {
        const k = brush.strength * f;
        const target = brush.mode === "add" ? w + k * (1 - w) : brush.mode === "sub" ? w - k * w : w + (mean - w) * k;
        const idx = [si.getX(i), si.getY(i), si.getZ(i), si.getW(i)], ws = [sw.getX(i), sw.getY(i), sw.getZ(i), sw.getW(i)];
        setBoneWeight(idx, ws, bi, target, fb === bi ? 0 : fb);
        si.setXYZW(i, idx[0], idx[1], idx[2], idx[3]);
        sw.setXYZW(i, ws[0], ws[1], ws[2], ws[3]);
      }
      si.needsUpdate = sw.needsUpdate = true;
    }
    this.recolor(bone);
  }

  /** Кость с наибольшим весом у вершины в точке попадания (клик по модели выбирает кость). */
  boneAt(hit: THREE.Intersection): THREE.Bone | undefined {
    const p = this.parts.find((x) => x.mesh === hit.object);
    if (!p || !hit.face) return undefined;
    const g = p.mesh.geometry, si = g.attributes.skinIndex, sw = g.attributes.skinWeight;
    let best = -1, bw = -1;
    for (const vi of [hit.face.a, hit.face.b, hit.face.c])
      for (let k = 0; k < 4; k++) {
        const w = [sw.getX(vi), sw.getY(vi), sw.getZ(vi), sw.getW(vi)][k];
        if (w > bw) (bw = w), (best = [si.getX(vi), si.getY(vi), si.getZ(vi), si.getW(vi)][k]);
      }
    return best >= 0 ? p.mesh.skeleton.bones[best] : undefined;
  }

  /** Веса для записи в glb: индексы костей в порядке skin.joints (так их строит GLTFLoader) и веса с суммой 1. */
  collect(): WeightsPart[] {
    return this.parts.map((p) => {
      const g = p.mesh.geometry, n = g.attributes.position.count;
      const si = g.attributes.skinIndex, sw = g.attributes.skinWeight;
      const joints: number[] = [], weights: number[] = [];
      for (let i = 0; i < n; i++) {
        const w = [sw.getX(i), sw.getY(i), sw.getZ(i), sw.getW(i)];
        const s = w.reduce((a, b) => a + b, 0) || 1;
        joints.push(si.getX(i), si.getY(i), si.getZ(i), si.getW(i));
        weights.push(...w.map((x) => x / s));
      }
      return { mesh: p.meshIndex, primitive: p.primitive, joints, weights };
    });
  }
}

function attrArray(a: THREE.BufferAttribute | THREE.InterleavedBufferAttribute) {
  const out: number[] = [];
  for (let i = 0; i < a.count; i++) out.push(a.getX(i), a.getY(i), a.getZ(i), a.getW(i));
  return out;
}
function writeAttr(a: THREE.BufferAttribute, src: Float32Array) {
  for (let i = 0; i < a.count; i++) a.setXYZW(i, src[i * 4], src[i * 4 + 1], src[i * 4 + 2], src[i * 4 + 3]);
  a.needsUpdate = true;
}
