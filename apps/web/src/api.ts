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
