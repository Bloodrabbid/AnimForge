// Импорт готовых клипов (clip.import): свой запечённый glb обратно на тот же скелет — кость в кость; пак Quaternius
// (CC0, library/clips) на рабочего Tools Up! — направления костей в осях тела те же, что у источника, ход таза — по росту.
import assert from "node:assert/strict";
import { cpSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { NodeIO } from "@gltf-transform/core";
import { bodyFrame, buildRig, importClip, importPlan, posePartsAt, qaxis, qmul, qrot, vdot, vnorm, vsub, worldPose, type Vec3 } from "../../core/src/index.ts";
import { animSkeleton, readTakes } from "./animfile.ts";
import { BLENDER, NODE_COMMANDS, ROOT, detectSide, exportFile, exportGlb, loadCtx } from "./node.ts";

const UAL = join(ROOT, "library/clips/quaternius-ual1.glb");

test("clip.import своего glb на тот же скелет — кость в кость", async () => {
  const dir = mkdtempSync(join(tmpdir(), "af-imp-"));
  cpSync(join(ROOT, "projects/worker-demo"), dir, { recursive: true });
  // пределы суставов действуют и на основу; у запечённого клипа IK стопы мог выйти за них — здесь сверяем сам перенос
  const pf = join(dir, "animforge.json");
  const p = JSON.parse(readFileSync(pf, "utf8"));
  delete p.limits;
  writeFileSync(pf, JSON.stringify(p));
  const ctx = await loadCtx(dir);
  await exportGlb(ctx, join(dir, "all.glb"));
  await NODE_COMMANDS["clip.import"].run(dir, { file: join(dir, "all.glb"), as: "imp_" });
  const after = await loadCtx(dir);
  const rig = buildRig(after.skeleton);
  for (const c of ctx.project.clips) {
    const m = after.project.clips.find((x) => x.name === "imp_" + c.name)!;
    // цикл узнаётся по совпадению первого и последнего кадра: у удара, вернувшегося в стойку, — тоже цикл
    if (c.loop) assert.ok(m.loop, `${c.name}: цикл не узнан`);
    assert.ok(Math.abs(m.duration - c.duration) < 1e-4, `${c.name}: длина ${m.duration} ≠ ${c.duration}`);
    // в кадрах запекания (между ними обе стороны — линейные ключи против живого расчёта); клип, который стал циклом
    // при импорте (не был им в источнике), замкнут: остаток до 3° разложен по клипу — там допуск шире
    const tol = !c.loop && m.loop ? 3e-3 : 5e-4;
    for (let t = 0; t < c.duration; t += 2 / 30) {
      const a = worldPose(rig, posePartsAt(ctx.project, rig, c, t)).T, b = worldPose(rig, posePartsAt(after.project, rig, m, t)).T;
      a.forEach((v, i) => assert.ok(Math.hypot(...vsub(v, b[i])) < tol, `${c.name} t=${t.toFixed(2)} ${rig.skel.nodes[i].name}: ${Math.hypot(...vsub(v, b[i])).toFixed(4)} м`));
    }
  }
});

test("Quaternius (Rigify, T-поза) → рабочий: направления костей и ход таза", async () => {
  const doc = await new NodeIO().read(UAL);
  const src = detectSide(animSkeleton(doc));
  const ctx = await loadCtx(join(ROOT, "projects/worker-demo"));
  // выравнивание покоя у цели (как у T-позы Mixamo): основа должна его учесть, а не прибавить к нему
  const dst = { project: { ...ctx.project, align: { arm_l: { to: "down" as const, abduct: 8 }, arm_r: { to: "down" as const, abduct: 8 } } }, rig: buildRig(ctx.skeleton) };
  const plan = importPlan(src, dst);
  const names = new Map([...plan.from].map(([j, i]) => [dst.rig.skel.nodes[j].name, src.rig.skel.nodes[i].name]));
  // руки, ноги, корпус и голова нашлись
  for (const b of ["pelvis", "chest", "head", "arm_l_0", "arm_l_1", "arm_r_0", "leg_l_0", "leg_l_1", "leg_r_1", "foot_l"]) assert.ok(names.has(b), `нет пары у ${b}`);
  const sf = bodyFrame(src.project), df = bodyFrame(dst.project);
  const inBody = (v: Vec3, f: typeof sf): Vec3 => { const n = vnorm(v); return [vdot(n, f.side), vdot(n, f.up), vdot(n, f.forward)]; };
  for (const take of ["Walk_Loop", "Sword_Attack", "Roll_RM"]) {
    const tk = readTakes(doc, 30, [take])[0];
    const r = importClip(src, dst, tk.frames, { name: take, loop: take.endsWith("Loop") });
    const noLimits = { ...dst.project, limits: undefined };
    let worst = 0, what = "";
    for (const fi of [0, 7, 15, 23, 31]) {
      const f = tk.frames[fi];
      const S = worldPose(src.rig, { rot: new Map(Object.entries(f.rot)), pos: new Map(Object.entries(f.pos)), scl: new Map() }).T;
      const D = worldPose(dst.rig, posePartsAt(noLimits, dst.rig, r.clip, f.t)).T;
      // направление «кость → сопоставленный ребёнок» у источника и у цели, в осях своего тела
      for (const [a, b] of [["arm_l_0", "arm_l_1"], ["arm_r_0", "arm_r_1"], ["leg_l_0", "leg_l_1"], ["leg_r_0", "leg_r_1"], ["leg_l_1", "foot_l"], ["pelvis", "chest"]]) {
        const sa = src.rig.index.get(names.get(a)!)!, sb = src.rig.index.get(names.get(b)!)!;
        const u = inBody(vsub(S[sb], S[sa]), sf), v = inBody(vsub(D[dst.rig.index.get(b)!], D[dst.rig.index.get(a)!]), df);
        const e = (Math.acos(Math.min(1, vdot(u, v))) * 180) / Math.PI;
        if (e > worst) { worst = e; what = `${a}→${b} кадр ${fi}`; }
      }
    }
    assert.ok(worst < 1, `${take}: направление ${what} расходится на ${worst.toFixed(2)}°`);
    // ход таза — путь источника в осях тела, умноженный на отношение ростов
    const sp = src.rig.index.get(src.project.chains.pelvis![0])!;
    const last = tk.frames[tk.frames.length - 1], f0 = tk.frames[0];
    const P = (f: typeof f0) => worldPose(src.rig, { rot: new Map(Object.entries(f.rot)), pos: new Map(Object.entries(f.pos)), scl: new Map() }).T[sp];
    const sMove = inBody(vsub(P(last), P(f0)), sf), sLen = Math.hypot(...vsub(P(last), P(f0)));
    const k = r.clip.layers[0].type === "pose" ? r.clip.layers[0].keys : [];
    const dm = vsub(k[k.length - 1].move!.pelvis, k[0].move!.pelvis);
    if (sLen > 0.05) {
      assert.ok(Math.abs(Math.hypot(...dm) - sLen * r.scale) < 1e-3, `${take}: путь таза ${Math.hypot(...dm).toFixed(3)} ≠ ${(sLen * r.scale).toFixed(3)}`);
      assert.ok(vdot(inBody(dm, df), sMove) > 0.999, `${take}: путь таза не туда`);
    }
  }
});

test("Quaternius, повёрнутый на 90° и вдвое больше, — та же основа", async () => {
  const doc = await new NodeIO().read(UAL);
  const skel = animSkeleton(doc);
  const ctx = await loadCtx(join(ROOT, "projects/worker-demo"));
  const dst = { project: ctx.project, rig: buildRig(ctx.skeleton) };
  const tk = readTakes(doc, 30, ["Roll_RM"])[0];
  const a = importClip(detectSide(skel), dst, tk.frames, { name: "a", loop: false });
  // тот же скелет: корень повёрнут вокруг вертикали и увеличен вдвое — кадры те же, иначе только оси и рост
  const turn = qaxis([0, 1, 0], Math.PI / 2);
  const top = skel.nodes.findIndex((n) => n.parent == null && skel.nodes.some((m) => m.isJoint));
  const rot = { nodes: skel.nodes.map((n, i) => (i === top ? { ...n, restR: qmul(turn, n.restR), restS: n.restS.map((x) => x * 2) as Vec3, restT: qrot(turn, n.restT) } : n)) };
  const frames = tk.frames.map((f) => ({ ...f, rot: { ...f.rot, ...(f.rot[skel.nodes[top].name] ? { [skel.nodes[top].name]: qmul(turn, f.rot[skel.nodes[top].name]) } : {}) } }));
  const b = importClip(detectSide(rot), dst, frames, { name: "b", loop: false });
  assert.ok(Math.abs(b.scale * 2 - a.scale) < 1e-3, `рост: ${b.scale} × 2 ≠ ${a.scale}`);
  const ka = a.clip.layers[0].type === "pose" ? a.clip.layers[0].keys : [], kb = b.clip.layers[0].type === "pose" ? b.clip.layers[0].keys : [];
  let worst = 0;
  for (const t of [0.2, 0.7, 1.1]) {
    const A = worldPose(dst.rig, posePartsAt(dst.project, dst.rig, a.clip, t)).T, B = worldPose(dst.rig, posePartsAt(dst.project, dst.rig, b.clip, t)).T;
    A.forEach((v, i) => (worst = Math.max(worst, Math.hypot(...vsub(v, B[i])))));
  }
  assert.ok(worst < 2e-3, `повёрнутый источник дал другую позу: ${worst.toFixed(4)} м`);
  assert.ok(Math.hypot(...vsub(ka[ka.length - 1].move!.pelvis, kb[kb.length - 1].move!.pelvis)) < 2e-3, "ход таза другой");
});

test("через FBX: имена Mixamo (Unity, сантиметры) и Unreal (Z вверх) — обратно кость в кость", { skip: !existsSync(BLENDER) && "нет Blender" }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "af-impfbx-"));
  cpSync(join(ROOT, "projects/worker-demo"), dir, { recursive: true });
  const pf = join(dir, "animforge.json");
  const p = JSON.parse(readFileSync(pf, "utf8"));
  delete p.limits;
  p.clips = p.clips.filter((c: { name: string }) => ["walk_geralt", "hammer"].includes(c.name));
  writeFileSync(pf, JSON.stringify(p));
  const ctx = await loadCtx(dir);
  for (const [names, units] of [["mixamo", "unity"], ["unreal", "unreal"]] as const) {
    await exportFile(ctx, join(dir, `${names}.fbx`), names, units);
    await NODE_COMMANDS["clip.import"].run(dir, { file: join(dir, `${names}.fbx`), as: `${names}_` });
  }
  const after = await loadCtx(dir);
  const rig = buildRig(after.skeleton);
  for (const c of ctx.project.clips) for (const pre of ["mixamo_", "unreal_"]) {
    const m = after.project.clips.find((x) => x.name === pre + c.name)!;
    assert.ok(m, `нет ${pre}${c.name}`);
    for (let t = 0; t < c.duration; t += 3 / 30) {
      const a = worldPose(rig, posePartsAt(ctx.project, rig, c, t)).T, b = worldPose(rig, posePartsAt(after.project, rig, m, t)).T;
      a.forEach((v, i) => assert.ok(Math.hypot(...vsub(v, b[i])) < 5e-4, `${pre}${c.name} t=${t.toFixed(2)} ${rig.skel.nodes[i].name}: ${Math.hypot(...vsub(v, b[i])).toFixed(4)} м`));
    }
  }
});

