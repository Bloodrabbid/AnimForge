// Проект одним файлом (.afproj) и автосохранение: упаковали → распаковали → тот же проект; каждая правка кладёт
// прошлую версию в .autosave/, любую можно вернуть, старые сверх AUTOSAVE_KEEP уходят.
import assert from "node:assert/strict";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { AUTOSAVE_KEEP, NODE_COMMANDS, ROOT, call, loadCtx } from "./node.ts";

const copy = () => {
  const dir = mkdtempSync(join(tmpdir(), "af-proj-"));
  cpSync(join(ROOT, "projects/worker-demo"), dir, { recursive: true });
  rmSync(join(dir, ".autosave"), { recursive: true, force: true });
  return dir;
};

test(".afproj: упаковали и распаковали — тот же проект, без out/", async () => {
  const dir = copy();
  mkdirSync(join(dir, "out"), { recursive: true });
  writeFileSync(join(dir, "out/big.glb"), "x".repeat(1000));
  const r = (await NODE_COMMANDS["project.pack"].run(dir, { out: join(dir, "out/p.afproj") })) as { out: string; files: number };
  const into = join(mkdtempSync(join(tmpdir(), "af-unp-")), "p");
  await NODE_COMMANDS["project.unpack"].run(into, { file: r.out });
  assert.ok(!existsSync(join(into, "out")), "out/ не должен попасть в архив");
  const a = await loadCtx(dir), b = await loadCtx(into);
  assert.deepEqual(b.project, a.project);
  assert.deepEqual(b.skeleton, a.skeleton);
  await assert.rejects(NODE_COMMANDS["project.unpack"].run(into, { file: r.out }), /не пустая/);
});

test("автосохранение: прошлая версия — в истории, откат и откат отката, не больше AUTOSAVE_KEEP", async () => {
  const dir = copy();
  const orig = readFileSync(join(dir, "animforge.json"), "utf8");
  await call(dir, "clip.add", { name: "one", duration: 1 });
  await call(dir, "clip.add", { name: "two", duration: 1 });
  const h = (await call(dir, "project.history", {})) as { id: string; clips: number }[];
  assert.equal(h.length, 2);
  assert.equal(readFileSync(join(dir, ".autosave", `${h[1].id}.json`), "utf8"), orig, "самая старая версия — исходный проект");
  await call(dir, "project.restore", { id: h[1].id });
  assert.equal(readFileSync(join(dir, "animforge.json"), "utf8"), orig);
  const h2 = (await call(dir, "project.history", {})) as { id: string; clips: number }[];
  const n0 = JSON.parse(orig).clips.length;
  assert.equal(h2[0].clips, n0 + 2, "версия перед откатом (с one и two) тоже в истории");
  for (let i = 0; i < AUTOSAVE_KEEP + 5; i++) await call(dir, "clip.add", { name: `c${i}`, duration: 1 });
  assert.equal(readdirSync(join(dir, ".autosave")).length, AUTOSAVE_KEEP);
});
