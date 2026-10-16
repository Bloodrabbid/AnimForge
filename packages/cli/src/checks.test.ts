// Автопроверки по коже на настоящей модели (рабочий Tools Up!): что ловят и что умеют чинить.
import assert from "node:assert/strict";
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { RECIPES, buildRig, posePartsAt, withDefaults } from "../../core/src/index.ts";
import { checkClip, checkProject, loadMesh } from "./checks.ts";
import { ROOT, call, loadCtx, smoothWeights } from "./node.ts";
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

test("таран корпусом: удар рукой, который рвёт кожу при любой силе, заменяется body-ram по роли; не рвёт — не трогаем", async () => {
  const { ramSwap } = await import("./checks.ts");
  const ctx = await loadCtx(join(ROOT, "projects/worker-demo"));
  const hammer = ctx.project.clips.find((c) => c.name === "hammer")!;
  // подставная «кожа»: рвётся, пока рука в ударе двигается
  const tears = (c: typeof hammer) => (c.layers.some((l) => l.type === "recipe" && l.recipe === "melee-strike" && /^arm_/.test(l.target.chain) && (l.weight ?? 1) > 0) ? 5 : 0.2);
  const npc = ramSwap({ ...ctx.project, style: { role: "npc" } }, hammer, hammer, tears)!;
  assert.equal(npc.preset, "ram-npc");
  assert.ok(npc.work.layers.some((l) => l.type === "recipe" && l.recipe === "body-ram"));
  assert.ok(!npc.work.layers.some((l) => l.type === "recipe" && l.recipe === "melee-strike"));
  assert.ok(npc.work.layers.some((l) => l.id === "ear_l"), "уши и прочие слои остаются");
  assert.deepEqual(npc.steps.map((s) => s.name), ["layer.remove", "recipe.add", "recipe.add", "clip.set"]);
  assert.deepEqual(npc.work.layers.filter((l) => l.type === "recipe" && l.recipe === "body-ram").map((l) => [(l as { target: { chain: string } }).target.chain, (l as { params: { role?: string } }).params.role]), [["pelvis", "pelvis"], ["head", "head"]], "таз ведёт, голова держит линию");
  assert.equal(ramSwap({ ...ctx.project, style: { role: "player" } }, hammer, hammer, tears)!.preset, "ram-player");
  assert.equal(ramSwap(ctx.project, hammer, hammer, () => 0.5), null, "кожа цела — удар остаётся");
  assert.equal(ramSwap(ctx.project, hammer, hammer, () => 5), null, "рвётся и без руки (колено) — таран не про это");
});

test("body-ram: замах назад, контакт вперёд на событии hit, корень не ниже покоя, длина до конца окна", async () => {
  const { RECIPES, withDefaults } = await import("../../core/src/index.ts");
  const def = RECIPES["body-ram"], p = withDefaults(def, {});
  const ev = def.events!(p), hit = ev.find((e) => e.name === "hit")!.t;
  assert.ok(Math.abs(hit - (p.windupT + p.hold + p.strikeT)) < 1e-9);
  const at = (t: number) => def.evaluate(p, 0, 1, t, { height: 1, size: 1 }) as Record<string, number>;
  assert.ok(at(p.windupT + p.hold / 2).pitch < -15, "замах назад");
  assert.ok(at(hit + p.contact / 2).pitch > 20, "контакт вперёд, сильнее замаха");
  assert.equal(at(hit + p.contact / 2).bank, 0, "на контакте без крена");
  for (let t = 0; t < def.length!(p); t += 0.02) assert.ok(at(t).move_up >= -1e-9, `корень в полу при ${t}`);
  assert.equal(def.length!(p), +(ev.find((e) => e.name === "window_close")!.t).toFixed(3));
});