test("волк Quaternius (с IK-костями ног и концевыми метками) → четвероногое демо: ноги туда же", async () => {
  const doc = await new NodeIO().read(join(ROOT, "library/clips/quaternius-animals2-wolf.glb"));
  const src = detectSide(animSkeleton(doc));
  assert.equal(src.body, "quadruped", "волк должен распознаться четвероногим");
  const ctx = await loadCtx(join(ROOT, "projects/quadruped-demo"));
  const dst = { project: { ...ctx.project, limits: undefined }, rig: buildRig(ctx.skeleton) };
  const plan = importPlan(src, dst);
  const names = new Map([...plan.from].map(([j, i]) => [dst.rig.skel.nodes[j].name, src.rig.skel.nodes[i].name]));
  const tk = readTakes(doc, 30, [doc.getRoot().listAnimations().find((a) => /walk/i.test(a.getName()))!.getName()])[0];
  const r = importClip(src, dst, tk.frames, { name: "w", loop: true });
  const sf = bodyFrame(src.project), df = bodyFrame(dst.project);
  const inBody = (v: Vec3, f: typeof sf): Vec3 => { const n = vnorm(v); return [vdot(n, f.side), vdot(n, f.up), vdot(n, f.forward)]; };
  let worst = 0, what = "";
  for (const fi of [0, 5, 10, 15]) {
    const f = tk.frames[fi];
    const S = worldPose(src.rig, { rot: new Map(Object.entries(f.rot)), pos: new Map(Object.entries(f.pos)), scl: new Map() }).T;
    const D = worldPose(dst.rig, posePartsAt(dst.project, dst.rig, r.clip, f.t)).T;
    for (const ch of ["arm_l", "arm_r", "leg_l", "leg_r"]) {
      const c = dst.project.chains[ch]!;
      const [a, b] = [c[0], c[1]];
      if (!names.has(a) || !names.has(b)) { assert.fail(`нет пары у ${a} или ${b}`); }
      const u = inBody(vsub(S[src.rig.index.get(names.get(b)!)!], S[src.rig.index.get(names.get(a)!)!]), sf);
      const v = inBody(vsub(D[dst.rig.index.get(b)!], D[dst.rig.index.get(a)!]), df);
      const e = (Math.acos(Math.min(1, vdot(u, v))) * 180) / Math.PI;
      if (e > worst) { worst = e; what = `${ch} кадр ${fi}`; }
    }
  }
  assert.ok(worst < 1, `направление ${what} расходится на ${worst.toFixed(2)}°`);
});

