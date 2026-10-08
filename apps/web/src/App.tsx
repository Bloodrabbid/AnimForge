// Главное окно: библиотека и кости слева, вьюпорт и время в центре, слои и ключи справа.
// Интерфейс ничего не считает сам: поза — poseAt из ядра, изменения — команды ядра через API.
// Примерка пресета — те же команды на копии проекта (/api/preview): видно на своей модели, на диск не пишется,
// пока не нажато «Применить».
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { RECIPES, buildRig, withDefaults, type Project } from "../../../packages/core/src/index.ts";
import {
  command,
  downloadUrl,
  fetchLibrary,
  fetchProject,
  fetchProjects,
  modelUrl,
  preview,
  watchProject,
  type LibRecipe,
  type Loaded,
  type Step,
  uploadModel,
  saveWeights,
} from "./api.ts";
import { WeightsPanel } from "./WeightsPanel.tsx";
import { LimitsPanel } from "./LimitsPanel.tsx";
import type { Brush, WeightPainter } from "./weightPaint.ts";
import { BoneTree } from "./BoneTree.tsx";
import { Icon } from "./Icon.tsx";
import { KeysPanel } from "./KeysPanel.tsx";
import { LayersPanel } from "./LayersPanel.tsx";
import { LibraryPanel, chainsFor, sourceOf, type Entry } from "./LibraryPanel.tsx";
import { Timeline } from "./Timeline.tsx";
import { Viewport, type ViewCmd } from "./Viewport.tsx";

const query = new URLSearchParams(location.search);
const DIR = query.get("dir") ?? "projects/fish-demo";
const BODY_RU: Record<string, string> = { quadruped: "четвероногое", multileg: "многоногое", winged: "крылатое", biped: "двуногое", finned: "с ластами", other: "без ног" };
const ONE_SHOT = new Set(["melee-strike", "charge-release", "tentacle-strike", "emerge"]);

export interface Status {
  text: string;
  error: boolean;
  at: number;
}

interface Trial {
  entry: Entry;
  chain?: string;
  clip: string;
  prevClip: string | null;
  steps: Step[];
  project: Project;
}

