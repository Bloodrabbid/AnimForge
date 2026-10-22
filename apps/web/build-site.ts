// Сборка сайта в out/site: страница (vite.site.config.ts), Service Worker (vite.sw.config.ts) и данные.
// Данные — только то, что лежит в git: библиотека рецептов, твинов и клипов, демо-проекты. Паки клипов — «ленивые».
//   pnpm site            — собрать;  pnpm site:serve — собрать и открыть локально как на GitHub Pages
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { build } from "vite";
import { ROOT } from "../../packages/cli/src/node.ts";
import { clipTakes } from "./routes.ts";

const HERE = join(ROOT, "apps/web");
const OUT = join(ROOT, "out/site");
await build({ configFile: join(HERE, "vite.site.config.ts"), logLevel: "warn" });
await build({ configFile: join(HERE, "vite.sw.config.ts"), logLevel: "warn" });

const tracked = execFileSync("git", ["ls-files", "library/presets", "library/tweens", "library/clips", "projects"], { cwd: ROOT, encoding: "utf8" })
  .split("\n")
  .filter((f) => f && !f.startsWith("library/clips/build/"));
const eager: string[] = [], lazy: string[] = [];
for (const f of tracked) {
  mkdirSync(dirname(join(OUT, "data", f)), { recursive: true });
  copyFileSync(join(ROOT, f), join(OUT, "data", f));
  (f.startsWith("library/clips/") && f.endsWith(".glb") ? lazy : eager).push(f);
}
// дубли паков заранее: иначе первый показ библиотеки клипов качал бы все паки ради имён
writeFileSync(join(OUT, "data/library/clips/takes.json"), JSON.stringify(await clipTakes()));
eager.push("library/clips/takes.json");
const version = execFileSync("git", ["rev-parse", "--short", "HEAD"], { cwd: ROOT, encoding: "utf8" }).trim() + "-" + Date.now().toString(36);
writeFileSync(join(OUT, "data/manifest.json"), JSON.stringify({ version, eager, lazy }));
writeFileSync(join(OUT, ".nojekyll"), ""); // GitHub Pages не трогает файлы с подчёркиванием
const mb = (fs: string[]) => (fs.reduce((s, f) => s + statSync(join(OUT, "data", f)).size, 0) / 1e6).toFixed(1);
console.log(`SITE_OK ${OUT}: сразу ${eager.length} файлов (${mb(eager)} МБ), по требованию ${lazy.length} (${mb(lazy)} МБ), версия ${version}`);