test("окно ввода: нулевое у удара — предупреждение, починка ставит tail и удлиняет клип", async () => {
  const ctx = await loadCtx(join(ROOT, "projects/worker-demo"));
  const m = await loadMesh(ctx);
  const hammer = ctx.project.clips.find((c) => c.name === "hammer")!; // toolsup-hammer: tail 0
  const { report, steps } = checkClip(ctx.project, ctx, m, hammer, true);
  assert.ok(report.findings.some((f) => /окно ввода нулевое/.test(f.msg)));
  assert.ok(steps.some((s) => s.name === "recipe.set" && (s.args.params as { tail: number }).tail === 0.3));
  assert.ok(steps.some((s) => s.name === "clip.set" && s.args.fit));
});

test("починка весов: не помогло — модель как была и без *.orig.glb, в отчёте про сглаживание ни слова", async () => {
  const dir = copy("smooth-noop");
  const model = join(dir, (await loadCtx(dir)).project.model);
  const before = readFileSync(model);
  // ноль итераций — сглаживание ничего не меняет, но модель переписывается и бэкап создаётся, как у настоящего
  const reps = await checkProject(dir, ["hammer"], true, (d) => smoothWeights(d, 3, 0));
  assert.ok(!reps.some((r) => r.findings.some((f) => /веса сглажены/.test(f.msg))));
  assert.ok(!existsSync(model.replace(/\.glb$/, ".orig.glb")), "бэкап остался");
  assert.ok(readFileSync(model).equals(before), "модель не восстановлена");
});

test("body-ram из библиотеки (recipe.rig) ставит два слоя: таз и голову", async () => {
  const dir = copy("ram-rig");
  await call(dir, "clip.add", { name: "ram", duration: 2.5, loop: false });
  await call(dir, "recipe.rig", { clip: "ram", recipe: "body-ram", preset: "ram-npc" });
  const c = (await loadCtx(dir)).project.clips.find((x) => x.name === "ram")!;
  assert.deepEqual(c.layers.map((l) => (l as { params?: { role?: string } }).params?.role).sort(), ["head", "pelvis"]);
});

test("body-ram: голова гасит наклон корпуса и догоняет с запаздыванием", () => {
  const def = RECIPES["body-ram"];
  const p = withDefaults(def, {});
  const hit = def.events!(p).find((e) => e.name === "hit")!.t;
  const at = (role: string, t: number) => def.evaluate({ ...p, role }, 0, 1, t).pitch ?? 0;
  const body = at("pelvis", hit), head = at("head", hit);
  // в мире голова = корпус + свой слой: наклон меньше корпусного, но того же знака
  assert.ok(body > 10 && body + head > 0 && body + head < body * 0.7, `корпус ${body}, голова в мире ${body + head}`);
  // на контакте (поза держится) голова в мире ≈ (1 − hold) от корпуса
  const still = hit + 0.1;
  assert.ok(Math.abs(at("pelvis", still) + at("head", still) - (1 - p.headHold) * at("pelvis", still)) < 1.5, "голова не гасит наклон");
  // на быстром броске голова отстаёт: в мире она ещё позади доли (1 − hold) от корпуса
  const mid = hit - 0.05;
  assert.ok(at("pelvis", mid) + at("head", mid) < (1 - p.headHold) * at("pelvis", mid) - 0.5, "без запаздывания");
});

test("стопа скользит: проверка видит, починка подбирает фазу ног к тазу; «лунная» походка — брак", async () => {
  const dir = copy("slide");
  const ctx = await loadCtx(dir);
  const m = await loadMesh(ctx);
  const walk = ctx.project.clips.find((c) => c.name === "walk")!;
  const before = checkClip(ctx.project, ctx, m, walk, false).report;
  assert.equal(find(before, "slide")?.level, "warn", JSON.stringify(before.metrics));
  // полный путь починки: веса сглаживаются первыми, иначе кожа рабочего рвётся почти при любой фазе ног
  const [report] = await checkProject(dir, ["walk"], true);
  assert.match(report.findings.find((f) => f.check === "slide")?.fixed ?? "", /фаза ног/, JSON.stringify(report.findings));
  const ctx2 = await loadCtx(dir);
  const fixed = ctx2.project.clips.find((c) => c.name === "walk")!;
  assert.ok(fixed.layers.some((l) => l.type === "recipe" && Number(l.params.legPhase) > 0), "фаза ног не записана");
  const after = checkClip(ctx2.project, ctx2, await loadMesh(ctx2), fixed, false).report;
  assert.equal(find(after, "slide"), undefined, JSON.stringify(after.metrics));
  assert.ok(after.metrics.backward >= 80, `назад ${after.metrics.backward} %`);
  // ноги машут наоборот: опорная стопа едет вперёд
  const moon = structuredClone(walk);
  for (const l of moon.layers) if (l.type === "recipe" && /^leg_/.test(String(l.params.role))) l.params.legSwing = -30;
  assert.equal(find(checkClip(ctx.project, ctx, m, moon, false).report, "slide")?.level, "fail");
});

