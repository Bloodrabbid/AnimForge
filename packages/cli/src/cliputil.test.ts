// Утилиты клипа: зеркало, задом наперёд, на месте по осям.
import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { bodyFrame, buildRig, clipEvents, mirrorPairs, posePartsAt, runCommand, vdot, vsub, worldPose, type Clip } from "../../core/src/index.ts";
import { ROOT, loadCtx } from "./node.ts";

const ctxP = loadCtx(join(ROOT, "projects/worker-demo"));

test("зеркало: каждая кость стоит там, где в исходном клипе стояла её пара, отражённая через плоскость тела", async () => {
  const { project, skeleton } = await ctxP;
  const rig = buildRig(skeleton), side = bodyFrame(project).side, pairs = mirrorPairs(project, rig);
  assert.equal(pairs.foot_l, "foot_r", "стопа — пара по детям голени");
  assert.equal(pairs.arm_l_1, "arm_r_1");
  const geralt = project.clips.find((c) => c.name === "walk_geralt")!;
  // и сдвиг вбок — он должен отразиться
  const walk: Clip = { ...geralt, layers: [...geralt.layers, { id: "side", type: "keys", tracks: [{ bone: "pelvis", axis: "move_side", keys: [{ t: 0, v: 0 }, { t: 0.6, v: 0.06 }, { t: geralt.duration, v: 0 }] }] }] };
  const m: Clip = { ...walk, mirror: true };
  const c0 = vdot(rig.worldT[rig.index.get("pelvis")!], side); // плоскость симметрии — через таз в покое
  for (const t of [0.1, 0.47, 0.83]) {
    const a = worldPose(rig, posePartsAt(project, rig, walk, t)).T, b = worldPose(rig, posePartsAt(project, rig, m, t)).T;
    for (const n of skeleton.nodes) {
      if (!n.isJoint) continue;
      const p = a[rig.index.get(pairs[n.name] ?? n.name)!], q = b[rig.index.get(n.name)!];
      const refl = vsub(p, side.map((s) => 2 * s * (vdot(p, side) - c0)) as [number, number, number]);
      assert.ok(Math.hypot(...vsub(refl, q)) < 2e-3, `${n.name} t=${t}: ${Math.hypot(...vsub(refl, q)).toFixed(4)} м`);
    }
  }
  // дважды зеркало — исходный клип
  const back = runCommand(structuredClone(await ctxP), "clip.mirror", { clip: "walk" }) as { mirror: boolean };
  assert.equal(back.mirror, true);
});

test("зеркало: пары по детям уже найденных пар, когда в именах нет меток сторон", () => {
  const node = (name: string, parent: string | null, x: number) => ({ name, parent, restT: [x, 0, 0] as [number, number, number], restR: [0, 0, 0, 1] as [number, number, number, number], restS: [1, 1, 1] as [number, number, number], isJoint: true });
  const rig = buildRig({ nodes: [node("root", null, 0), node("hipA", "root", 0.1), node("hipB", "root", -0.1), node("footA", "hipA", 0), node("footB", "hipB", 0), node("toeA", "footA", 0), node("toeB", "footB", 0)] });
  const pairs = mirrorPairs({ version: 1, name: "x", model: "", up: [0, 1, 0], chains: { leg_l: ["hipA"], leg_r: ["hipB"] }, clips: [] }, rig);
  assert.deepEqual([pairs.footA, pairs.toeB, pairs.root], ["footB", "toeA", undefined]);
});

test("задом наперёд: поза в t — исходная в конце минус t, события — в зеркальные моменты", async () => {
  const { project, skeleton } = await ctxP;
  const rig = buildRig(skeleton);
  const hit = project.clips.find((c) => c.name === "hammer")!;
  const r: Clip = { ...hit, reverse: true };
  for (const t of [0.05, 0.4, 0.9]) {
    const a = posePartsAt(project, rig, r, t).rot, b = posePartsAt(project, rig, hit, hit.duration - t).rot;
    // уши — вторичная динамика (пружина считается вперёд по времени и не обратима) — их не сравниваем
    for (const [k, q] of a) if (!k.startsWith("ear_")) assert.ok(Math.abs(Math.abs(q[0] * b.get(k)![0] + q[1] * b.get(k)![1] + q[2] * b.get(k)![2] + q[3] * b.get(k)![3]) - 1) < 1e-9, `${k} t=${t}`);
  }
  const e0 = clipEvents(hit), e1 = clipEvents(r);
  assert.ok(e0.length > 0);
  assert.deepEqual(e1.map((e) => e.name).sort(), e0.map((e) => e.name).sort());
  for (const e of e0) assert.ok(e1.some((x) => x.name === e.name && Math.abs(x.t - (hit.duration - e.t)) < 1e-6), `${e.name} ${e.t}`);
});

test("на месте: ход таза вперёд за клип снимается, качание внутри клипа остаётся", async () => {
  const { project, skeleton } = await ctxP;
  const rig = buildRig(skeleton), f = bodyFrame(project), pi = rig.index.get("pelvis")!;
  const walk = project.clips.find((c) => c.name === "walk")!;
  const go: Clip = { ...walk, layers: [...walk.layers, { id: "go", type: "keys", tracks: [{ bone: "pelvis", axis: "move_forward", keys: [{ t: 0, v: 0, interp: "linear" }, { t: walk.duration, v: 0.6 }] }] }] };
  const fwd = (c: Clip, t: number) => vdot(worldPose(rig, posePartsAt(project, rig, c, t)).T[pi], f.forward);
  const end = walk.duration * 0.999; // петля: в самом конце ключи заворачиваются к началу
  assert.ok(fwd(go, end) - fwd(go, 0) > 0.5, "без «на месте» таз уезжает");
  const ip: Clip = { ...go, inPlace: ["forward"] };
  assert.ok(Math.abs(fwd(ip, end) - fwd(ip, 0)) < 2e-3, `на месте: ${(fwd(ip, end) - fwd(ip, 0)).toFixed(4)} м`);
  // в середине — как исходный клип без хода (своё качание не тронуто)
  const mid = walk.duration * 0.37;
  assert.ok(Math.abs(fwd(ip, mid) - fwd(walk, mid)) < 1e-3);
  // ровно в конце петли (последний кадр экспорта) и на втором круге — без прыжка назад на весь ход клипа
  assert.ok(Math.abs(fwd(ip, walk.duration) - fwd(ip, 0)) < 2e-3, `в t = duration: ${(fwd(ip, walk.duration) - fwd(ip, 0)).toFixed(4)} м`);
  assert.ok(Math.abs(fwd(ip, walk.duration + mid) - fwd(ip, mid)) < 1e-3, "второй круг — как первый");
});
