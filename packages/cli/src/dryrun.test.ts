// Примерка в интерфейсе: команды выполняются на копии проекта, файл на диске не меняется.
import assert from "node:assert/strict";
import { cpSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ROOT, call, dryRun, projectFile } from "./node.ts";

test("dryRun: пресет примеряется на копии — в ответе новый клип со слоем, animforge.json не тронут, обычный call снова пишет", async () => {
  const dir = mkdtempSync(join(tmpdir(), "af-dry-"));
  try {
    cpSync(join(ROOT, "projects/fish-demo"), dir, { recursive: true });
    const before = readFileSync(projectFile(dir), "utf8");
    const { project } = await dryRun(dir, [
      { name: "clip.add", args: { name: "try", duration: 1.66 } },
      { name: "preset.apply", args: { clip: "try", preset: "dredge-ghost-shark-swim", chain: "body" } },
    ]);
    const clip = project.clips.find((c) => c.name === "try")!;
    assert.equal((clip.layers[0] as any).params.period, 0.83, "параметры из пресета, а не по умолчанию");
    assert.equal(readFileSync(projectFile(dir), "utf8"), before, "файл на диске не изменился");
    await assert.rejects(dryRun(dir, [{ name: "export", args: { out: "x.glb" } }]), /нельзя примерить/);
    await call(dir, "clip.add", { name: "real", duration: 1 });
    assert.ok(readFileSync(projectFile(dir), "utf8").includes('"real"'), "после примерки запись на диск работает");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
