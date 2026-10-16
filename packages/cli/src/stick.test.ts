// Живое превью для библиотеки (stickAnim): суставы модели в окне 0…1, палки — от родителя к ребёнку, кадры движутся
// и повторяют позу ядра (проекция на экран вида три четверти).
import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { ROOT, loadCtx } from "./node.ts";
import { stickAnim } from "./stickpreview.ts";

test("stickAnim: окно, палки и движение ходьбы", async () => {
  const ctx = await loadCtx(join(ROOT, "projects/worker-demo"));
  const clip = ctx.project.clips.find((c) => c.name === "walk_geralt")!;
  const a = stickAnim(ctx.project, ctx.skeleton, clip, { fps: 15 });
  const joints = ctx.skeleton.nodes.filter((n) => n.isJoint).length;
  assert.equal(a.frames[0].length, joints);
  assert.equal(a.edges.length, joints - 1, "у дерева суставов палок на одну меньше, чем суставов");
  const flat = a.frames.flat(2);
  assert.ok(Math.min(...flat) >= 0 && Math.max(...flat) <= 1, "всё в окне");
  assert.equal(a.frames.length, Math.round(clip.duration * 15));
  // стопа ходит: размах по экрану заметный
  const slot = ctx.skeleton.nodes.filter((n) => n.isJoint).findIndex((n) => n.name === "foot_l");
  const xs = a.frames.map((f) => f[slot][0]);
  assert.ok(Math.max(...xs) - Math.min(...xs) > 0.05, `стопа почти стоит: ${Math.max(...xs) - Math.min(...xs)}`);
  // голова выше стоп (y вниз)
  const head = ctx.skeleton.nodes.filter((n) => n.isJoint).findIndex((n) => n.name === "head");
  assert.ok(a.frames[0][head][1] < a.frames[0][slot][1]);
});
