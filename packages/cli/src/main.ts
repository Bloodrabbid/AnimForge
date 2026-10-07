// CLI: af <команда> [--аргумент значение]… [--project папка]. Ответ — JSON в stdout, ошибка — текст в stderr и код 1.
import { resolve } from "node:path";
import { COMMANDS } from "../../core/src/index.ts";
import { NODE_COMMANDS, call, listAll } from "./node.ts";

function parse(argv: string[]) {
  const [cmd, ...rest] = argv;
  const args: Record<string, string> = {};
  for (let i = 0; i < rest.length; i++) {
    const m = rest[i].match(/^--([\w.]+)(?:=(.*))?$/);
    if (!m) throw new Error(`непонятный аргумент «${rest[i]}» — ожидается --имя значение`);
    if (m[2] !== undefined) args[m[1]] = m[2];
    else if (i + 1 < rest.length && !rest[i + 1].startsWith("--")) args[m[1]] = rest[++i];
    else args[m[1]] = "true";
  }
  return { cmd, args };
}

function coerce(cmd: string, raw: Record<string, string>) {
  const spec = (COMMANDS[cmd] ?? NODE_COMMANDS[cmd])?.args ?? {};
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(raw)) {
    if (k === "project") continue;
    const type = spec[k]?.type ?? "string";
    out[k] = type === "number" ? Number(v) : type === "boolean" ? v === "true" : type === "json" ? JSON.parse(v) : v;
  }
  return out;
}

async function main() {
  const { cmd, args } = parse(process.argv.slice(2));
  if (!cmd || cmd === "help") {
    console.log(JSON.stringify(listAll(), null, 2));
    return;
  }
  const dir = resolve(args.project ?? process.cwd());
  const res = await call(dir, cmd, coerce(cmd, args));
  console.log(JSON.stringify(res, null, 2));
}

main().catch((e) => {
  console.error(`af: ${e.message}`);
  process.exit(1);
});
