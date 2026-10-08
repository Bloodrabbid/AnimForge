// Веса кожи: кисть по модели во вьюпорте, анимация при этом играет — правка видна сразу в движении.
import type { Brush, BrushMode } from "./weightPaint.ts";
import { Icon } from "./Icon.tsx";

interface Props {
  bone: string | null;
  brush: Brush;
  strokes: number;
  busy: boolean;
  onBrush(b: Brush): void;
  onUndo(): void;
  onSave(): void;
  onRestore(): void;
}

const MODES: { id: BrushMode; title: string; hint: string }[] = [
  { id: "add", title: "Добавить", hint: "кость сильнее тянет кожу под кистью" },
  { id: "sub", title: "Убрать", hint: "вес уходит соседним костям" },
  { id: "smooth", title: "Сгладить", hint: "выровнять переход между костями" },
];

export function WeightsPanel({ bone, brush, strokes, busy, onBrush, onUndo, onSave, onRestore }: Props) {
  return (
    <div className="weights panel">
      <div className="w-bone">
        {bone ? (
          <>
            кость <b>{bone}</b>
          </>
        ) : (
          <span className="muted">Кликните по модели — выберется кость под курсором (или слева во вкладке «Кости»).</span>
        )}
      </div>
      <div className="w-legend">
        <span>0</span>
        <i />
        <span>1</span>
      </div>
      <div className="seg">
        {MODES.map((m) => (
          <button key={m.id} className={brush.mode === m.id ? "on" : ""} onClick={() => onBrush({ ...brush, mode: m.id })} title={m.hint}>
            {m.title}
          </button>
        ))}
      </div>
      <label className="param">
        <span className="pname">радиус</span>
        <input
          type="range"
          min={0.01}
          max={0.3}
          step={0.005}
          value={brush.radius}
          style={{ ["--p" as string]: `${((brush.radius - 0.01) / 0.29) * 100}%` }}
          onChange={(e) => onBrush({ ...brush, radius: Number(e.target.value) })}
        />
        <span className="numwrap">{Math.round(brush.radius * 100)}%</span>
      </label>
      <label className="param">
        <span className="pname">сила</span>
        <input
          type="range"
          min={0.02}
          max={1}
          step={0.01}
          value={brush.strength}
          style={{ ["--p" as string]: `${((brush.strength - 0.02) / 0.98) * 100}%` }}
          onChange={(e) => onBrush({ ...brush, strength: Number(e.target.value) })}
        />
        <span className="numwrap">{Math.round(brush.strength * 100)}%</span>
      </label>
      <div className="w-actions">
        <button onClick={onUndo} disabled={!strokes || busy} title="Cmd+Z">
          Отменить
        </button>
        <button className="btn accent" onClick={onSave} disabled={!strokes || busy}>
          <Icon name="check" /> Сохранить{strokes ? ` (${strokes})` : ""}
        </button>
      </div>
      <button className="ghost small-link" onClick={onRestore} disabled={busy} title="веса, какие были до первой правки">
        Вернуть исходные веса
      </button>
      <ul className="w-help muted">
        <li>Левая кнопка по модели — кисть; Shift или Cmd + клик — выбрать кость под курсором.</li>
        <li>Камера — Alt + мышь, правая кнопка или клик мимо модели.</li>
        <li>Клип играет дальше: включите любое движение из библиотеки и правьте прямо в нём.</li>
      </ul>
    </div>
  );
}
