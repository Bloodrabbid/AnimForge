// Главное окно: библиотека и кости слева, вьюпорт и время в центре, слои и ключи справа.
// Интерфейс ничего не считает сам: поза — poseAt из ядра, изменения — команды ядра через API.
// Примерка пресета — те же команды на копии проекта (/api/preview): видно на своей модели, на диск не пишется,
// пока не нажато «Применить».
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { RECIPES, buildRig, clipSteps, type Project } from "../../../packages/core/src/index.ts";
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
import { ConstraintsPanel } from "./ConstraintsPanel.tsx";
import { Menu } from "./Menu.tsx";
import type { Brush, WeightPainter } from "./weightPaint.ts";
import { BoneTree } from "./BoneTree.tsx";
import { Icon } from "./Icon.tsx";
import { KeysPanel } from "./KeysPanel.tsx";
import { LayersPanel } from "./LayersPanel.tsx";
import { SimplePanel } from "./SimplePanel.tsx";
import { LibraryPanel, chainsFor, sourceOf, type Entry } from "./LibraryPanel.tsx";
import { Timeline } from "./Timeline.tsx";
import { Viewport, type Trail, type ViewCmd } from "./Viewport.tsx";
import { GraphPanel, isShown, limbColor, useMotionGraph } from "./GraphPanel.tsx";

