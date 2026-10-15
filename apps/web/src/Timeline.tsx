// Время: вкладки клипов, транспорт (кадр назад/вперёд, к началу/концу), петля, скорость и линейка кадров с событиями.
import { useRef } from "react";
import { clipEvents, type Clip } from "../../../packages/core/src/index.ts";
import { Icon } from "./Icon.tsx";
import { Menu } from "./Menu.tsx";

interface Props {
  clips: Clip[];
  clip: Clip | undefined;
  t: number;
  playing: boolean;
  loop: boolean;
  speed: number;
  tryClip?: string | null;
  onClip(name: string): void;
  onTime(t: number): void;
  onPlay(p: boolean): void;
  onLoop(v: boolean): void;
  onSpeed(v: number): void;
  /** панель «График» над временем: открыта ли */
  graph?: boolean;
  onGraph?(v: boolean): void;
  /** утилиты клипа: команда ядра над текущим клипом (зеркальная копия, задом наперёд, на месте, догоняющее) */
  onAction?(name: string, args: Record<string, unknown>): void;
}

const SPEEDS = [0.1, 0.25, 0.5, 1, 1.5, 2];

export function Timeline({ clips, clip, t, playing, loop, speed, tryClip, onClip, onTime, onPlay, onLoop, onSpeed, graph, onGraph, onAction }: Props) {
  const d = clip?.duration ?? 1;
  const fps = clip?.fps ?? 30;
  const frames = Math.max(1, Math.round(d * fps));
  const frame = Math.round(Math.min(t, d) * fps);
  const step = (k: number) => onTime(Math.min(d, Math.max(0, (frame + k) / fps)));

  return (
    <div className="timeline">
      <div className="clip-tabs">
        {clips.map((c) => (
          <button key={c.name} className={`tab ${c.name === clip?.name ? "on" : ""} ${c.name === tryClip ? "try" : ""}`} onClick={() => onClip(c.name)}>
            {c.name === tryClip && <span className="dot" />}
            {c.name}
            <span className="dur">{c.duration.toFixed(2)} с</span>
            {!c.loop && <span className="once" title="не цикл">→|</span>}
          </button>
        ))}
      </div>
      <div className="transport">
        <div className="tbtns">
          <button className="icon" onClick={() => onTime(0)} title="к началу (Home)">
            <Icon name="first" />
          </button>
          <button className="icon" onClick={() => step(-1)} title="кадр назад (←)">
            <Icon name="prev" />
          </button>
          <button className="icon play" onClick={() => onPlay(!playing)} disabled={!clip} title="играть / пауза (пробел)">
            <Icon name={playing ? "pause" : "play"} />
          </button>
          <button className="icon" onClick={() => step(1)} title="кадр вперёд (→)">
            <Icon name="next" />
          </button>
          <button className="icon" onClick={() => onTime(d)} title="к концу (End)">
            <Icon name="last" />
          </button>
        </div>
        <div className="tc">
          <b>{fmtTime(Math.min(t, d))}</b>
          <span>кадр {frame}</span>
        </div>
        <Ruler clip={clip} t={t} frames={frames} onTime={onTime} />
        <div className="tc right">
          <b>{fmtTime(d)}</b>
          <span>{frames} кадров</span>
        </div>
        <div className="tbtns">
          {onGraph && (
            <button className={`icon ${graph ? "on" : ""}`} onClick={() => onGraph(!graph)} disabled={!clip} title="график амплитуд конечностей (K)">
              <Icon name="graph" />
            </button>
          )}
          {onAction && clip && (
            <Menu label="⋯" title="утилиты клипа" align="right">
              {(close) => {
                const free = (base: string) => { let n = base, k = 2; while (clips.some((c) => c.name === n)) n = `${base}${k++}`; return n; };
                const items: [string, string, Record<string, unknown>, boolean?][] = [
                  ["Зеркальная копия", "clip.mirror", { clip: clip.name, as: free(`${clip.name}_mirror`) }],
                  ["Копия задом наперёд", "clip.reverse", { clip: clip.name, as: free(`${clip.name}_reverse`) }],
                  ["Зеркало у этого клипа", "clip.mirror", { clip: clip.name }, !!clip.mirror],
                  ["На месте (вперёд и вбок)", "clip.inplace", clip.inPlace ? { clip: clip.name, off: true } : { clip: clip.name, axes: "forward,side" }, !!clip.inPlace],
                  ["Догоняющее движение", "clip.follow", clip.follow ? { clip: clip.name } : { clip: clip.name, lag: 0.1, bounce: 0.3, loosen: 0.7 }, !!clip.follow],
                ];
                return items.map(([label, name, args, on]) => (
                  <button key={label} onClick={() => { onAction(name, args); close(); }}>
                    {on != null && <input type="checkbox" readOnly checked={on} />} {label}
                  </button>
                ));
              }}
            </Menu>
          )}
          <button className={`icon ${loop ? "on" : ""}`} onClick={() => onLoop(!loop)} title="играть по кругу (L)">
            <Icon name="loop" />
          </button>
          <select value={speed} onChange={(e) => onSpeed(Number(e.target.value))} title="скорость просмотра">
            {SPEEDS.map((s) => (
              <option key={s} value={s}>
                ×{s}
              </option>
            ))}
          </select>
        </div>
      </div>
    </div>
  );
}

/** Линейка: деления по кадрам, подписи, метки событий рецептов (удар, звук…), бегунок. Перетаскивание — перемотка. */
function Ruler({ clip, t, frames, onTime }: { clip: Clip | undefined; t: number; frames: number; onTime(t: number): void }) {
  const el = useRef<HTMLDivElement>(null);
  const d = clip?.duration ?? 1;
  const events = clip ? clipEvents(clip) : [];
  const seek = (x: number) => {
    const r = el.current!.getBoundingClientRect();
    onTime(Math.min(d, Math.max(0, ((x - r.left) / r.width) * d)));
  };
  // шаг подписей — чтобы помещалось ~8–12
  const every = [1, 2, 5, 10, 15, 30, 60, 120].find((k) => frames / k <= 12) ?? 240;
  const ticks = Array.from({ length: frames + 1 }, (_, i) => i);
  return (
    <div
      className="ruler"
      ref={el}
      onPointerDown={(e) => {
        (e.target as HTMLElement).setPointerCapture(e.pointerId);
        seek(e.clientX);
      }}
      onPointerMove={(e) => e.buttons & 1 && seek(e.clientX)}
    >
      {frames <= 400 &&
        ticks.map((i) => (
          <span key={i} className={`tick ${i % every === 0 ? "major" : ""}`} style={{ left: `${(i / frames) * 100}%` }}>
            {i % every === 0 && <em>{i}</em>}
          </span>
        ))}
      {events.map((ev, i) => (
        <span key={i} className={`ev ev-${ev.name}`} style={{ left: `${(ev.t / d) * 100}%` }} title={`${ev.name} · ${ev.t.toFixed(3)} с · ${ev.layer}`} />
      ))}
      <span className="fill" style={{ width: `${(Math.min(t, d) / d) * 100}%` }} />
      <span className="head" style={{ left: `${(Math.min(t, d) / d) * 100}%` }} />
    </div>
  );
}

const fmtTime = (s: number) => {
  const m = Math.floor(s / 60);
  return `${String(m).padStart(2, "0")}:${(s - m * 60).toFixed(3).padStart(6, "0")}`;
};
