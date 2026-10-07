// Главное окно: вьюпорт, время, кости, слои, ключи, строка статуса.
// Интерфейс ничего не считает сам: поза — poseAt из ядра, изменения — команды ядра через API.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { buildRig, type Project } from "../../../packages/core/src/index.ts";
import { command, fetchProject, modelUrl, watchProject, type Loaded, type PresetLib } from "./api.ts";
import { BoneTree } from "./BoneTree.tsx";
import { KeysPanel } from "./KeysPanel.tsx";
import { LayersPanel } from "./LayersPanel.tsx";
import { Timeline } from "./Timeline.tsx";
import { Viewport } from "./Viewport.tsx";

const query = new URLSearchParams(location.search);
const DIR = query.get("dir") ?? "projects/fish-demo";

export interface Status {
  text: string;
  error: boolean;
  at: number;
}

export function App() {
  const [data, setData] = useState<Loaded | null>(null);
  // рабочая копия проекта: совпадает с диском, кроме момента перетаскивания ползунка
  const [project, setProject] = useState<Project | null>(null);
  const [clipName, setClipName] = useState<string | null>(query.get("clip"));
  const [t, setT] = useState(Number(query.get("t") ?? 0) || 0);
  const [playing, setPlaying] = useState(query.get("paused") !== "1");
  const [selectedBone, setSelectedBone] = useState<string | null>(query.get("bone"));
  const [showSkeleton, setShowSkeleton] = useState(query.get("skeleton") !== "0");
  const [status, setStatus] = useState<Status>({ text: "загрузка проекта…", error: false, at: Date.now() });
  const [presets, setPresets] = useState<PresetLib[]>([]);
  const [live, setLive] = useState(false);
  const ownWriteAt = useRef(0); // когда интерфейс сам последний раз писал на диск

  const say = useCallback((text: string, error = false) => setStatus({ text, error, at: Date.now() }), []);

  const reload = useCallback(async () => {
    try {
      const d = await fetchProject(DIR);
      setData(d);
      setProject(d.project);
      return d;
    } catch (e) {
      say(`не удалось прочитать проект: ${(e as Error).message}`, true);
    }
  }, [say]);

  useEffect(() => {
    reload().then((d) => d && say(`проект ${d.project.name} загружен из ${d.dir}`));
    command<PresetLib[]>(DIR, "preset.list", {}).then(setPresets, (e) => say(`пресеты: ${e.message}`, true));
    // агент или человек поменял animforge.json на диске — перечитываем
    return watchProject(
      DIR,
      () =>
        reload().then((d) => {
          // эхо собственной команды не объявляем — в статусе остаётся её результат
          if (d && Date.now() - ownWriteAt.current > 1500) say("animforge.json изменён на диске — проект перечитан");
        }),
      setLive,
    );
  }, [reload, say]);

  /** Единственный способ изменить проект из интерфейса — команда ядра. */
  const run = useCallback(
    async (name: string, args: Record<string, unknown>) => {
      try {
        ownWriteAt.current = Date.now();
        const res = await command(DIR, name, args);
        ownWriteAt.current = Date.now();
        say(`${name}: ок — ${short(res)}`);
        await reload();
        return res;
      } catch (e) {
        say(`${name}: ${(e as Error).message}`, true);
        await reload(); // вернуть рабочую копию к диску
      }
    },
    [reload, say],
  );

  const rig = useMemo(() => (data ? buildRig(data.skeleton) : null), [data?.skeleton]);
  const clip = project?.clips.find((c) => c.name === clipName) ?? project?.clips[0];

  // проигрывание: время двигает интерфейс, позу считает ядро во вьюпорте
  useEffect(() => {
    if (!playing || !clip) return;
    let raf = 0;
    let last = performance.now();
    const tick = (now: number) => {
      const dt = (now - last) / 1000;
      last = now;
      setT((t) => {
        const n = t + dt;
        if (n <= clip.duration) return n;
        return clip.loop ? n % clip.duration : clip.duration;
      });
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playing, clip?.duration, clip?.loop]);

  if (!data || !project || !rig) {
    return <div className={`boot ${status.error ? "error" : ""}`}>{status.text}</div>;
  }

  return (
    <div className="app">
      <header className="top">
        <b>AnimForge</b>
        <span className="muted">{project.name}</span>
        <span className="muted">{data.dir}/animforge.json</span>
        <span className={`live ${live ? "on" : ""}`} title="сервер следит за animforge.json и присылает изменения">
          {live ? "● связь с диском" : "○ нет связи с диском"}
        </span>
      </header>
      <aside className="left">
        <BoneTree skeleton={data.skeleton} chains={project.chains} selected={selectedBone} onSelect={setSelectedBone} />
      </aside>
      <main className="center">
        <Viewport
          modelUrl={modelUrl(DIR, project.model)}
          project={project}
          rig={rig}
          clip={clip}
          t={t}
          selectedBone={selectedBone}
          showSkeleton={showSkeleton}
          onStatus={say}
        />
        <Timeline
          clips={project.clips.map((c) => c.name)}
          clip={clip}
          t={t}
          playing={playing}
          showSkeleton={showSkeleton}
          onClip={(n) => {
            setClipName(n);
            setT(0);
          }}
          onTime={(v) => {
            setT(v);
            setPlaying(false);
          }}
          onPlay={setPlaying}
          onSkeleton={setShowSkeleton}
        />
      </main>
      <aside className="right">
        {clip ? (
          <>
            <LayersPanel clip={clip} presets={presets} setProject={setProject} project={project} run={run} />
            <KeysPanel
              clip={clip}
              t={t}
              selectedBone={selectedBone}
              onSelectBone={setSelectedBone}
              onTime={(v) => {
                setT(v);
                setPlaying(false);
              }}
              run={run}
            />
          </>
        ) : (
          <p className="muted">В проекте нет клипов. Создайте: pnpm af clip.add --name swim --duration 2</p>
        )}
      </aside>
      <footer className={`status ${status.error ? "error" : ""}`} title={status.text}>
        <span className="muted">{new Date(status.at).toLocaleTimeString("ru-RU")}</span> {status.text}
      </footer>
    </div>
  );
}

function short(v: unknown) {
  const s = JSON.stringify(v);
  return s && s.length > 160 ? s.slice(0, 160) + "…" : s ?? "";
}