export function App() {
  const [data, setData] = useState<Loaded | null>(null);
  // рабочая копия проекта: совпадает с диском, кроме момента перетаскивания ползунка
  const [project, setProject] = useState<Project | null>(null);
  const [clipName, setClipName] = useState<string | null>(query.get("clip"));
  const [t, setT] = useState(Number(query.get("t") ?? 0) || 0);
  const [playing, setPlaying] = useState(query.get("paused") !== "1");
  const [loopPlay, setLoopPlay] = useState(true);
  const [speed, setSpeed] = useState(1);
  const [selectedBone, setSelectedBone] = useState<string | null>(query.get("bone"));
  const [showSkeleton, setShowSkeleton] = useState(query.get("skeleton") !== "0");
  const [wireframe, setWireframe] = useState(false);
  const [showFloor, setShowFloor] = useState(true);
  const [view, setView] = useState<ViewCmd>({ kind: "fit", n: 0 });
  const [leftTab, setLeftTab] = useState<"library" | "bones">((query.get("left") as "bones") ?? "library");
  const [rightTab, setRightTab] = useState<"layers" | "keys" | "weights" | "limits">((query.get("right") as "weights") ?? "layers");
  const [brush, setBrush] = useState<Brush>({ mode: "add", radius: 0.06, strength: 0.25 });
  const [strokes, setStrokes] = useState(0);
  const [modelVer, setModelVer] = useState(0);
  const painter = useRef<WeightPainter | null>(null);
  const [status, setStatus] = useState<Status>({ text: "загрузка проекта…", error: false, at: Date.now() });
  const [library, setLibrary] = useState<LibRecipe[]>([]);
  const [projects, setProjects] = useState<string[]>([]);
  const [trial, setTrial] = useState<Trial | null>(null);
  const [busy, setBusy] = useState(false);
  const [help, setHelp] = useState(false);
  const [live, setLive] = useState(false);
  // тип тела из rig.detect (без записи): какие движения предлагать первыми и какие кости ставить на пол
  const [body, setBody] = useState<{ body: string; paws: string[] } | null>(null);
  const [drag, setDrag] = useState(false);
  const [upload, setUpload] = useState<{ name: string; error?: string } | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
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
    fetchLibrary().then(setLibrary, (e) => say(`библиотека: ${e.message}`, true));
    fetchProjects().then(setProjects, () => {});
    command<{ body?: string; paws?: string[] }>(DIR, "rig.detect", { write: false }).then(
      (r) => setBody({ body: r.body ?? "other", paws: r.paws ?? [] }),
      () => setBody({ body: "other", paws: [] }),
    );
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

  // имя кости в адресе могло быть именем цепочки — берём её первую кость
  useEffect(() => {
    if (!data || !project || !selectedBone) return;
    if (!data.skeleton.nodes.some((n) => n.name === selectedBone) && project.chains[selectedBone]) setSelectedBone(project.chains[selectedBone][0]);
  }, [data, project, selectedBone]);

  /** Изменить проект можно только командами ядра; несколько команд — подряд, перечитываем один раз. */
  const runMany = useCallback(
    async (steps: Step[], label?: string) => {
      setBusy(true);
      try {
        ownWriteAt.current = Date.now();
        let res: unknown;
        for (const s of steps) res = await command(DIR, s.name, s.args);
        ownWriteAt.current = Date.now();
        say(`${label ?? steps[0]?.name}: ок${steps.length > 1 ? ` (${steps.length} команд)` : ` — ${short(res)}`}`);
        await reload();
        return res;
      } catch (e) {
        say(`${label ?? steps[0]?.name}: ${(e as Error).message}`, true);
        await reload(); // вернуть рабочую копию к диску
      } finally {
        setBusy(false);
      }
    },
    [reload, say],
  );
  const run = useCallback((name: string, args: Record<string, unknown>) => runMany([{ name, args }]), [runMany]);

  /** Примерка: клип под пресет и слои на копии проекта. Повторный клик по другой карточке — заменить примерку. */
  const tryOn = useCallback(
    async (entry: Entry, chain?: string) => {
      if (!project) return;
      const def = RECIPES[entry.lib.recipe];
      const p = withDefaults(def, entry.preset.params);
      const period = Number(p.period);
      const duration = period > 0 ? period * Math.max(1, Math.round(2 / period)) : Number(p.duration) > 0 ? Number(p.duration) : 1.6;
      let name = entry.preset.name;
      for (let i = 2; project.clips.some((c) => c.name === name); i++) name = `${entry.preset.name}-${i}`;
      const ch = entry.lib.roles ? undefined : (chain ?? chainsFor(entry.lib.recipe, project.chains)[0]);
      const steps: Step[] = [
        { name: "clip.add", args: { name, duration: +duration.toFixed(3), loop: !ONE_SHOT.has(entry.lib.recipe) } },
        entry.lib.roles
          ? { name: "recipe.rig", args: { clip: name, recipe: entry.lib.recipe, preset: entry.preset.name } }
          : { name: "preset.apply", args: { clip: name, preset: entry.preset.name, chain: ch } },
      ];
      // походка четвероногого и многоногого — лапы на пол, колени сгибаются (как в README)
      if ((entry.lib.recipe === "quadruped-gait" || entry.lib.recipe === "multileg-gait") && body?.paws.length)
        steps.push({ name: "clip.ground", args: { clip: name, bones: body.paws.join(","), mode: "floor", ik: true } });
      setBusy(true);
      try {
        const next = await preview(DIR, steps);
        setTrial((old) => ({ entry, chain: ch, clip: name, prevClip: old ? old.prevClip : clipName, steps, project: next }));
        setClipName(name);
        setT(0);
        setPlaying(true);
        say(`примерка ${entry.preset.name}: на диск не записано — «Применить» или Esc`);
      } catch (e) {
        say(`примерка ${entry.preset.name}: ${(e as Error).message}`, true);
      } finally {
        setBusy(false);
      }
    },
    [project, clipName, body, say],
  );

  /** Правки во время примерки идут на ту же копию — и запоминаются, чтобы «Применить» повторил их на диске. */
  const runTrial = useCallback(
    async (steps: Step[]) => {
      if (!trial) return;
      try {
        const next = await preview(DIR, steps, trial.project);
        setTrial({ ...trial, steps: [...trial.steps, ...steps], project: next });
      } catch (e) {
        say((e as Error).message, true);
      }
    },
    [trial, say],
  );

  const applyTrial = useCallback(async () => {
    if (!trial) return;
    const tr = trial;
    await runMany(tr.steps, `пресет ${tr.entry.preset.name} → клип ${tr.clip}`);
    setTrial(null);
    setClipName(tr.clip);
  }, [trial, runMany]);

  const cancelTrial = useCallback(() => {
    if (!trial) return;
    setClipName(trial.prevClip);
    setTrial(null);
    setT(0);
    say("примерка отменена");
  }, [trial, say]);

  /** Своя модель: сервер импортирует её через Blender, распознаёт скелет и создаёт проект — открываем его. */
  const startUpload = useCallback(async (file: File) => {
    if (!/\.(glb|gltf|fbx|dae)$/i.test(file.name)) {
      setUpload({ name: file.name, error: "Нужен файл .glb, .gltf (одним файлом), .fbx или .dae" });
      return;
    }
    setUpload({ name: file.name });
    try {
      const r = await uploadModel(file);
      location.search = `?dir=${encodeURIComponent(r.dir)}&left=library`;
    } catch (e) {
      setUpload({ name: file.name, error: (e as Error).message });
    }
  }, []);

  // перетаскивание файла в любое место окна
  useEffect(() => {
    let depth = 0;
    const hasFile = (e: DragEvent) => [...(e.dataTransfer?.types ?? [])].includes("Files");
    const enter = (e: DragEvent) => {
      if (!hasFile(e)) return;
      depth++;
      setDrag(true);
    };
    const leave = () => {
      if (--depth <= 0) (depth = 0), setDrag(false);
    };
    const over = (e: DragEvent) => hasFile(e) && e.preventDefault();
    const drop = (e: DragEvent) => {
      e.preventDefault();
      depth = 0;
      setDrag(false);
      const f = e.dataTransfer?.files[0];
      if (f) startUpload(f);
    };
    window.addEventListener("dragenter", enter);
    window.addEventListener("dragleave", leave);
    window.addEventListener("dragover", over);
    window.addEventListener("drop", drop);
    return () => {
      window.removeEventListener("dragenter", enter);
      window.removeEventListener("dragleave", leave);
      window.removeEventListener("dragover", over);
      window.removeEventListener("drop", drop);
    };
  }, [startUpload]);

  const shown = trial?.project ?? project;
  const rig = useMemo(() => (data ? buildRig(data.skeleton) : null), [data?.skeleton]);
  const clip = shown?.clips.find((c) => c.name === clipName) ?? shown?.clips[0];

  // проигрывание: время двигает интерфейс, позу считает ядро во вьюпорте
  useEffect(() => {
    if (!playing || !clip) return;
    let raf = 0;
    let last = performance.now();
    const tick = (now: number) => {
      const dt = ((now - last) / 1000) * speed;
      last = now;
      setT((t) => {
        const n = t + dt;
        if (n <= clip.duration) return n;
        if (loopPlay) return n % clip.duration;
        setPlaying(false);
        return clip.duration;
      });
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playing, clip?.duration, loopPlay, speed]);

  // горячие клавиши — как в большинстве редакторов анимации
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement;
      if (el.tagName === "INPUT" || el.tagName === "SELECT" || el.tagName === "TEXTAREA") return;
      const fps = clip?.fps ?? 30, d = clip?.duration ?? 1;
      const frameStep = (k: number) => {
        setPlaying(false);
        setT((t) => Math.min(d, Math.max(0, (Math.round(t * fps) + k) / fps)));
      };
      const keys: Record<string, () => void> = {
        " ": () => setPlaying((p) => !p),
        ArrowLeft: () => frameStep(e.shiftKey ? -10 : -1),
        ArrowRight: () => frameStep(e.shiftKey ? 10 : 1),
        Home: () => setT(0),
        End: () => setT(d),
        l: () => setLoopPlay((v) => !v),
        s: () => setShowSkeleton((v) => !v),
        w: () => setWireframe((v) => !v),
        g: () => setShowFloor((v) => !v),
        f: () => setView((v) => ({ kind: "fit", n: v.n + 1 })),
        "1": () => setView((v) => ({ kind: "front", n: v.n + 1 })),
        "2": () => setView((v) => ({ kind: "side", n: v.n + 1 })),
        "3": () => setView((v) => ({ kind: "top", n: v.n + 1 })),
        Escape: () => (trial ? cancelTrial() : setHelp(false)),
        Enter: () => trial && applyTrial(),
        "?": () => setHelp((v) => !v),
      };
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "z" && painter.current?.active) {
        e.preventDefault();
        if (painter.current.undo()) setStrokes(painter.current.strokes);
        return;
      }
      const fn = keys[e.key] ?? keys[e.key.toLowerCase()];
      if (fn) {
        e.preventDefault();
        fn();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [clip, trial, cancelTrial, applyTrial]);

  if (!data || !shown || !rig) {
    return (
      <div className={`boot ${status.error ? "error" : ""}`}>
        <Logo />
        <p>{status.text}</p>
      </div>
    );
  }

  const trialChains = trial && !trial.entry.lib.roles ? chainsFor(trial.entry.lib.recipe, shown.chains) : [];

  return (
    <div className="app">
      <header className="top">
        <Logo />
        <div className="proj">
          <Icon name="mesh" size={14} />
          <select
            value={data.dir}
            onChange={(e) => (location.search = `?dir=${encodeURIComponent(e.target.value)}`)}
            title="проект: projects/* и out/*/*"
          >
            {[...new Set([data.dir, ...projects])].map((p) => (
              <option key={p} value={p}>
                {p}
              </option>
            ))}
          </select>
        </div>
        <span className="meta">
          {body && <span className="body-tag">{BODY_RU[body.body] ?? body.body}</span>}
          {data.skeleton.nodes.filter((n) => n.isJoint).length} костей · {Object.keys(shown.chains).length} цепочек · {project!.clips.length} клипов
        </span>
        <div className="top-right">
          <span className={`live ${live ? "on" : ""}`} title="сервер следит за animforge.json: правки агента через CLI видны сразу">
            <span className="led" />
            {live ? "синхронно с диском" : "нет связи с диском"}
          </span>
          <input
            ref={fileInput}
            type="file"
            accept=".glb,.gltf,.fbx,.dae"
            hidden
            onChange={(e) => e.target.files?.[0] && startUpload(e.target.files[0])}
          />
          <button className="btn outline" onClick={() => fileInput.current?.click()} title="или просто перетащите файл в окно">
            <Icon name="upload" /> Загрузить модель
          </button>
          <button className="ghost" onClick={() => setHelp((v) => !v)} title="горячие клавиши (?)">
            <Icon name="keyboard" />
          </button>
          <a className="btn accent" href={downloadUrl(DIR)} title="запечь все клипы в glb — для Godot, Blender, Unity, Unreal">
            <Icon name="download" /> Скачать GLB
          </a>
        </div>
      </header>

      <aside className="left">
        <div className="tabs">
          <button className={leftTab === "library" ? "on" : ""} onClick={() => setLeftTab("library")}>
            <Icon name="library" size={14} /> Библиотека
          </button>
          <button className={leftTab === "bones" ? "on" : ""} onClick={() => setLeftTab("bones")}>
            <Icon name="tree" size={14} /> Кости
          </button>
        </div>
        <div className="tab-body">
          {leftTab === "library" ? (
            <LibraryPanel library={library} chains={shown.chains} body={body?.body} active={trial?.entry.preset.name ?? null} onTry={(e) => tryOn(e)} />
          ) : (
            <BoneTree skeleton={data.skeleton} chains={shown.chains} selected={selectedBone} onSelect={setSelectedBone} />
          )}
        </div>
      </aside>

      <main className="center">
        <div className="stage">
          <Viewport
            modelUrl={`${modelUrl(DIR, shown.model)}&v=${modelVer}`}
            project={shown}
            rig={rig}
            clip={clip}
            t={t}
            selectedBone={selectedBone}
            showSkeleton={showSkeleton}
            wireframe={wireframe}
            showFloor={showFloor}
            view={view}
            weightMode={rightTab === "weights" && !trial}
            brush={brush}
            onPainter={(p) => {
              painter.current = p;
              setStrokes(0);
            }}
            onStroke={setStrokes}
            onPickBone={setSelectedBone}
            onStatus={say}
          />
          <div className="overlay tl">
            <span className="clip-label">
              {trial ? "ПРИМЕРКА" : "КЛИП"} <b>{clip?.name ?? "—"}</b>
            </span>
            {clip && (
              <span className="clip-meta">
                {clip.duration.toFixed(2)} с · {clip.fps} fps · {clip.loop ? "цикл" : "один раз"} · слоёв {clip.layers.length}
              </span>
            )}
          </div>
          <div className="overlay tr toolbar">
            <div className="group">
              <ToolBtn icon="fit" title="показать целиком (F)" onClick={() => setView((v) => ({ kind: "fit", n: v.n + 1 }))} />
              <ToolBtn icon="front" title="спереди (1)" onClick={() => setView((v) => ({ kind: "front", n: v.n + 1 }))} />
              <ToolBtn icon="side" title="сбоку (2)" onClick={() => setView((v) => ({ kind: "side", n: v.n + 1 }))} />
              <ToolBtn icon="top" title="сверху (3)" onClick={() => setView((v) => ({ kind: "top", n: v.n + 1 }))} />
            </div>
            <div className="group">
              <ToolBtn icon="bones" title="скелет (S)" on={showSkeleton} onClick={() => setShowSkeleton((v) => !v)} />
              <ToolBtn icon="wire" title="каркас (W)" on={wireframe} onClick={() => setWireframe((v) => !v)} />
              <ToolBtn icon="floor" title="пол и тень (G)" on={showFloor} onClick={() => setShowFloor((v) => !v)} />
            </div>
          </div>
          {!clip && !trial && (
            <div className="empty-viewport">
              <b>Модель готова.</b>
              Выберите движение в библиотеке слева — оно сразу заиграет на ней.
            </div>
          )}
          {trial && (
            <div className="trybar">
              <div className="try-info">
                <span className="try-tag">примерка</span>
                <b>{trial.entry.preset.name}</b>
                <span className="muted">
                  {trial.entry.lib.recipe} · {sourceOf(trial.entry.preset).join(", ")}
                </span>
              </div>
              {trialChains.length > 1 && (
                <label className="try-chain">
                  цепочка
                  <select value={trial.chain} onChange={(e) => tryOn(trial.entry, e.target.value)}>
                    {trialChains.map((c) => (
                      <option key={c}>{c}</option>
                    ))}
                  </select>
                </label>
              )}
              <button className="ghost" onClick={cancelTrial} title="Esc">
                Отмена
              </button>
              <button className="btn accent" onClick={applyTrial} disabled={busy} title="Enter — записать клип в проект">
                <Icon name="check" /> Применить
              </button>
            </div>
          )}
          {busy && <div className="busy" />}
          {help && <Shortcuts onClose={() => setHelp(false)} />}
        </div>
        <Timeline
          clips={shown.clips}
          clip={clip}
          t={t}
          playing={playing}
          loop={loopPlay}
          speed={speed}
          tryClip={trial?.clip}
          onClip={(n) => {
            setClipName(n);
            setT(0);
          }}
          onTime={(v) => {
            setT(v);
            setPlaying(false);
          }}
          onPlay={setPlaying}
          onLoop={setLoopPlay}
          onSpeed={setSpeed}
        />
      </main>

      <aside className="right">
        <div className="tabs">
          <button className={rightTab === "layers" ? "on" : ""} onClick={() => setRightTab("layers")}>
            Слои <span className="n">{clip?.layers.length ?? 0}</span>
          </button>
          <button className={rightTab === "keys" ? "on" : ""} onClick={() => setRightTab("keys")}>
            Ключи
          </button>
          <button className={rightTab === "limits" ? "on" : ""} onClick={() => setRightTab("limits")} title="ограничения: диапазон движения костей">
            Пределы {shown.limits && <span className="n">{Object.keys(shown.limits).length}</span>}
          </button>
          <button className={rightTab === "weights" ? "on" : ""} onClick={() => setRightTab("weights")} title="веса кожи: кисть по модели">
            Веса {strokes > 0 && <span className="n dirty-dot">●</span>}
          </button>
          {clip && !trial && (
            <button
              className="icon sm danger push"
              title={`удалить клип ${clip.name}`}
              onClick={() => confirm(`Удалить клип «${clip.name}» целиком?`) && run("clip.remove", { clip: clip.name }).then(() => setClipName(null))}
            >
              <Icon name="trash" size={14} />
            </button>
          )}
        </div>
        <div className="tab-body">
          {!clip ? (
            <div className="empty-state">
              <Icon name="library" size={28} />
              <p>В проекте нет клипов.</p>
              <p className="muted">Выберите движение в библиотеке — клип создастся сам.</p>
            </div>
          ) : rightTab === "limits" ? (
            <LimitsPanel
              project={shown}
              rig={rig}
              clip={clip}
              t={t}
              bone={selectedBone}
              readOnly={!!trial}
              onSelectBone={setSelectedBone}
              runMany={runMany}
            />
          ) : rightTab === "weights" ? (
            trial ? (
              <p className="muted pad">Веса правятся после «Применить» или «Отмена» примерки.</p>
            ) : (
              <WeightsPanel
                bone={selectedBone}
                brush={brush}
                strokes={strokes}
                busy={busy}
                onBrush={setBrush}
                onUndo={() => painter.current?.undo() && setStrokes(painter.current.strokes)}
                onSave={async () => {
                  if (!painter.current) return;
                  setBusy(true);
                  try {
                    await saveWeights(DIR, painter.current.collect());
                    say(`веса сохранены в ${shown.model} (исходник — рядом, .orig.glb)`);
                    setModelVer((v) => v + 1);
                  } catch (e) {
                    say(`веса: ${(e as Error).message}`, true);
                  } finally {
                    setBusy(false);
                  }
                }}
                onRestore={async () => {
                  if (!confirm("Вернуть веса, какие были до первой правки?")) return;
                  try {
                    await saveWeights(DIR, null);
                    say("исходные веса возвращены");
                    setModelVer((v) => v + 1);
                  } catch (e) {
                    say(`веса: ${(e as Error).message}`, true);
                  }
                }}
              />
            )
          ) : rightTab === "layers" ? (
            <LayersPanel
              clip={clip}
              library={library}
              project={shown}
              setProject={(p) => (trial ? setTrial({ ...trial, project: p }) : setProject(p))}
              runMany={trial ? runTrial : runMany}
            />
          ) : trial ? (
            <p className="muted pad">Ключи ставятся после «Применить».</p>
          ) : (
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
          )}
        </div>
      </aside>

      {(drag || upload) && (
        <div className={`dropzone ${drag ? "drag" : ""}`} onClick={() => upload?.error && setUpload(null)}>
          <div className="dz-card">
            <Icon name="upload" size={34} />
            {drag ? (
              <>
                <h3>Отпустите, чтобы загрузить модель</h3>
                <p className="muted">FBX, GLB, glTF или DAE со скелетом — любое тело: человек, зверь, паук, рыба</p>
              </>
            ) : upload?.error ? (
              <>
                <h3>Не получилось: {upload.name}</h3>
                <p className="err">{upload.error}</p>
                <button className="btn accent" onClick={() => setUpload(null)}>
                  Понятно
                </button>
              </>
            ) : (
              <>
                <h3>{upload?.name}</h3>
                <p className="muted">Импорт через Blender и распознавание скелета…</p>
                <div className="dz-bar" />
              </>
            )}
          </div>
        </div>
      )}

      <footer className={`status ${status.error ? "error" : ""}`} title={status.text}>
        <span className="time">{new Date(status.at).toLocaleTimeString("ru-RU")}</span> {status.text}
      </footer>
    </div>
  );
}

