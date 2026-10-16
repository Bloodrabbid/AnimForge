// Стиль поверх походки (clip.style): «зомби» из 100STYLE на процедурную ходьбу рабочего — кисти уходят вперёд от
// плеч, в такт шагам (фаза найдена), «руки в боки» — кисти ближе к тазу; off убирает слой.
import assert from "node:assert/strict";
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { bodyFrame, buildRig, posePartsAt, vdot, vsub, worldPose } from "../../core/src/index.ts";
import { NODE_COMMANDS, ROOT, loadCtx } from "./node.ts";

test("clip.style: зомби — руки вперёд в такт шагам, off — снимает", async () => {
  const dir = mkdtempSync(join(tmpdir(), "af-sty-"));
  cpSync(join(ROOT, "projects/worker-demo"), dir, { recursive: true });
  rmSync(join(dir, ".autosave"), { recursive: true, force: true });
  const pf = join(dir, "animforge.json"), pj = JSON.parse(readFileSync(pf, "utf8"));
  delete pj.limits; // пределы рабочего не дают поднять руки — здесь сверяем сам стиль
  writeFileSync(pf, JSON.stringify(pj));
  const reach = async () => {
    const { project, skeleton } = await loadCtx(dir);
    const rig = buildRig(skeleton), f = bodyFrame(project).forward, c = project.clips.find((x) => x.name === "walk_geralt")!;
    const arm = project.chains.arm_l!, sh = rig.index.get(arm[0])!, tip = rig.index.get(arm[arm.length - 1])!;
    let s = 0;
    for (let k = 0; k < 10; k++) { const T = worldPose(rig, posePartsAt(project, rig, c, (c.duration * k) / 10)).T; s += vdot(vsub(T[tip], T[sh]), f); }
    return s / 10;
  };
  const before = await reach();
  const r = (await NODE_COMMANDS["clip.style"].run(dir, { clip: "walk_geralt", style: "зомби" })) as { style: string; phased: boolean };
  assert.equal(r.style, "Zombie");
  assert.ok(r.phased, "фаза шага найдена и у записей, и у клипа");
  const after = await reach();
  assert.ok(after - before > 0.03, `кисть ушла вперёд на ${(after - before).toFixed(3)} м`);
  await NODE_COMMANDS["clip.style"].run(dir, { clip: "walk_geralt", off: true });
  assert.ok(Math.abs((await reach()) - before) < 1e-6, "off — как было");
});

// у модели в T-позе (Xbot, Mixamo; в git его нет — пропуск) порядок разницы важен: «стиль · обычная⁻¹» уводил руки
// зомби в стороны, «обычная⁻¹ · стиль» — вперёд, как в записи
const XBOT = join(ROOT, "out/retarget/xbot");
test("clip.style на T-позе: предплечья зомби смотрят вперёд, а не в стороны", { skip: !existsSync(join(XBOT, "animforge.json")) && "нет Xbot в out/" }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "af-sty-"));
  cpSync(XBOT, dir, { recursive: true });
  rmSync(join(dir, ".autosave"), { recursive: true, force: true });
  await NODE_COMMANDS["clip.style"].run(dir, { clip: "walk", style: "Zombie" });
  const { project, skeleton } = await loadCtx(dir);
  const rig = buildRig(skeleton), fr = bodyFrame(project), c = project.clips.find((x) => x.name === "walk")!;
  for (const s of ["Left", "Right"]) {
    const a = rig.index.get(`mixamorig:${s}ForeArm`)!, b = rig.index.get(`mixamorig:${s}Hand`)!;
    let fwd = 0;
    for (let k = 0; k < 8; k++) { const T = worldPose(rig, posePartsAt(project, rig, c, (c.duration * k) / 8)).T; const d = vsub(T[b], T[a]); fwd += vdot(d, fr.forward) / Math.hypot(...d); }
    assert.ok(fwd / 8 > 0.75, `${s}: предплечье вперёд на ${(fwd / 8).toFixed(2)}`);
  }
});
