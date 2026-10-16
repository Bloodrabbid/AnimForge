// Лицензии основы клипа: CC BY — напоминание об авторах, CC BY-NC — ещё и «не на продажу»; CC0 и CMU — молча.
// В библиотеку CC BY без условий (кого указать) не кладётся, чужие лицензии (CC BY-SA, ND) — тоже.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { Clip } from "../../core/src/index.ts";
import { licenseFinding } from "./checks.ts";
import { NODE_COMMANDS } from "./node.ts";

const clip = (license?: string): Clip => ({ name: "c", duration: 1, loop: false, layers: [{ id: "base", type: "pose", keys: [], ...(license ? { source: { file: "x.glb", take: "t", author: "Автор", license } } : {}) }] }) as unknown as Clip;

test("лицензия основы: NC — не на продажу, BY — авторы в титрах, CC0/CMU/без источника — молча", () => {
  const nc = licenseFinding(clip("CC BY-NC 4.0"));
  assert.equal(nc?.level, "warn");
  assert.match(nc!.msg, /на продажу нельзя/);
  assert.match(nc!.msg, /Автор \(CC BY-NC 4\.0\)/);
  const by = licenseFinding(clip("CC BY 4.0"));
  assert.ok(by && !/продажу/.test(by.msg));
  assert.match(by!.msg, /в титрах игры — Автор/);
  for (const l of ["CC0", "CMU", undefined]) assert.equal(licenseFinding(clip(l)), undefined, String(l));
});

test("clips.pack: CC BY без условий и чужие лицензии не берёт", async () => {
  const run = (license: string, terms?: string) => NODE_COMMANDS["clips.pack"].run("/tmp", { file: "/nonexistent.glb", id: "x", name: "x", author: "a", url: "u", license, ...(terms ? { terms } : {}) });
  await assert.rejects(run("CC BY 4.0"), /нужны terms/);
  await assert.rejects(run("CC BY-SA 4.0", "t"), /только CC0/);
  await assert.rejects(run("CC BY-NC-ND 4.0", "t"), /только CC0/);
  // с условиями проходит проверку лицензии и падает уже на чтении несуществующего файла
  await assert.rejects(run("CC BY-NC 4.0", "t"), (e: Error) => !/только CC0|нужны terms/.test(e.message));
});
