// Клиент API dev-сервера. Любое изменение проекта — команда ядра через POST /api/command (тот же call(), что у CLI).
import type { Project, Skeleton } from "../../../packages/core/src/index.ts";

export interface Loaded {
  dir: string;
  project: Project;
  skeleton: Skeleton;
}

export async function fetchProject(dir: string): Promise<Loaded> {
  const r = await fetch(`/api/project?dir=${encodeURIComponent(dir)}`);
  const body = await r.json();
  if (!r.ok) throw new Error(body.error ?? `HTTP ${r.status}`);
  return body;
}

export async function command<T = unknown>(dir: string, name: string, args: Record<string, unknown>): Promise<T> {
  const r = await fetch("/api/command", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ dir, name, args }),
  });
  const body = await r.json();
  if (!body.ok) throw new Error(body.error ?? `HTTP ${r.status}`);
  return body.result as T;
}

export const modelUrl = (dir: string, model: string) => `/api/model?dir=${encodeURIComponent(dir)}&m=${encodeURIComponent(model)}`;

/** Подписка на изменения animforge.json на диске (в том числе от агента через CLI). */
export function watchProject(dir: string, onChange: () => void, onState: (live: boolean) => void) {
  const es = new EventSource(`/api/events?dir=${encodeURIComponent(dir)}`);
  es.addEventListener("hello", () => onState(true));
  es.addEventListener("change", () => onChange());
  es.onerror = () => onState(false);
  return () => es.close();
}

export interface PresetLib {
  recipe: string;
  presets: { name: string; help: string; params: Record<string, unknown> }[];
}

export interface Step {
  name: string;
  args: Record<string, unknown>;
}

/** Примерка: шаги на копии проекта; сервер возвращает получившийся проект и ничего не пишет. */
export async function preview(dir: string, steps: Step[], project?: Project): Promise<Project> {
  const r = await fetch("/api/preview", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ dir, steps, project }),
  });
  const body = await r.json();
  if (!body.ok) throw new Error(body.error ?? `HTTP ${r.status}`);
  return body.project;
}

export interface LibPreset {
  name: string;
  help: string;
  params: Record<string, unknown>;
  provenance?: { source: string; ref?: string }[];
}
export interface LibRecipe {
  recipe: string;
  help: string;
  roles: Record<string, { chain: string; optional: boolean }> | null;
  presets: LibPreset[];
}

export const fetchLibrary = (): Promise<LibRecipe[]> => fetch("/api/library").then((r) => r.json());
export const fetchProjects = (): Promise<string[]> => fetch("/api/projects").then((r) => r.json());
export const downloadUrl = (dir: string, opts: { format?: "fbx"; units?: string; names?: string } = {}) =>
  `/api/download?${new URLSearchParams({ dir, ...opts })}`;

/** Своя модель → новый проект в out/uploads (импорт через Blender и rig.detect на сервере). */
export async function uploadModel(file: File): Promise<{ dir: string; body?: string }> {
  const r = await fetch("/api/upload", { method: "POST", headers: { "x-filename": encodeURIComponent(file.name) }, body: file });
  const body = await r.json();
  if (!body.ok) throw new Error(body.error ?? `HTTP ${r.status}`);
  return body;
}

/** Веса кожи из редактора → в glb модели (первый раз сервер сохранит исходник рядом). restore — вернуть исходные. */
export async function saveWeights(dir: string, parts: unknown[] | null): Promise<void> {
  const r = await fetch("/api/weights", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(parts ? { dir, parts } : { dir, restore: true }),
  });
  const body = await r.json();
  if (!body.ok) throw new Error(body.error ?? `HTTP ${r.status}`);
}

/** Пак готовых клипов (library/clips): происхождение и дубли. */
export interface ClipPackInfo {
  id: string;
  name: string;
  author: string;
  license: string;
  url: string;
  skeleton: string;
  takes: { name: string; duration: number }[];
}
export const fetchClips = (): Promise<ClipPackInfo[]> => fetch("/api/clips").then((r) => r.json());
