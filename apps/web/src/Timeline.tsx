// Время: плей/пауза, ползунок, выбор клипа, переключатель скелета.
import type { Clip } from "../../../packages/core/src/index.ts";

interface Props {
  clips: string[];
  clip: Clip | undefined;
  t: number;
  playing: boolean;
  showSkeleton: boolean;
  onClip(name: string): void;
  onTime(t: number): void;
  onPlay(p: boolean): void;
  onSkeleton(v: boolean): void;
}

export function Timeline({ clips, clip, t, playing, showSkeleton, onClip, onTime, onPlay, onSkeleton }: Props) {
  const d = clip?.duration ?? 1;
  const frame = clip ? Math.round(t * clip.fps) : 0;
  return (
    <div className="timeline">
      <button onClick={() => onPlay(!playing)} disabled={!clip}>
        {playing ? "❚❚ Пауза" : "▶ Играть"}
      </button>
      <input
        type="range"
        min={0}
        max={d}
        step={0.001}
        value={Math.min(t, d)}
        disabled={!clip}
        onChange={(e) => onTime(Number(e.target.value))}
      />
      <span className="time">
        {t.toFixed(3)} / {d.toFixed(2)} с · кадр {frame}
      </span>
      <select value={clip?.name ?? ""} onChange={(e) => onClip(e.target.value)} title="клип">
        {clips.map((c) => (
          <option key={c}>{c}</option>
        ))}
      </select>
      <label title="показать кости поверх модели">
        <input type="checkbox" checked={showSkeleton} onChange={(e) => onSkeleton(e.target.checked)} /> скелет
      </label>
    </div>
  );
}