test("робот Quaternius: меш и кость с одним именем не ломают скелет", async () => {
  const doc = await new NodeIO().read(join(ROOT, "library/clips/quaternius-robot.glb"));
  const raw = doc.getRoot().listNodes().map((n) => n.getName());
  assert.ok(raw.length > new Set(raw).size, "в файле должны быть повторы имён — иначе тест ничего не проверяет");
  const sk = animSkeleton(doc);
  assert.equal(new Set(sk.nodes.map((n) => n.name)).size, sk.nodes.length);
  const s = detectSide(sk);
  assert.equal(s.body, "biped");
  const tk = readTakes(doc, 30)[0];
  const ctx = await loadCtx(join(ROOT, "projects/worker-demo"));
  const r = importClip(s, { project: ctx.project, rig: buildRig(ctx.skeleton) }, tk.frames, { name: "r", loop: false });
  assert.ok(r.clip.layers[0].type === "pose" && r.clip.layers[0].keys.length === tk.frames.length);
});

test("ручные пары костей: своя пара поверх найденной, null — не переносить", async () => {
  const doc = await new NodeIO().read(UAL);
  const src = detectSide(animSkeleton(doc));
  const ctx = await loadCtx(join(ROOT, "projects/worker-demo"));
  const dst = { project: ctx.project, rig: buildRig(ctx.skeleton) };
  const name = (s: typeof src | typeof dst, i: number) => s.rig.skel.nodes[i].name;
  const pairs = (m: Map<number, number>) => new Map([...m].map(([j, i]) => [name(dst, j), name(src, i)]));
  const auto = pairs(importPlan(src, dst).from);
  assert.equal(auto.get("arm_l_1"), "DEF-forearm.L");
  const hand = pairs(importPlan(src, dst, { "DEF-hand.L": "arm_l_1" }).from);
  assert.equal(hand.get("arm_l_1"), "DEF-hand.L", "ручная пара перекрывает найденную");
  const off = pairs(importPlan(src, dst, { "DEF-forearm.L": null }).from);
  assert.ok(![...off.values()].includes("DEF-forearm.L"), "null снимает кость источника");
  assert.throws(() => importPlan(src, dst, { "нет-такой": "arm_l_1" }), /нет кости/);
  // в клипе ручная пара и правда меняет позу предплечья
  const tk = readTakes(doc, 30, ["Sword_Attack"])[0];
  const a = importClip(src, dst, tk.frames, { name: "a", loop: false }), b = importClip(src, dst, tk.frames, { name: "b", loop: false, map: { "DEF-hand.L": "arm_l_1" } });
  const ka = a.clip.layers[0].type === "pose" ? a.clip.layers[0].keys[10].rot!.arm_l_1 : undefined;
  const kb = b.clip.layers[0].type === "pose" ? b.clip.layers[0].keys[10].rot!.arm_l_1 : undefined;
  assert.notDeepEqual(ka, kb);
});

