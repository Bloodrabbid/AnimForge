// Ручные ключи клипа: треки (кость, ось), ключи, график кривой. Изменения — команды key.set и key.clear.
import { useEffect, useState } from "react";
import { evalKeys, type Clip, type Interp, type KeyLayer, type KeyTrack, type Channel, CHANNELS } from "../../../packages/core/src/index.ts";

const AXES: Channel[] = CHANNELS;
const AXIS_RU: Record<Channel, string> = {
  lateral: "вбок", vertical: "вверх-вниз", roll: "крен",
  pitch: "наклон тела (+ вперёд)", yaw: "поворот тела (+ влево)", bank: "крен тела (+ вправо)",
  move_up: "сдвиг вверх, м", move_forward: "сдвиг вперёд, м", move_side: "сдвиг вбок, м",
  scale_up: "масштаб по вертикали, +доля", scale_forward: "масштаб вперёд, +доля", scale_side: "масштаб вбок, +доля",
};

interface Props {
  clip: Clip;
  t: number;
  selectedBone: string | null;
  onSelectBone(bone: string): void;
  onTime(t: number): void;
  run(name: string, args: Record<string, unknown>): Promise<unknown>;
}

export function KeysPanel({ clip, t, selectedBone, onSelectBone, onTime, run }: Props) {
  const tracks: KeyTrack[] = clip.layers.filter((l): l is KeyLayer => l.type === "keys").flatMap((l) => l.tracks);
  const [axis, setAxis] = useState<Channel>("lateral");
  const [value, setValue] = useState("0");
  const [interp, setInterp] = useState<Interp | "">("");

  const track = selectedBone ? tracks.find((tr) => tr.bone === selectedBone && tr.axis === axis) : undefined;
  // ключ ставим на ближайший кадр клипа — так он совпадёт с кадром запекания
  const keyT = +(Math.round(t * clip.fps) / clip.fps).toFixed(4);
  const current = track ? evalKeys(track.keys, keyT, clip.loop, clip.duration) : 0;

  // при смене трека подставляем текущее значение кривой — удобно сдвигать от него
  useEffect(() => setValue(String(+current.toFixed(2))), [selectedBone, axis, track?.keys.length]);

  return (
    <section className="panel">
      <h2>Ручные ключи</h2>
      {tracks.length === 0 ? (
        <p className="muted">Ключей нет. Выберите кость слева и поставьте первый ключ.</p>
      ) : (
        <ul className="tracks">
          {tracks.map((tr) => {
            const sel = tr.bone === selectedBone && tr.axis === axis;
            return (
              <li key={`${tr.bone}/${tr.axis}`} className={sel ? "sel" : ""}>
                <span
                  className="track-name"
                  onClick={() => {
                    onSelectBone(tr.bone);
                    setAxis(tr.axis);
                  }}
                >
                  {tr.bone} · {tr.axis} <span className="muted">({AXIS_RU[tr.axis]}) · ключей {tr.keys.length}</span>
                </span>
                <button
                  className="small danger"
                  title="команда key.clear"
                  onClick={() => confirm(`Удалить трек ${tr.bone} · ${tr.axis}?`) && run("key.clear", { clip: clip.name, bone: tr.bone, axis: tr.axis })}
                >
                  удалить
                </button>
              </li>
            );
          })}
        </ul>
      )}

      <div className="key-form">
        <div>
          кость <b>{selectedBone ?? "— не выбрана —"}</b>
        </div>
        <div className="row">
          <select value={axis} onChange={(e) => setAxis(e.target.value as Channel)} title="ось тела">
            {AXES.map((a) => (
              <option key={a} value={a}>
                {a} ({AXIS_RU[a]})
              </option>
            ))}
          </select>
          <input className="num" type="number" step={0.5} value={value} onChange={(e) => setValue(e.target.value)} title="угол, °" />
          <span className="unit">°</span>
          <select value={interp} onChange={(e) => setInterp(e.target.value as Interp | "")} title="переход к следующему ключу">
            <option value="">smooth</option>
            <option value="linear">linear</option>
            <option value="step">step</option>
          </select>
        </div>
        <button
          disabled={!selectedBone || value === "" || !Number.isFinite(Number(value))}
          title="команда key.set"
          onClick={() =>
            run("key.set", { clip: clip.name, bone: selectedBone, axis, t: keyT, v: Number(value), ...(interp ? { interp } : {}) })
          }
        >
          Ключ в t = {keyT.toFixed(3)} с
        </button>
      </div>

      {track && (
        <>
          <Curve track={track} clip={clip} t={t} onTime={onTime} />
          <table className="keys">
            <thead>
              <tr>
                <th>t, с</th>
                <th>угол, °</th>
                <th>переход</th>
              </tr>
            </thead>
            <tbody>
              {track.keys.map((k) => (
                <tr key={k.t} onClick={() => onTime(k.t)} className={Math.abs(k.t - keyT) < 1e-4 ? "sel" : ""}>
                  <td>{k.t.toFixed(3)}</td>
                  <td>{k.v}</td>
                  <td>{k.interp ?? "smooth"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
      {selectedBone && !track && <p className="muted">У {selectedBone} нет ключей по оси {axis}.</p>}
    </section>
  );
}

/** График кривой трека: значения считает evalKeys из ядра, точки — ключи. Клик — перейти во времени. */
function Curve({ track, clip, t, onTime }: { track: KeyTrack; clip: Clip; t: number; onTime(t: number): void }) {
  const W = 300, H = 120, P = 8;
  const N = 160;
  const samples = Array.from({ length: N + 1 }, (_, i) => {
    const x = (i / N) * clip.duration;
    return [x, evalKeys(track.keys, x, clip.loop, clip.duration)] as const;
  });
  const vs = [0, ...samples.map((s) => s[1]), ...track.keys.map((k) => k.v)];
  let lo = Math.min(...vs), hi = Math.max(...vs);
  if (hi - lo < 1) (hi += 0.5), (lo -= 0.5);
  const pad = (hi - lo) * 0.1;
  lo -= pad;
  hi += pad;
  const sx = (x: number) => P + (x / clip.duration) * (W - 2 * P);
  const sy = (v: number) => H - P - ((v - lo) / (hi - lo)) * (H - 2 * P);
  const path = samples.map(([x, v], i) => `${i ? "L" : "M"}${sx(x).toFixed(1)},${sy(v).toFixed(1)}`).join("");

  return (
    <svg
      className="curve"
      viewBox={`0 0 ${W} ${H}`}
      onClick={(e) => {
        const r = (e.currentTarget as SVGSVGElement).getBoundingClientRect();
        const x = ((e.clientX - r.left) / r.width) * W;
        onTime(Math.min(clip.duration, Math.max(0, ((x - P) / (W - 2 * P)) * clip.duration)));
      }}
    >
      <line x1={P} x2={W - P} y1={sy(0)} y2={sy(0)} className="zero" />
      <text x={P + 2} y={P + 8} className="lbl">
        {hi.toFixed(1)}°
      </text>
      <text x={P + 2} y={H - P - 2} className="lbl">
        {lo.toFixed(1)}°
      </text>
      <path d={path} className="line" />
      <line x1={sx(Math.min(t, clip.duration))} x2={sx(Math.min(t, clip.duration))} y1={0} y2={H} className="head" />
      {track.keys.map((k) => (
        <circle key={k.t} cx={sx(k.t)} cy={sy(k.v)} r={4} className="key">
          <title>
            t={k.t} с, {k.v}°, {k.interp ?? "smooth"}
          </title>
        </circle>
      ))}
    </svg>
  );
}
