// Глобальные Buffer и process — их ждут memfs и код CLI. Импортируется первым.
import { Buffer } from "buffer";

const g = globalThis as any;
g.Buffer ??= Buffer;
g.process ??= { env: {}, cwd: () => "/af", platform: "browser", versions: {}, nextTick: (f: (...a: unknown[]) => void, ...a: unknown[]) => queueMicrotask(() => f(...a)) };
g.process.env ??= {};
g.process.cwd ??= () => "/af";
g.global ??= globalThis;
