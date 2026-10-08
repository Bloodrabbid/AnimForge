// Ограничения (констрейны): диапазон движения выбранной кости по осям и где кость сейчас — прямо в идущей анимации.
// Всё — команды ядра limit.set / limit.clear / limit.auto / limit.fit; расчёт позы обрезает поворот (limits.ts).
import { useMemo, useState } from "react";
import { boneAngles, motionAt, type Clip, type LimitAxis, type Project, type Rig } from "../../../packages/core/src/index.ts";
import type { Step } from "./api.ts";

interface Props {
  project: Project;
  rig: Rig;
  clip: Clip | undefined;
  t: number;
  bone: string | null;
  readOnly?: boolean;
  onSelectBone(b: string): void;
  runMany(steps: Step[], label?: string): Promise<unknown>;
}

const CHAIN_AXES: [LimitAxis, string][] = [
  ["lateral", "изгиб ↔"],
  ["vertical", "изгиб ↕"],
  ["roll", "кручение"],
];
const BODY_AXES: [LimitAxis, string][] = [
  ["pitch", "наклон (+ вперёд)"],
  ["yaw", "поворот (+ влево)"],
  ["bank", "крен (+ вправо)"],
];

export function LimitsPanel({ project, rig, clip, t, bone, readOnly, onSelectBone, runMany }: Props) {
  const lim = bone ? project.limits?.[bone] : undefined;
  const inChain = !!bone && Object.values(project.chains).some((c) => c.includes(bone) && c.length > 1);
  const [bodyMode, setBodyMode] = useState<boolean | null>(null);
  const body = bodyMode ?? (lim ? Object.keys(lim).some((k) => ["pitch", "yaw", "bank"].includes(k)) : !inChain);
  const axes = body ? BODY_AXES : CHAIN_AXES;
  const chainOf = bone ? Object.entries(project.chains).find(([, c]) => c.includes(bone))?.[0] : undefined;

  // где кость сейчас: углы без ограничений (видно, насколько анимация хочет выйти за предел)
  const now = useMemo(() => {
    if (!bone || !clip) return null;
    const free = { ...project, limits: undefined };
    const m = motionAt(free, rig, clip, t);
    const d = m.rot.get(bone);
    return d ? boneAngles(rig, project, bone, d, m.base.get(bone), body) : {};
  }, [bone, clip, t, project, rig, body]);

  const set = (axis: LimitAxis, min: number, max: number, all = false) =>
    runMany([{ name: "limit.set", args: { ...(all && chainOf ? { chain: chainOf } : { bone }), axis, min: Math.round(min), max: Math.round(max) } }], "предел");
  const clear = (axis?: LimitAxis) => runMany([{ name: "limit.clear", args: { bone, ...(axis ? { axis } : {}) } }], "предел снят");
  const list = Object.entries(project.limits ?? {});

  return (
    <div className="limits panel">
      <div className="lim-tools">
        <button onClick={() => runMany([{ name: "limit.auto", args: {} }], "анатомия")} disabled={readOnly} title="колени и локти гнутся только в свою сторону, голова и шея — в пределах человека">
          Анатомия
        </button>
        <button
          onClick={() => runMany([{ name: "limit.fit", args: chainOf ? { chain: chainOf } : bone ? { bone } : {} }], "пределы по клипам")}
          disabled={readOnly}
          title={`диапазон «как в клипах» с запасом 5° — ${chainOf ? `для цепочки ${chainOf}` : bone ? `для ${bone}` : "для всех костей"}`}
        >
          Снять с клипов
        </button>
        <button className="ghost" onClick={() => confirm("Снять все ограничения проекта?") && runMany([{ name: "limit.clear", args: {} }], "все пределы сняты")} disabled={readOnly || !list.length}>
          Снять все
        </button>
      </div>

      {!bone ? (
        <p className="muted">Выберите кость — во вкладке «Кости» или кликом по модели во вкладке «Веса».</p>
      ) : (
        <div className="lim-bone">
          <div className="lim-head">
            <b>{bone}</b>
            {chainOf && <span className="muted"> · цепочка {chainOf}</span>}
            <div className="seg mini">
              <button className={!body ? "on" : ""} onClick={() => setBodyMode(false)} title="оси цепочки: как у ключей lateral / vertical / roll">
                цепочка
              </button>
              <button className={body ? "on" : ""} onClick={() => setBodyMode(true)} title="оси тела: pitch / yaw / bank — для таза, груди, головы">
                тело
              </button>
            </div>
          </div>
          {axes.map(([axis, label]) => (
            <AxisRow
              key={axis}
              axis={axis}
              label={label}
              range={lim?.[axis]}
              now={now?.[axis]}
              readOnly={readOnly}
              chain={chainOf}
              onSet={(a, b, all) => set(axis, a, b, all)}
              onClear={() => clear(axis)}
            />
          ))}
        </div>
      )}

      {list.length > 0 && (
        <>
          <h2>Ограничено костей: {list.length}</h2>
          <ul className="lim-list">
            {list.map(([b, l]) => (
              <li key={b} className={b === bone ? "sel" : ""} onClick={() => onSelectBone(b)}>
                <span className="bname">{b}</span>
                <span className="muted">
                  {Object.entries(l)
                    .map(([k, r]) => `${k} ${r![0]}…${r![1]}°`)
                    .join(" · ")}
                </span>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}

function AxisRow({
  axis,
  label,
  range,
  now,
  readOnly,
  chain,
  onSet,
  onClear,
}: {
  axis: LimitAxis;
  label: string;
  range?: [number, number];
  now?: number;
  readOnly?: boolean;
  chain?: string;
  onSet(min: number, max: number, all: boolean): void;
  onClear(): void;
}) {
  const [drag, setDrag] = useState<[number, number] | null>(null);
  const r = drag ?? range ?? [-180, 180];
  const on = !!range;
  const pct = (v: number) => ((Math.max(-180, Math.min(180, v)) + 180) / 360) * 100;
  const out = on && now != null && (now < r[0] - 0.5 || now > r[1] + 0.5);
  const commit = () => {
    if (drag) onSet(drag[0], drag[1], false);
    setDrag(null);
  };
  return (
    <div className={`axis ${on ? "on" : ""}`}>
      <div className="axis-head">
        <label>
          <input type="checkbox" checked={on} disabled={readOnly} onChange={(e) => (e.target.checked ? onSet(-45, 45, false) : onClear())} />
          <b>{axis}</b> <span className="muted">{label}</span>
        </label>
        <span className={`now ${out ? "out" : ""}`} title="угол кости сейчас в клипе (без ограничения)">
          {now != null ? `${now.toFixed(0)}°` : "—"}
          {out && " упёрлась"}
        </span>
      </div>
      <div className={`dual ${on ? "" : "off"}`}>
        <div className="track" />
        {on && <div className="fill" style={{ left: `${pct(r[0])}%`, width: `${pct(r[1]) - pct(r[0])}%` }} />}
        <div className="zero" style={{ left: "50%" }} />
        {now != null && <div className={`marker ${out ? "out" : ""}`} style={{ left: `${pct(now)}%` }} />}
        <input
          type="range"
          min={-180}
          max={180}
          step={1}
          value={r[0]}
          disabled={!on || readOnly}
          onChange={(e) => setDrag([Math.min(Number(e.target.value), r[1]), r[1]])}
          onPointerUp={commit}
          onKeyUp={commit}
        />
        <input
          type="range"
          min={-180}
          max={180}
          step={1}
          value={r[1]}
          disabled={!on || readOnly}
          onChange={(e) => setDrag([r[0], Math.max(Number(e.target.value), r[0])])}
          onPointerUp={commit}
          onKeyUp={commit}
        />
      </div>
      {on && (
        <div className="axis-nums">
          <NumBox value={r[0]} disabled={readOnly} onCommit={(v) => onSet(Math.min(v, r[1]), r[1], false)} />
          <span className="muted">…</span>
          <NumBox value={r[1]} disabled={readOnly} onCommit={(v) => onSet(r[0], Math.max(v, r[0]), false)} />
          <span className="muted">°</span>
          {chain && (
            <button className="small" disabled={readOnly} onClick={() => onSet(r[0], r[1], true)} title={`тот же диапазон каждой кости цепочки ${chain}`}>
              всей цепочке
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function NumBox({ value, disabled, onCommit }: { value: number; disabled?: boolean; onCommit(v: number): void }) {
  const [text, setText] = useState<string | null>(null);
  return (
    <input
      className="num"
      type="number"
      step={1}
      disabled={disabled}
      value={text ?? String(Math.round(value))}
      onChange={(e) => setText(e.target.value)}
      onBlur={() => {
        if (text != null && text !== "" && Number.isFinite(Number(text))) onCommit(Number(text));
        setText(null);
      }}
      onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
    />
  );
}
