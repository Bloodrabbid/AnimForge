// Перенос клипа на другой скелет (clip.copy): рецепты, позы, цели и пол — с рабочего (Tools Up!) на Mixamo Xbot.
// Xbot лежит в out/retarget/xbot (не в git: модель Mixamo) — без него проверяется только перенос на самого себя.
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { bodyFrame, buildRig, gaitSlide, posePartsAt, retargetClip, vdot, vnorm, vsub, worldPose, type Clip, type Vec3 } from "../../core/src/index.ts";
import { ROOT, loadCtx } from "./node.ts";

const xbot = join(ROOT, "out/retarget/xbot");
const side = async (dir: string) => {
  const c = await loadCtx(dir);
  return { project: c.project, rig: buildRig(c.skeleton) };
};
type S = Awaited<ReturnType<typeof side>>;
const joints = (s: S, clip: Clip, t: number) => worldPose(s.rig, posePartsAt(s.project, s.rig, clip, t)).T;
/** направление кости a → b в осях тела (бок, верх, вперёд) */
const dir = (s: S, clip: Clip, a: string, b: string, t: number): Vec3 => {
  const w = joints(s, clip, t), f = bodyFrame(s.project);
  const v = vnorm(vsub(w[s.rig.index.get(b)!], w[s.rig.index.get(a)!]));
  return [vdot(v, f.side), vdot(v, f.up), vdot(v, f.forward)];
};
const deg = (a: Vec3, b: Vec3) => (Math.acos(Math.min(1, vdot(a, b))) * 180) / Math.PI;

test("clip.copy на тот же скелет — поза кость в кость", async () => {
  const s = await side(join(ROOT, "projects/worker-demo"));
  for (const clip of s.project.clips) {
    const r = retargetClip(s, s, clip);
    assert.equal(r.scale, 1);
    for (const t of [0.13, 0.61]) {
      const a = joints(s, clip, t * clip.duration), b = joints(s, r.clip, t * clip.duration);
      a.forEach((p, i) => assert.ok(Math.hypot(...vsub(p, b[i])) < 1e-9, `${clip.name} ${s.rig.skel.nodes[i].name}`));
    }
  }
});

// Xbot и демо с позой и целями (out/pose-demo, out/targets-demo) — из прогонов README, в git их нет
const skip = !["out/retarget/xbot", "out/pose-demo", "out/targets-demo"].every((d) => existsSync(join(ROOT, d, "animforge.json"))) && "нет Xbot или демо в out/";

test("clip.copy рабочий → Xbot: ходьба с фиксацией стопы, масштаб по росту, ноги на пол", { skip }, async () => {
  const s = await side(join(ROOT, "projects/worker-demo")), d = await side(xbot);
  const base = s.project.clips.find((c) => c.name === "walk_april")!;
  const clip: Clip = { ...base, name: "walk_april_lock", ground: { ...base.ground!, lock: true } };
  const r = retargetClip(s, d, clip);
  assert.deepEqual(r.clip.ground!.bones, ["mixamorig:LeftFoot", "mixamorig:RightFoot"]);
  assert.ok(r.scale > 1.3 && r.scale < 1.5, `рост ×${r.scale}`); // Xbot 1.8 м, рабочий 1.3 м
  assert.ok(r.dropped.every((x) => /ear_/.test(x)), r.dropped.join(", ")); // ушей у Xbot нет — и только их
  const sl = gaitSlide(d.project, d.rig, r.clip)!;
  assert.ok(sl.mean < 0.01, `стопа едет ${(sl.mean * 100).toFixed(1)} % роста`);
  assert.ok(sl.speed > 0.1, `не идёт: ${sl.speed}`);
});

test("clip.copy рабочий → Xbot: поза руки — то же направление в осях тела", { skip }, async () => {
  const s = await side(join(ROOT, "out/pose-demo")), d = await side(xbot);
  const clip = s.project.clips.find((c) => c.name === "walk")!;
  assert.ok(clip.layers.some((l) => l.type === "pose"));
  const r = retargetClip(s, d, clip);
  const a = dir(s, clip, "arm_l_0", "arm_l_1", 0.5), b = dir(d, r.clip, "mixamorig:LeftArm", "mixamorig:LeftForeArm", 0.5);
  assert.ok(deg(a, b) < 6, `плечо расходится на ${deg(a, b).toFixed(1)}°`);
  // и поза действительно что-то делает: без неё плечо смотрит иначе
  const plain = { ...r.clip, layers: r.clip.layers.filter((l) => l.type !== "pose") };
  assert.ok(deg(b, dir(d, plain, "mixamorig:LeftArm", "mixamorig:LeftForeArm", 0.5)) > 10);
});

test("clip.copy рабочий → Xbot: IK руки-варежки становится IK кисти и дотягивается до перенесённой цели", { skip }, async () => {
  const s = await side(join(ROOT, "out/targets-demo")), d = await side(xbot);
  const clip = s.project.clips.find((c) => c.name === "walk")!;
  const r = retargetClip(s, d, clip);
  const ik = r.clip.constraints!.find((c) => c.type === "ik")! as { tip: string; end?: boolean; target: { pos: Vec3 } };
  assert.equal(ik.tip, "mixamorig:LeftHand");
  assert.ok(!ik.end);
  for (const t of [0.3, 0.9]) {
    const w = joints(d, r.clip, t);
    const e = Math.hypot(...vsub(w[d.rig.index.get(ik.tip)!], ik.target.pos));
    assert.ok(e < 0.03, `t=${t}: кисть в ${e.toFixed(3)} м от цели`);
  }
  assert.ok(r.clip.constraints!.some((c) => c.type === "aim" && c.bones[0] === "mixamorig:Head"));
});
