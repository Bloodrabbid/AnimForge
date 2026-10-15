// Пропы на костях: узел-держатель под костью, в покое — в точке «кость + смещение» в мировых осях, размер в метрах.
import assert from "node:assert/strict";
import { NodeIO } from "@gltf-transform/core";
import { join } from "node:path";
import { test } from "node:test";
import { buildRig, qrot, vadd, vmul, type Vec3 } from "../../core/src/index.ts";
import { ROOT, loadCtx } from "./node.ts";
import { attachProps, eulerQuat, handBone } from "./props.ts";

test("prop.attach: держатель под кистью, в покое — в кисти + смещение, коробка нужного размера", async () => {
  const ctx = structuredClone(await loadCtx(join(ROOT, "projects/worker-demo")));
  const rig = buildRig(ctx.skeleton);
  const bone = handBone(ctx.project, rig, "r")!;
  assert.equal(bone, "arm_r_1", "у рабочего кисти нет — последняя кость руки");
  const offset: Vec3 = [0.02, -0.1, 0.05];
  ctx.project.props = [{ id: "stick", bone, size: [0.04, 0.04, 0.6], offset, rot: [0, 0, 90] }];
  const io = new NodeIO();
  const doc = await io.read(join(ctx.dir, ctx.project.model));
  assert.deepEqual(await attachProps(io, doc, ctx.dir, ctx.project, rig), ["stick"]);
  const holder = doc.getRoot().listNodes().find((n) => n.getName() === "prop_stick")!;
  assert.equal(doc.getRoot().listNodes().find((n) => n.listChildren().includes(holder))?.getName(), bone);
  assert.equal(doc.getRoot().listBuffers().length, 1, "glb — один буфер");
  // мир держателя в покое = мир кости × локальный держателя
  const m = holder.getWorldMatrix();
  const i = rig.index.get(bone)!;
  const want = vadd(rig.worldT[i], offset);
  assert.ok(Math.hypot(m[12] - want[0], m[13] - want[1], m[14] - want[2]) < 1e-5, `держатель в ${[m[12], m[13], m[14]].map((x) => x.toFixed(3))}`);
  // ось Z пропа (длина 0.6 м) после поворота на 90° вокруг мировой Z — та же Z; масштаб мира — 1
  const z = [m[8], m[9], m[10]];
  const zw = qrot(eulerQuat([0, 0, 90]), [0, 0, 1]);
  assert.ok(Math.hypot(z[0] - zw[0], z[1] - zw[1], z[2] - zw[2]) < 1e-5, `ось Z ${z.map((x) => x.toFixed(3))}`);
  const xw = vmul(qrot(eulerQuat([0, 0, 90]), [1, 0, 0]), [1, 1, 1]);
  assert.ok(Math.hypot(m[0] - xw[0], m[1] - xw[1], m[2] - xw[2]) < 1e-5, "X пропа повёрнут на 90° вокруг Z, длина 1");
});