function ToolBtn({ icon, title, on, onClick }: { icon: string; title: string; on?: boolean; onClick(): void }) {
  return (
    <button className={`icon ${on ? "on" : ""}`} title={title} onClick={onClick}>
      <Icon name={icon} />
    </button>
  );
}

function Logo() {
  return (
    <span className="logo">
      <svg width="22" height="22" viewBox="0 0 24 24" aria-hidden>
        <path d="M3 18 9 5l4 8 2-4 6 9z" fill="var(--accent)" />
        <circle cx="9" cy="5" r="1.8" fill="#fff" />
      </svg>
      <span>
        Anim<b>Forge</b>
      </span>
    </span>
  );
}

function Shortcuts({ onClose }: { onClose(): void }) {
  const rows: [string, string][] = [
    ["Пробел", "играть / пауза"],
    ["← →", "кадр назад / вперёд (Shift — по 10)"],
    ["Home / End", "к началу / концу"],
    ["L", "по кругу"],
    ["F · 1 · 2 · 3", "целиком · спереди · сбоку · сверху"],
    ["S · W · G", "скелет · каркас · пол"],
    ["Enter / Esc", "применить / отменить примерку"],
  ];
  return (
    <div className="shortcuts" onClick={onClose}>
      <div className="sc-card" onClick={(e) => e.stopPropagation()}>
        <h3>Горячие клавиши</h3>
        {rows.map(([k, v]) => (
          <div key={k} className="sc-row">
            <kbd>{k}</kbd>
            <span>{v}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function short(v: unknown) {
  const s = JSON.stringify(v);
  return s && s.length > 120 ? s.slice(0, 120) + "…" : s ?? "";
}