test("KayKit: IK и контроллеры (kneeIK, IK-foot, control-…) — не кости тела", async () => {
  const doc = await new NodeIO().read(join(ROOT, "library/clips/kaykit-skeletons.glb"));
  const sk = animSkeleton(doc);
  const joints = sk.nodes.filter((n) => n.isJoint).map((n) => n.name);
  assert.ok(joints.includes("hand.l") && joints.includes("upperleg.r"));
  assert.deepEqual(joints.filter((n) => /ik|control/i.test(n)), []);
});

test("петля мокапа замыкается: остаток «начало − конец» разложен по клипу, ход вперёд не тронут", async () => {
  const { closeLoop, qaxis } = await import("../../core/src/index.ts");
  const ang = (a: number[], b: number[]) => 2 * Math.acos(Math.min(1, Math.abs(a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3]))) * (180 / Math.PI);
  // кость поворачивается за клип на 30°, но запись кончилась на 10° дальше начала цикла; таз уехал на 1 м и поднялся на 4 см
  const keys = [0, 0.5, 1].map((t) => ({ t, rot: { arm: qaxis([1, 0, 0], ((t * 10) * Math.PI) / 180) as [number, number, number, number] }, move: { pelvis: [0, 0.04 * t, t] as [number, number, number] } }));
  const mid = { ...keys[1].rot.arm };
  closeLoop(keys as any, [0, 1, 0]);
  assert.ok(ang(keys[2].rot.arm, keys[0].rot.arm) < 0.01, `конец = начало: ${ang(keys[2].rot.arm, keys[0].rot.arm).toFixed(3)}°`);
  assert.ok(Math.abs(ang(keys[1].rot.arm, Object.values(mid)) - 5) < 0.01, "середина поправлена на половину остатка");
  assert.ok(Math.abs(keys[2].move.pelvis[1] - keys[0].move.pelvis[1]) < 1e-5, "по высоте — замкнуто");
  assert.equal(keys[2].move.pelvis[2], 1, "ход вперёд — как был (in place или root motion решают дальше)");
});