const query = new URLSearchParams(location.search);
const DIR = query.get("dir") ?? "projects/fish-demo";
const BODY_RU: Record<string, string> = { quadruped: "четвероногое", multileg: "многоногое", winged: "крылатое", biped: "двуногое", finned: "с ластами", other: "без ног" };

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
  // график амплитуд под вьюпортом и следы конечностей во вьюпорте (запоминаются)
  const [showGraph, setShowGraph] = useState(() => query.get("graph") === "1" || (query.get("graph") !== "0" && localStorage.getItem("af.graph") === "1"));
  useEffect(() => localStorage.setItem("af.graph", showGraph ? "1" : "0"), [showGraph]);
  const [showTrails, setShowTrails] = useState(() => query.get("trails") === "1" || (query.get("trails") !== "0" && localStorage.getItem("af.trails") === "1"));
  useEffect(() => localStorage.setItem("af.trails", showTrails ? "1" : "0"), [showTrails]);
  const [graphShown, setGraphShown] = useState<Record<string, boolean>>(() => JSON.parse(localStorage.getItem("af.graph.shown") ?? "{}"));
  useEffect(() => localStorage.setItem("af.graph.shown", JSON.stringify(graphShown)), [graphShown]);
  const [hoverChain, setHoverChain] = useState<string | null>(query.get("hover"));
  const [leftTab, setLeftTab] = useState<"library" | "bones">((query.get("left") as "bones") ?? "library");
  // простой режим по умолчанию: модель, клипы, позинг, главные ручки и проверка; остальное — «Расширенное» (запоминается)
  const [advanced, setAdvanced] = useState(() => query.get("adv") === "1" || (query.get("adv") !== "0" && localStorage.getItem("af.advanced") === "1"));
  useEffect(() => localStorage.setItem("af.advanced", advanced ? "1" : "0"), [advanced]);
  const [rightTab, setRightTab] = useState<"layers" | "keys" | "weights" | "limits" | "targets">((query.get("right") as "weights") ?? "layers");
  const [activeTarget, setActiveTarget] = useState<string | null>(query.get("target"));
  const group = rightTab === "layers" || rightTab === "keys" ? "motion" : rightTab === "weights" ? "skin" : "body";
  // в группу возвращаемся на ту вкладку, где были
  const lastSub = useRef<{ motion: "layers" | "keys"; body: "targets" | "limits" }>({ motion: "layers", body: "targets" });
  if (group === "motion") lastSub.current.motion = rightTab as "layers";
  if (group === "body") lastSub.current.body = rightTab as "targets";
  const [poseMode, setPoseMode] = useState(query.get("pose") === "1");
  const [poseLength, setPoseLength] = useState(Number(query.get("plen") ?? 2) || 2);
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
      let name = entry.preset.name;
      for (let i = 2; project.clips.some((c) => c.name === name); i++) name = `${entry.preset.name}-${i}`;
      const ch = entry.lib.roles ? undefined : (chain ?? chainsFor(entry.lib.recipe, project.chains)[0]);
      const steps: Step[] = clipSteps({ recipe: entry.lib.recipe, preset: entry.preset, name, chains: project.chains, paws: body?.paws, chain: ch });
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
  const graph = useMotionGraph(shown, rig, clip, showGraph || showTrails);
  // следы — у стоп, кистей и таза, тех, что отмечены на графике
  const trails = useMemo<Trail[] | null>(
    () =>
      showTrails && graph
        ? graph.limbs
            .filter((l) => (l.kind === "foot" || l.kind === "hand" || l.kind === "pelvis") && isShown(graphShown, l))
            .map((l) => {
              // ключи позы, где двигали кости этой цепочки, — метки на следе
              const bones = new Set([...(shown?.chains[l.chain] ?? []), l.tip.replace(/>$/, "")]);
              const keys = (clip?.layers ?? []).flatMap((ly) => (ly.type === "pose" ? ly.keys.filter((k) => [...Object.keys(k.rot ?? {}), ...Object.keys(k.move ?? {})].some((b) => bones.has(b))).map((k) => k.t) : []));
              return { color: limbColor(l.chain, graph.limbs.indexOf(l)), pts: l.pos, times: graph.times, tip: l.tip, keys };
            })
        : null,
    [showTrails, graph, graphShown, clip],
  );
  const highlight = useMemo(() => {
    const l = hoverChain ? graph?.limbs.find((x) => x.chain === hoverChain) : undefined;
    if (!l || !shown) return null;
    const bones = [...(shown.chains[l.chain] ?? [])];
    if (!l.tip.endsWith(">") && !bones.includes(l.tip)) bones.push(l.tip);
    return { bones, color: limbColor(l.chain, graph!.limbs.indexOf(l)) };
  }, [hoverChain, graph, shown]);

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
        p: () => (setPoseMode((v) => !v), setPlaying(false)),
        k: () => setShowGraph((v) => !v),
        t: () => setShowTrails((v) => !v),
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
          <button className={`ghost adv ${advanced ? "on" : ""}`} onClick={() => setAdvanced((v) => !v)} title="слои, ключи, цели, пределы, веса, дерево костей">
            Расширенное
          </button>
          {project!.godot && (
            <button className="btn outline" onClick={() => run("publish", {})} title={`запечь glb и положить в игру: ${project!.godot}`}>
              <Icon name="download" /> В Godot
            </button>
          )}
          <a className="btn accent" href={downloadUrl(DIR)} title="запечь все клипы в glb — для Godot, Blender, Unity, Unreal">
            <Icon name="download" /> Скачать GLB
          </a>
          <Menu label="FBX" title="FBX с именами костей стандартного скелета — авто-ретаргет в движке" align="right">
            {(close) => (
              <>
                {([
                  ["Unreal (UE5 Manny: pelvis, thigh_l…)", { units: "unreal", names: "unreal" }],
                  ["Unity / Mixamo (mixamorig:Hips…)", { units: "unity", names: "mixamo" }],
                  ["Blender / Godot, свои имена", { units: "blender" }],
                ] as const).map(([label, o]) => (
                  <a key={label} className="menu-item" href={downloadUrl(DIR, { format: "fbx", ...o })} onClick={close}>
                    {label}
                  </a>
                ))}
              </>
            )}
          </Menu>
        </div>
      </header>

      <aside className="left">
        <div className="tabs">
          <button className={leftTab === "library" ? "on" : ""} onClick={() => setLeftTab("library")}>
            <Icon name="library" size={14} /> Библиотека
          </button>
          {advanced && (
            <button className={leftTab === "bones" ? "on" : ""} onClick={() => setLeftTab("bones")}>
              <Icon name="tree" size={14} /> Кости
            </button>
          )}
        </div>
        <div className="tab-body">
          {leftTab === "library" || !advanced ? (
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
            weightMode={advanced && rightTab === "weights" && !trial}
            brush={brush}
            onPainter={(p) => {
              painter.current = p;
              setStrokes(0);
            }}
            onStroke={setStrokes}
            onPickBone={setSelectedBone}
            showTargets={!!clip?.constraints?.length}
            activeTarget={advanced && rightTab === "targets" && !trial ? activeTarget : null}
            onMoveTarget={(id, pos) => {
              const c = clip?.constraints?.find((x) => x.id === id);
              if (!c || !clip || c.type === "copy") return;
              const target = pos.join(",");
              // у цели с ключами — ключ в текущем кадре, у неподвижной — новая точка
              runMany(
                [c.target.keys?.length ? { name: "constraint.key", args: { clip: clip.name, id, t: +t.toFixed(3), target } } : { name: "constraint.set", args: { clip: clip.name, id, target } }],
                c.target.keys?.length ? `ключ цели в ${t.toFixed(2)} с` : "цель",
              );
            }}
            poseMode={poseMode && !trial && !!clip}
            poseLength={poseLength}
            onPoseDrop={(bone, target, length, end, endLength, at) => {
              if (!clip) return;
              // схватили след — ключ в момент точки следа, а не в текущий кадр
              const tt = at ?? t;
              runMany([{ name: "pose.reach", args: { clip: clip.name, t: +tt.toFixed(3), bone, target: target.join(","), length, ...(end ? { end: true, ...(endLength ? { endLength: +endLength.toFixed(4) } : {}) } : {}) } }], length ? `поза: ${bone} в ${tt.toFixed(2)} с` : `тело перенесено в ${tt.toFixed(2)} с`);
            }}
            onPin={(bone, at) => {
              if (!clip) return;
              setActiveTarget(`pin_${bone}`);
              runMany([{ name: "ik.add", args: { clip: clip.name, tip: bone, target: at.join(","), id: `pin_${bone}` } }], `закреплено: ${bone}`);
            }}
            onStatus={say}
            trails={trails}
            onTrailTime={(v) => {
              setT(v);
              setPlaying(false);
            }}
            highlight={highlight}
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
              <ToolBtn
                icon="hand"
                title="поза (P): тяните суставы мышью — сгибаются кости с учётом пределов, поза пишется ключом в текущий кадр; таз — переносит тело; Alt+клик — закрепить"
                on={poseMode}
                onClick={() => (setPoseMode((v) => !v), setPlaying(false))}
              />
              {poseMode && (
                <select className="plen" value={poseLength} onChange={(e) => setPoseLength(Number(e.target.value))} title="сколько костей сгибать от схваченного сустава вверх">
                  {[1, 2, 3, 4, 5, 6, 8].map((n) => (
                    <option key={n} value={n}>
                      {n} {n === 1 ? "кость" : n < 5 ? "кости" : "костей"}
                    </option>
                  ))}
                </select>
              )}
              {poseMode && clip?.layers.some((l) => l.type === "pose") && (
                <button className="small" title="убрать ключ позы в этом кадре" onClick={() => runMany([{ name: "pose.clear", args: { clip: clip.name, t: +t.toFixed(3) } }], "поза в кадре сброшена")}>
                  сбросить
                </button>
              )}
            </div>
            <div className="group">
              <Menu label={<Icon name="fit" />} title="ракурс камеры" align="right">
                {(close) =>
                  (
                    [
                      ["fit", "Показать целиком", "F"],
                      ["front", "Спереди", "1"],
                      ["side", "Сбоку", "2"],
                      ["top", "Сверху", "3"],
                    ] as const
                  ).map(([kind, label, key]) => (
                    <button key={kind} onClick={() => (setView((v) => ({ kind, n: v.n + 1 })), close())}>
                      <Icon name={kind} size={14} /> {label} <span className="kbd">{key}</span>
                    </button>
                  ))
                }
              </Menu>
              <Menu label={<Icon name="eye" />} title="что показывать: скелет, каркас, пол" align="right">
                {() => (
                  <>
                    <label>
                      <input type="checkbox" checked={showSkeleton} onChange={() => setShowSkeleton((v) => !v)} /> Скелет <span className="kbd">S</span>
                    </label>
                    <label>
                      <input type="checkbox" checked={wireframe} onChange={() => setWireframe((v) => !v)} /> Каркас <span className="kbd">W</span>
                    </label>
                    <label>
                      <input type="checkbox" checked={showFloor} onChange={() => setShowFloor((v) => !v)} /> Пол и тень <span className="kbd">G</span>
                    </label>
                    <label title="путь стоп, кистей и таза за цикл клипа — цвета как на графике">
                      <input type="checkbox" checked={showTrails} onChange={() => setShowTrails((v) => !v)} /> Следы конечностей <span className="kbd">T</span>
                    </label>
                  </>
                )}
              </Menu>
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
        {showGraph && clip && (
          <GraphPanel
            graph={graph && graph.clip === clip.name ? graph : null}
            t={t}
            duration={clip.duration}
            hover={hoverChain}
            onHover={setHoverChain}
            onTime={(v) => {
              setT(v);
              setPlaying(false);
            }}
            shown={graphShown}
            onShown={setGraphShown}
            shapes={Object.fromEntries(
              clip.layers.flatMap((l) => {
                if (l.type !== "recipe") return [];
                const per = l.params.period ?? RECIPES[l.recipe]?.params.period?.default;
                return [[l.target.chain, { shape: l.shape ?? {}, period: typeof per === "number" ? per : clip.duration }]];
              }),
            )}
            onShape={(chain, sh) =>
              run("layer.shape", Object.keys(sh).length ? { clip: clip.name, chain, late: sh.late ?? 0, amount: sh.amount ?? 1, step: sh.step ?? 0 } : { clip: clip.name, chain, reset: true })
            }
          />
        )}
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
          graph={showGraph}
          onGraph={setShowGraph}
        />
      </main>

      <aside className="right">
        {!advanced ? (
          <>
            <div className="tabs">
              <button className="on">Клип {clip && <span className="n">{clip.name}</span>}</button>
            </div>
            <div className="tab-body">
              {clip ? (
                <SimplePanel dir={DIR} project={shown} clip={clip} readOnly={!!trial} runMany={trial ? runTrial : runMany} />
              ) : (
                <div className="empty-state">
                  <Icon name="library" size={28} />
                  <p>В проекте нет клипов.</p>
                  <p className="muted">Выберите движение в библиотеке — клип создастся сам.</p>
                </div>
              )}
            </div>
          </>
        ) : (
        <>
        <div className="tabs">
          {/* три группы по задаче: движение клипа, тело (цели и пределы суставов), кожа */}
          <button className={group === "motion" ? "on" : ""} onClick={() => setRightTab(lastSub.current.motion)} title="слои и ключи клипа">
            Движение <span className="n">{clip?.layers.length ?? 0}</span>
          </button>
          <button className={group === "body" ? "on" : ""} onClick={() => setRightTab(lastSub.current.body)} title="цели (IK, взгляд, копии) и пределы суставов">
            Тело {(clip?.constraints?.length ?? 0) + Object.keys(shown.limits ?? {}).length > 0 && <span className="n">{(clip?.constraints?.length ?? 0) + Object.keys(shown.limits ?? {}).length}</span>}
          </button>
          <button className={group === "skin" ? "on" : ""} onClick={() => setRightTab("weights")} title="веса кожи: кисть по модели">
            Кожа {strokes > 0 && <span className="n dirty-dot">●</span>}
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
        {group !== "skin" && (
          <div className="subtabs">
            {(group === "motion"
              ? ([["layers", "Слои"], ["keys", "Ключи"]] as const)
              : ([["targets", `Цели${clip?.constraints?.length ? ` · ${clip.constraints.length}` : ""}`], ["limits", `Пределы${shown.limits ? ` · ${Object.keys(shown.limits).length}` : ""}`]] as const)
            ).map(([k, label]) => (
              <button key={k} className={rightTab === k ? "on" : ""} onClick={() => setRightTab(k)}>
                {label}
              </button>
            ))}
          </div>
        )}
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
          ) : rightTab === "targets" && clip ? (
            <ConstraintsPanel
              project={shown}
              skeleton={data.skeleton}
              rig={rig}
              clip={clip}
              t={t}
              active={activeTarget}
              readOnly={!!trial}
              onActive={setActiveTarget}
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
        </>
        )}
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
    ["K · T", "график амплитуд · следы конечностей"],
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
  // констрейн: имя и что он делает, а не весь объект
  const c = v as { id?: string; type?: string; tip?: string; bones?: string[] } | null;
  if (c && typeof c === "object" && c.id && (c.type === "ik" || c.type === "aim" || c.type === "copy"))
    return `${c.id} (${c.type === "ik" ? `IK · ${c.tip}` : c.type === "aim" ? `взгляд · ${c.bones?.join(" → ")}` : `копия · ${c.bones?.join(", ")}`})`;
  const pr = v as { t?: number; bones?: string[] } | null;
  if (pr && typeof pr === "object" && Array.isArray(pr.bones) && typeof pr.t === "number" && !("type" in pr)) return `ключ позы в ${pr.t.toFixed(2)} с: ${pr.bones.join(", ")}`;
  const s = JSON.stringify(v);
  return s && s.length > 120 ? s.slice(0, 120) + "…" : s ?? "";
}
