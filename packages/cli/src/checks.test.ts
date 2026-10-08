// Автопроверки по коже на настоящей модели (рабочий Tools Up!): что ловят и что умеют чинить.
import assert from "node:assert/strict";
import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { buildRig, posePartsAt } from "../../core/src/index.ts";
import { checkClip, checkProject, loadMesh } from "./checks.ts";
import { ROOT, loadCtx, smoothWeights } from "./node.ts";
import { skinFrame, stretchOf } from "./skin.ts";

const tmp = mkdtempSync(join(tmpdir(), "af-checks-"));
after(() => rmSync(tmp, { recursive: true, force: true }));
const copy = (name: string) => { const d = join(tmp, name); cpSync(join(ROOT, "projects/worker-demo"), d, { recursive: true }); return d; };
const find = (r: { findings: { check: string; level: string }[] }, check: string) => r.findings.find((f) => f.check === check);

test("кожа: щель в колене рабочего видна (жёсткие веса бедро/голень), сглаживание весов её закрывает", async () => {
  const dir = copy("skin");
  let ctx = await loadCtx(dir);
  const hammer = ctx.project.clips.find((c) => c.name === "hammer")!;
  assert.equal(find(checkClip(ctx.project, ctx, await loadMesh(ctx), hammer, false).report, "skin")?.level, "fail");
  await smoothWeights(dir);
  ctx = await loadCtx(dir);
  assert.equal(find(checkClip(ctx.project, ctx, await loadMesh(ctx), hammer, false).report, "skin"), undefined);
});

test("кожа: кадры со сдвигом фазы — ходьба из четырёх шагов не прячет разрыв между кадрами", async () => {
  // walk рабочего — 4 периода по 0.479 с: 8 равномерных кадров попадают в одни и те же фазы
  const ctx = await loadCtx(join(ROOT, "projects/worker-demo"));
  const r = checkClip(ctx.project, ctx, await loadMesh(ctx), ctx.project.clips.find((c) => c.name === "walk")!, false).report;
  assert.equal(find(r, "skin")?.level, "fail");
});

test("кожа: сжатие в сгибе — не разрыв, растяжение — разрыв", () => {
  const rest = Float32Array.from([0, 0, 0, 1, 0, 0]), edges = Uint32Array.from([0, 1]);
  assert.equal(stretchOf(rest, Float32Array.from([0, 0, 0, 0.2, 0, 0]), edges, 0.01).bad, 0, "сжато в 5 раз");
  assert.equal(stretchOf(rest, Float32Array.from([0, 0, 0, 3, 0, 0]), edges, 0.01).bad, 1, "растянуто в 3 раза");
});

test("починка: веса, стопы плоско на пол, слои — и характер походки остаётся (таз не ниже ×0.5)", async () => {
  const dir = copy("fix");
  const rep = await checkProject(dir, ["walk1", "hammer"], true);
  for (const r of rep) assert.ok(r.ok, `${r.clip}: ${JSON.stringify(r.findings)}`);
  const p = (await loadCtx(dir)).project;
  const walk = p.clips.find((c) => c.name === "walk1")!;
  assert.equal(walk.ground?.flat, true);
  for (const l of walk.layers) if (l.type === "recipe" && /pelvis|chest/.test(l.target.chain)) assert.ok((l.weight ?? 1) >= 0.5, `${l.id} ×${l.weight}`);
  assert.equal(p.clips.find((c) => c.name === "hammer")!.layers.every((l) => l.type !== "recipe" || (l.weight ?? 1) === 1), true, "удар чинится стопами, а не ослаблением");
});

test("плоская стопа: опорная стопа не уходит носком под пол", async () => {
  const ctx = await loadCtx(join(ROOT, "projects/worker-demo"));
  const m = await loadMesh(ctx), rig = buildRig(ctx.skeleton);
  const hammer = structuredClone(ctx.project.clips.find((c) => c.name === "hammer")!);
  const low = (c: typeof hammer) => { let d = 0; for (let k = 0; k < 24; k++) { const f = skinFrame(m.sc, posePartsAt(ctx.project, rig, c, (c.duration * (k + 0.37)) / 24)); for (let i = 2; i < f.length; i += 3) d = Math.max(d, m.floor - f[i]); } return d / m.H; };
  const before = low(hammer);
  hammer.ground = { ...hammer.ground!, flat: true };
  assert.ok(before > 0.03 && low(hammer) < 0.01, `провал ${before} → ${low(hammer)}`);
});

test("шов цикла и тайминг удара под роль", async () => {
  const ctx = await loadCtx(join(ROOT, "projects/worker-demo"));
  const m = await loadMesh(ctx);
  const walk = structuredClone(ctx.project.clips.find((c) => c.name === "walk1")!);
  walk.layers.push({ id: "drift", type: "keys", tracks: [{ bone: "head", axis: "lateral", keys: [{ t: 0, v: 0 }, { t: walk.duration, v: 40 }] }] });
  assert.equal(find(checkClip(ctx.project, ctx, m, walk, false).report, "seam")?.level, "fail");
  const golem = ctx.project.clips.find((c) => c.name === "power")!; // заряд: первый удар через 2.9 с
  const asPlayer = { ...ctx.project, style: { role: "player" } };
  assert.equal(find(checkClip(asPlayer, ctx, m, golem, false).report, "timing")?.level, "warn");
  assert.equal(find(checkClip({ ...ctx.project, style: { role: "enemy" } }, ctx, m, golem, false).report, "timing"), undefined);
});

test("пакет для критика: кадров по длине клипа, кадр удара — всегда в листе", async () => {
  const { reviewTimes } = await import("./node.ts");
  const ctx = await loadCtx(join(ROOT, "projects/worker-demo"));
  const hammer = ctx.project.clips.find((c) => c.name === "hammer")!;
  const hit = (await import("../../core/src/index.ts")).clipEvents(hammer).find((e) => e.name === "hit")!.t;
  const ts = reviewTimes(hammer);
  assert.ok(ts.length >= 6 && ts.length <= 12, String(ts));
  assert.ok(ts.some((t) => Math.abs(t - hit) < 1e-3), `${hit} в ${ts}`);
  assert.equal(ts[0], 0);
  assert.equal(reviewTimes({ ...hammer, duration: 3 }).length, 12, "3 с — потолок 12 кадров");
});
