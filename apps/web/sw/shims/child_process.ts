// node:child_process для сайта: Blender и Godot в браузере не запустить — честная ошибка вместо падения.
const no = (): never => {
  throw new Error("На сайте это недоступно: нужен Blender или Godot. Скачай AnimForge и запусти локально (pnpm web).");
};
export const execFileSync = no;
export const execSync = no;
export const spawn = no;
export const spawnSync = no;
export default { execFileSync, execSync, spawn, spawnSync };
