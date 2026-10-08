// Скиннинг «глаз» по спецификации glTF: кожа идёт за костями, узел меша не учитывается.
import assert from "node:assert/strict";
import { test } from "node:test";
import { Document } from "@gltf-transform/core";
import { loadSkinScene, skinFrame } from "./skin.ts";

const close = (a: number, b: number, msg = "") => assert.ok(Math.abs(a - b) < 1e-5, `${msg} ${a} ≠ ${b}`);

/** Две кости вдоль +Y (корень в начале, локоть на 1 м) и две вершины: на корне (0,0.5,0) и на локте (0,2,0).
 * Узел меша нарочно сдвинут и развёрнут — по спецификации он игнорируется. */
function scene() {
  const doc = new Document();
  const buf = doc.createBuffer();
  const root = doc.createNode("root").setTranslation([0, 0, 0]);
  const elbow = doc.createNode("elbow").setTranslation([0, 1, 0]);
  root.addChild(elbow);
  const ibm = doc.createAccessor().setType("MAT4").setBuffer(buf)
    .setArray(new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, -1, 0, 1]));
  const skin = doc.createSkin().addJoint(root).addJoint(elbow).setInverseBindMatrices(ibm);
  const prim = doc.createPrimitive()
    .setAttribute("POSITION", doc.createAccessor().setType("VEC3").setBuffer(buf).setArray(new Float32Array([0, 0.5, 0, 0, 2, 0, 0, 0.5, 0.1])))
    .setAttribute("JOINTS_0", doc.createAccessor().setType("VEC4").setBuffer(buf).setArray(new Uint16Array([0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0])))
    .setAttribute("WEIGHTS_0", doc.createAccessor().setType("VEC4").setBuffer(buf).setArray(new Float32Array([1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0])))
    .setIndices(doc.createAccessor().setType("SCALAR").setBuffer(buf).setArray(new Uint16Array([0, 1, 2])));
  const meshNode = doc.createNode("body").setMesh(doc.createMesh().addPrimitive(prim)).setSkin(skin)
    .setTranslation([5, 0, 0]).setRotation([0, 1, 0, 0]);
  doc.createScene().addChild(root).addChild(meshNode);
  return loadSkinScene(doc);
}

const none = { rot: new Map(), pos: new Map(), scl: new Map() };
// Blender: (x, y, z) glTF → (x, −z, y)
const at = (f: Float32Array, i: number) => [f[i * 3], f[i * 3 + 2], -f[i * 3 + 1]]; // обратно в glTF для проверки

test("скиннинг: в rest кожа там же, где вершины, — узел меша (сдвиг 5 м, разворот) не учитывается", () => {
  const f = skinFrame(scene(), none);
  const v = at(f, 1);
  close(v[0], 0, "x"); close(v[1], 2, "y"); close(v[2], 0, "z");
  // оси Blender прямо: glTF (0, 0.5, 0.1) → Blender (0, −0.1, 0.5)
  close(f[6], 0); close(f[7], -0.1, "Blender y = −z glTF"); close(f[8], 0.5, "Blender z = y glTF");
});

test("скиннинг: поворот локтя на 90° вокруг Z уносит его вершину, корневую не трогает", () => {
  const s = Math.SQRT1_2;
  const f = skinFrame(scene(), { ...none, rot: new Map([["elbow", [0, 0, s, s]]]) });
  const v = at(f, 1), r = at(f, 0);
  close(v[0], -1, "x"); close(v[1], 1, "y"); close(r[1], 0.5, "корень");
  // поворот корня несёт локоть: (0, 2, 0) → (−2, 0, 0) — родитель слева в произведении
  const q = skinFrame(scene(), { ...none, rot: new Map([["root", [0, 0, s, s]]]) });
  close(at(q, 1)[0], -2, "x"); close(at(q, 1)[1], 0, "y");
  // сдвиг корня на 0.3 м переносит обе
  const g = skinFrame(scene(), { ...none, pos: new Map([["root", [0.3, 0, 0]]]) });
  close(at(g, 0)[0], 0.3); close(at(g, 1)[0], 0.3);
});

test("скиннинг: yaw разворачивает персонажа лицом к камере", () => {
  const f = skinFrame(scene(), none, Math.PI / 2);
  // вершина (0, 0.5, 0.1): +Z при повороте на +90° вокруг Y уходит в +X
  close(at(f, 2)[0], 0.1, "x"); close(at(f, 2)[2], 0, "z");
});
