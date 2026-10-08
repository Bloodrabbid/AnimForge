// Позинг на настоящей модели: рабочий Tools Up! с анатомическими пределами, середина шага.
import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { addPoseDelta, buildRig, effectorOf, posePartsAt, reach, worldPose } from "../../core/src/index.ts";
import { ROOT, loadCtx } from "./node.ts";

test("позинг рабочего: кисть-варежку тянут к плечу посреди шага — локоть гнётся вокруг своей оси и дотягивается", async () => {
  const ctx = await loadCtx(join(ROOT, "projects/worker-demo"));
  const rig = buildRig(ctx.skeleton);
  assert.ok(ctx.project.limits?.arm_l_1?.vertical, "у локтя анатомические пределы (limit.auto)");
  const P: [number, number, number] = [0.1587, 0.7252, 0.0338];
  const clip = structuredClone(ctx.project.clips.find((c) => c.name === "walk")!);
  addPoseDelta(clip, 0.5, reach(ctx.project, rig, clip, 0.5, "arm_l_1", P, 2, true));
  const e = effectorOf(rig, rig.index.get("arm_l_1")!, true)(worldPose(rig, posePartsAt(ctx.project, rig, clip, 0.5)));
  const err = Math.hypot(e[0] - P[0], e[1] - P[1], e[2] - P[2]);
  assert.ok(err < 3e-3, `кисть в цели: промах ${err}`);
});