test("советы: правка по одной ручке с замером «что станет» — команды совета дают ровно обещанное", async () => {
  const dir = copy("advice");
  const ctx = await loadCtx(dir);
  const m = await loadMesh(ctx);
  const walk = ctx.project.clips.find((c) => c.name === "walk")!;
  const r = checkClip(ctx.project, ctx, m, walk, false).report;
  assert.match(r.text, /м\/с.*мм\) за шаг/, r.text);
  const slide = find(r, "slide") as { advice?: { text: string; after: number; steps: { name: string; args: Record<string, unknown> }[] }[] };
  assert.ok(slide?.advice?.length, "у скольжения нет совета");
  const best = slide.advice![0];
  assert.ok(best.after < r.metrics.slide / 100 / 0.05, `совет не лучше, чем есть: ${best.text}`);
  // применяем команды совета как есть — скольжение такое, как обещано
  for (const st of best.steps) await call(dir, st.name, st.args);
  const ctx2 = await loadCtx(dir);
  const r2 = checkClip(ctx2.project, ctx2, m, ctx2.project.clips.find((c) => c.name === "walk")!, false, false).report;
  const promised = Number(/проезжает ([\d.]+) %/.exec(best.text)?.[1]);
  assert.ok(Math.abs((r2.metrics.slide ?? 0) - promised) < 0.15, `обещано ${promised} %, стало ${r2.metrics.slide} %`);
  // провал в пол у ходьбы Геральта: совет — ступни на пол, и после него проверка пола проходит
  const geralt = ctx.project.clips.find((c) => c.name === "walk_geralt")!;
  const floor = find(checkClip(ctx.project, ctx, m, geralt, false).report, "floor") as typeof slide;
  assert.match(floor.advice?.[0]?.text ?? "", /ступни на пол.*проходит/, JSON.stringify(floor.advice));
  for (const st of floor.advice![0].steps) await call(dir, st.name, st.args);
  const ctx3 = await loadCtx(dir);
  assert.equal(find(checkClip(ctx3.project, ctx3, m, ctx3.project.clips.find((c) => c.name === "walk_geralt")!, false, false).report, "floor"), undefined);
});

test("hit-react из библиотеки: recipe.rig ставит таз и голову, все пресеты с ногами на полу проходят проверки", async () => {
  const dir = copy("react-rig");
  const lib = JSON.parse(readFileSync(join(ROOT, "library/presets/hit-react.json"), "utf8"));
  for (const pr of lib.presets) {
    await call(dir, "clip.add", { name: pr.name, duration: pr.params.duration, loop: false });
    await call(dir, "recipe.rig", { clip: pr.name, recipe: "hit-react", preset: pr.name });
    await call(dir, "clip.ground", { clip: pr.name, bones: "foot_l,foot_r", mode: "floor", ik: true, flat: true });
  }
  const ctx = await loadCtx(dir), mesh = await loadMesh(ctx);
  for (const pr of lib.presets) {
    const c = ctx.project.clips.find((x) => x.name === pr.name)!;
    assert.deepEqual(c.layers.filter((l) => l.type === "recipe").map((l) => (l as { params?: { role?: string } }).params?.role).sort(), ["head", "pelvis"], pr.name);
    const fails = checkClip(ctx.project, ctx, mesh, c, false).report.findings.filter((f) => f.level === "fail");
    assert.deepEqual(fails.map((f) => `${f.check}: ${(f as { msg?: string }).msg}`), [], pr.name);
  }
});
