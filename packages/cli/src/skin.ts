// Скиннинг по спецификации glTF для «глаз»: вершины каждого кадра считаем сами (Σ вес × мир_сустава × IBM × v),
// Blender только рисует готовые треугольники. Импортёр Blender ставит кожу по узлу меша, а не по рамке привязки, —
// у моделей из сцен-витрин (меш и скелет под разными узлами, корень в сантиметрах) кожа тогда едет не туда,
// куда кости. Так же, как здесь, считают Godot и three.js.
import type { Document, Node } from "@gltf-transform/core";
import type { PoseParts } from "../../core/src/index.ts";

type M4 = Float64Array; // по столбцам, как в glTF

function compose(t: number[], q: number[], s: number[]): M4 {
  const [x, y, z, w] = q;
  const m = new Float64Array(16);
  m[0] = (1 - 2 * (y * y + z * z)) * s[0]; m[1] = 2 * (x * y + z * w) * s[0]; m[2] = 2 * (x * z - y * w) * s[0];
  m[4] = 2 * (x * y - z * w) * s[1]; m[5] = (1 - 2 * (x * x + z * z)) * s[1]; m[6] = 2 * (y * z + x * w) * s[1];
  m[8] = 2 * (x * z + y * w) * s[2]; m[9] = 2 * (y * z - x * w) * s[2]; m[10] = (1 - 2 * (x * x + y * y)) * s[2];
  m[12] = t[0]; m[13] = t[1]; m[14] = t[2]; m[15] = 1;
  return m;
}

function mul(a: M4, b: M4): M4 {
  const o = new Float64Array(16);
  for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) {
    let v = 0;
    for (let k = 0; k < 4; k++) v += a[k * 4 + r] * b[c * 4 + k];
    o[c * 4 + r] = v;
  }
  return o;
}

interface Part {
  name: string;
  color: number[];
  faces: number[]; // тройки индексов
  pos: Float32Array;
  skin?: { joints: Node[]; ibm: M4[]; j: Uint16Array; w: Float32Array };
  node: Node; // для жёстких мешей (молоток в руке): вершины едут с узлом
}

export interface SkinScene {
  parts: Part[];
  roots: Node[];
  jointSet: Set<Node>;
}

export function loadSkinScene(doc: Document): SkinScene {
  const root = doc.getRoot();
  const jointSet = new Set<Node>(root.listSkins().flatMap((s) => s.listJoints()));
  const parentOf = new Map<Node, Node>();
  for (const n of root.listNodes()) for (const c of n.listChildren()) parentOf.set(c, n);
  const onCharacter = (n: Node) => { for (let p = parentOf.get(n); p; p = parentOf.get(p)) if (jointSet.has(p)) return true; return false; };
  const parts: Part[] = [];
  for (const node of root.listNodes()) {
    const mesh = node.getMesh();
    if (!mesh) continue;
    const skin = node.getSkin();
    // в кадр — только персонаж: кожа и то, что прицеплено к костям. Декор сцены-витрины (сферы, полы) не рисуем
    if (!skin && jointSet.size && !onCharacter(node)) continue;
    for (const prim of mesh.listPrimitives()) {
      const P = prim.getAttribute("POSITION");
      if (!P || prim.getMode() !== 4) continue;
      const n = P.getCount(), pos = new Float32Array(n * 3), e: number[] = [];
      for (let i = 0; i < n; i++) { P.getElement(i, e); pos.set(e.slice(0, 3), i * 3); }
      const idx = prim.getIndices();
      const faces = idx ? Array.from({ length: idx.getCount() }, (_, i) => idx.getScalar(i)) : Array.from({ length: n }, (_, i) => i);
      const part: Part = { name: node.getName() || mesh.getName(), color: prim.getMaterial()?.getBaseColorFactor() ?? [0.8, 0.8, 0.8, 1], faces, pos, node };
      const J = prim.getAttribute("JOINTS_0"), W = prim.getAttribute("WEIGHTS_0");
      if (skin && J && W) {
        const IB = skin.getInverseBindMatrices();
        const joints = skin.listJoints();
        const ibm = joints.map((_, k) => { const m = new Float64Array(16); if (IB) { IB.getElement(k, e); m.set(e); } else { m[0] = m[5] = m[10] = m[15] = 1; } return m; });
        const j = new Uint16Array(n * 4), w = new Float32Array(n * 4);
        for (let i = 0; i < n; i++) {
          J.getElement(i, e); j.set(e.slice(0, 4), i * 4);
          W.getElement(i, e);
          const sum = e[0] + e[1] + e[2] + e[3] || 1;
          w.set(e.slice(0, 4).map((x) => x / sum), i * 4);
        }
        part.skin = { joints, ibm, j, w };
      }
      parts.push(part);
    }
  }
  const roots = root.getDefaultScene()?.listChildren() ?? root.listNodes().filter((n) => !parentOf.has(n));
  return { parts, roots, jointSet };
}

/** Вершины всех частей в позе (координаты Blender: Z вверх), подряд в одном массиве. yaw — поворот вокруг верха,
 * которым персонаж разворачивается лицом на +Z glTF: так вид «front» у любой модели смотрит ей в лицо. */
export function skinFrame(sc: SkinScene, pose: PoseParts, yaw = 0): Float32Array {
  const cy = Math.cos(yaw), sy = Math.sin(yaw);
  const world = new Map<Node, M4>();
  const walk = (n: Node, parent: M4 | null) => {
    // поза из ядра — только у суставов: у одноимённых пустышек (Worker01 бывает и узлом, и костью) берём rest
    const name = n.getName(), j = sc.jointSet.has(n);
    const t = (j && pose.pos.get(name)) || n.getTranslation();
    const r = (j && pose.rot.get(name)) || n.getRotation();
    const s = (j && pose.scl.get(name)) || n.getScale();
    const m = compose(t, r, s);
    const wm = parent ? mul(parent, m) : m;
    world.set(n, wm);
    for (const c of n.listChildren()) walk(c, wm);
  };
  for (const r of sc.roots) walk(r, null);
  const total = sc.parts.reduce((a, p) => a + p.pos.length, 0);
  const out = new Float32Array(total);
  let o = 0;
  for (const p of sc.parts) {
    const n = p.pos.length / 3;
    const mats = p.skin ? p.skin.joints.map((jn, k) => mul(world.get(jn)!, p.skin!.ibm[k])) : [world.get(p.node)!];
    for (let i = 0; i < n; i++) {
      const x = p.pos[i * 3], y = p.pos[i * 3 + 1], z = p.pos[i * 3 + 2];
      let X = 0, Y = 0, Z = 0;
      for (let k = 0; k < (p.skin ? 4 : 1); k++) {
        const wt = p.skin ? p.skin.w[i * 4 + k] : 1;
        if (!wt) continue;
        const m = mats[p.skin ? p.skin.j[i * 4 + k] : 0];
        X += wt * (m[0] * x + m[4] * y + m[8] * z + m[12]);
        Y += wt * (m[1] * x + m[5] * y + m[9] * z + m[13]);
        Z += wt * (m[2] * x + m[6] * y + m[10] * z + m[14]);
      }
      // разворот лицом на +Z, потом glTF Y-up → Blender Z-up: (x, y, z) → (x, −z, y)
      const RX = cy * X + sy * Z, RZ = -sy * X + cy * Z;
      out[o++] = RX; out[o++] = -RZ; out[o++] = Y;
    }
  }
  return out;
}

export function skinTopology(sc: SkinScene) {
  return sc.parts.map((p) => ({ name: p.name, color: p.color, verts: p.pos.length / 3, faces: p.faces }));
}