test("запись из середины зала захвата (100STYLE) начинается над началом координат и идёт вперёд, высота — как есть", async () => {
  const dir = mkdtempSync(join(tmpdir(), "af-imp-"));
  cpSync(join(ROOT, "projects/worker-demo"), dir, { recursive: true });
  await NODE_COMMANDS["clip.import"].run(dir, { pack: "100style-walk", take: "walk_Akimbo_loop", as: "w" });
  const { project, skeleton } = await loadCtx(dir);
  const rig = buildRig(skeleton), up = bodyFrame(project).up, pi = rig.index.get(project.chains.pelvis[0])!;
  const c = project.clips.find((x) => x.name === "w")!;
  const flat = (v: Vec3) => vsub(v, up.map((u) => u * vdot(v, up)) as Vec3);
  const at = (t: number) => worldPose(rig, posePartsAt(project, rig, c, t)).T[pi];
  const d0 = Math.hypot(...flat(vsub(at(0), rig.worldT[pi])));
  assert.ok(d0 < 1e-3, `таз в начале клипа в ${d0.toFixed(3)} м от покоя по горизонтали`);
  const go = flat(vsub(at(c.duration * 0.9), at(0)));
  assert.ok(Math.hypot(...go) > 0.5, "ход вперёд остался");
  // на полу: поза покоя 100STYLE стоит тазом в нуле — без поправки клип висит на высоту таза
  const under = (i: number): boolean => i === pi || (rig.parent[i] >= 0 && under(rig.parent[i]));
  const js = skeleton.nodes.flatMap((n, i) => (n.isJoint && under(i) ? [i] : [])); // неподвижный корень над тазом — не в счёт
  const lowRest = Math.min(...js.map((i) => vdot(rig.worldT[i], up)));
  let low = Infinity;
  for (let t = 0; t <= c.duration; t += c.duration / 20) { const T = worldPose(rig, posePartsAt(project, rig, c, t)).T; low = Math.min(low, ...js.map((i) => vdot(T[i], up))); }
  const H = Math.max(...js.map((i) => vdot(rig.worldT[i], up))) - lowRest;
  assert.ok(Math.abs(low - lowRest) < 0.05 * H, `нижний сустав за клип в ${(low - lowRest).toFixed(3)} м от пола покоя`);
  // пак развёрнут лицом вперёд: ход идёт по «вперёд» модели, а не куда шёл актёр в зале
  assert.ok(vdot(vnorm(go), bodyFrame(project).forward) > 0.97, `ход под углом ${((Math.acos(vdot(vnorm(go), bodyFrame(project).forward)) * 180) / Math.PI).toFixed(0)}° к «вперёд»`);
});
