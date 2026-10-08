// Слои клипа. Слои одного рецепта и пресета (лапы паука, крылья) собраны в группу: общий параметр правится сразу у всех.
// Ползунки строятся из схемы RECIPES[recipe].params. Во время перетаскивания меняется только рабочая копия
// (поза сразу видна), при отпускании — команды recipe.set.
import { useRef, useState, type ReactNode } from "react";
import { RECIPES, withDefaults, type Clip, type ParamSpec, type Project, type RecipeLayer } from "../../../packages/core/src/index.ts";
import type { LibRecipe, Step } from "./api.ts";
import { Icon } from "./Icon.tsx";
import { sourceOf } from "./LibraryPanel.tsx";

interface Props {
  project: Project;
  clip: Clip;
  library: LibRecipe[];
  readOnly?: boolean;
  setProject(p: Project): void;
  runMany(steps: Step[], label?: string): Promise<unknown>;
}

interface Group {
  key: string;
  recipe: string;
  preset?: string;
  layers: RecipeLayer[];
}

export function LayersPanel({ project, clip, library, readOnly, setProject, runMany }: Props) {
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const groups: Group[] = [];
  for (const l of clip.layers) {
    if (l.type !== "recipe") continue;
    const key = `${l.recipe}|${l.preset ?? ""}`;
    const g = groups.find((g) => g.key === key);
    if (g) g.layers.push(l);
    else groups.push({ key, recipe: l.recipe, preset: l.preset, layers: [l] });
  }
  const keyLayers = clip.layers.filter((l) => l.type === "keys");

  /** Правка рабочей копии без записи на диск — для плавности во время перетаскивания. */
  const preview = (ids: string[], key: string, value: unknown) => {
    const next: Project = structuredClone(project);
    for (const l of next.clips.find((c) => c.name === clip.name)?.layers ?? [])
      if (l.type === "recipe" && ids.includes(l.id)) l.params[key] = value as number | string;
    setProject(next);
  };

  return (
    <div className="layers">
      {groups.length === 0 && keyLayers.length === 0 && (
        <div className="empty-state">
          <Icon name="library" size={28} />
          <p>В клипе нет слоёв.</p>
          <p className="muted">Выберите движение в библиотеке слева — оно сразу примерится на модель.</p>
        </div>
      )}
      {groups.map((g, gi) => (
        <GroupCard
          key={g.key}
          g={g}
          lib={library.find((l) => l.recipe === g.recipe)}
          open={open[g.key] ?? (gi === 0 && groups.length === 1)}
          readOnly={readOnly}
          onToggle={() => setOpen({ ...open, [g.key]: !(open[g.key] ?? (gi === 0 && groups.length === 1)) })}
          onPreview={(k, v) => preview(g.layers.map((l) => l.id), k, v)}
          onCommit={(params) => runMany(g.layers.map((l) => ({ name: "recipe.set", args: { clip: clip.name, layer: l.id, params } })), "recipe.set")}
          onResetPreset={(preset) => runMany(g.layers.map((l) => ({ name: "recipe.set", args: { clip: clip.name, layer: l.id, params: resetParams(l, preset, library) } })), "вернуть пресет")}
          onWeight={(w) => runMany([{ name: "layer.set", args: { clip: clip.name, layer: g.layers.map((l) => l.id).join(","), weight: w } }], w ? "слой включён" : "слой выключен")}
          onRemove={() =>
            confirm(`Убрать ${g.layers.length > 1 ? `${g.layers.length} слоёв` : "слой"} ${g.recipe}${g.preset ? ` (${g.preset})` : ""}?`) &&
            runMany([{ name: "layer.remove", args: { clip: clip.name, layer: g.layers.map((l) => l.id).join(",") } }], "слой убран")
          }
        />
      ))}
      {keyLayers.map((l) => (
        <div key={l.id} className="layer">
          <div className="layer-head static">
            <span className="badge keys">ключи</span>
            <b>{l.id}</b>
            <span className="muted">треков {l.type === "keys" ? l.tracks.length : 0} — правятся во вкладке «Ключи»</span>
          </div>
        </div>
      ))}
    </div>
  );
}

/** Значения пресета для слоя, кроме роли — роль у каждой лапы своя. */
function resetParams(l: RecipeLayer, preset: string, library: LibRecipe[]) {
  const p = library.flatMap((x) => x.presets).find((p) => p.name === preset);
  const { role: _r, ...rest } = (p?.params ?? {}) as Record<string, unknown>;
  return rest;
}

function GroupCard({
  g,
  lib,
  open,
  readOnly,
  onToggle,
  onPreview,
  onCommit,
  onResetPreset,
  onWeight,
  onRemove,
}: {
  g: Group;
  lib?: LibRecipe;
  open: boolean;
  readOnly?: boolean;
  onToggle(): void;
  onPreview(key: string, value: unknown): void;
  onCommit(params: Record<string, unknown>): void;
  onResetPreset(preset: string): void;
  onWeight(w: number): void;
  onRemove(): void;
}) {
  const def = RECIPES[g.recipe];
  if (!def) return <div className="layer error">Неизвестный рецепт «{g.recipe}»</div>;
  const first = g.layers[0];
  const values = withDefaults(def, first.params);
  const preset = g.preset ? lib?.presets.find((p) => p.name === g.preset) : undefined;
  // параметры, у которых значения в группе разные (роль лапы, сторона), правим не скопом
  const differs = new Set(Object.keys(def.params).filter((k) => g.layers.some((l) => !same(withDefaults(def, l.params)[k], values[k]))));
  const shared = Object.keys(def.params).filter((k) => !differs.has(k) && k !== "role");
  const changed = preset ? shared.filter((k) => preset.params[k] !== undefined && !same(preset.params[k], values[k])) : [];
  const muted = g.layers.every((l) => l.weight === 0);
  const chains = g.layers.map((l) => l.target.chain);

  return (
    <div className={`layer ${muted ? "muted-layer" : ""} ${open ? "open" : ""}`}>
      <div className="layer-head" onClick={onToggle} title={def.help}>
        <span className={`chev ${open ? "open" : ""}`}>
          <Icon name="chev" size={12} />
        </span>
        <div className="lh-main">
          <div className="lh-title">
            <b>{g.preset ?? g.recipe}</b>
            {g.layers.length > 1 && <span className="badge">×{g.layers.length}</span>}
            {changed.length > 0 && <span className="badge warn" title={`изменено: ${changed.join(", ")}`}>изменён</span>}
          </div>
          <div className="lh-sub">
            {g.recipe} → {chains.length > 3 ? `${chains.slice(0, 3).join(", ")} и ещё ${chains.length - 3}` : chains.join(", ")}
            {preset && sourceOf(preset).map((s) => <span key={s} className="src mini">{s}</span>)}
          </div>
        </div>
        {!readOnly && (
          <div className="lh-actions" onClick={(e) => e.stopPropagation()}>
            <button className={`icon sm ${muted ? "" : "on"}`} onClick={() => onWeight(muted ? 1 : 0)} title={muted ? "включить" : "выключить (вес 0)"}>
              <Icon name={muted ? "x" : "check"} size={14} />
            </button>
            <button className="icon sm danger" onClick={onRemove} title="убрать слой">
              <Icon name="x" size={14} />
            </button>
          </div>
        )}
      </div>
      {open && (
        <div className="layer-body">
          {preset && <p className="preset-help">{preset.help}</p>}
          {changed.length > 0 && !readOnly && (
            <div className="preset-line">
              <span className="warn">изменено: {changed.join(", ")}</span>
              <button className="small" onClick={() => onResetPreset(g.preset!)} title="вернуть значения пресета">
                вернуть пресет
              </button>
            </div>
          )}
          {shared.map((k) => (
            <ParamRow
              key={k}
              name={k}
              spec={def.params[k]}
              value={values[k]}
              presetValue={preset?.params[k]}
              disabled={readOnly}
              onPreview={(v) => onPreview(k, v)}
              onCommit={(v) => onCommit({ [k]: v })}
            />
          ))}
          {differs.size > 0 && <p className="muted hint">У слоёв группы свои: {[...differs].join(", ")}.</p>}
        </div>
      )}
    </div>
  );
}

function ParamRow({
  name,
  spec,
  value,
  presetValue,
  disabled,
  onPreview,
  onCommit,
}: {
  name: string;
  spec: ParamSpec;
  value: number | string;
  presetValue: unknown;
  disabled?: boolean;
  onPreview(v: unknown): void;
  onCommit(v: unknown): void;
}) {
  const dirty = presetValue !== undefined && !same(presetValue, value);
  const tip = `${spec.help}${presetValue !== undefined ? `\nв пресете: ${presetValue}` : ""}\nпо умолчанию: ${spec.default}`;
  const label = (
    <label className={`pname ${dirty ? "dirty" : ""}`} title={tip}>
      {name}
    </label>
  );

  if (spec.type === "enum") {
    return (
      <div className="param">
        {label}
        <select value={String(value)} onChange={(e) => onCommit(e.target.value)} title={tip} disabled={disabled}>
          {spec.options?.map((o) => (
            <option key={o}>{o}</option>
          ))}
        </select>
      </div>
    );
  }
  return <NumberParam label={label} spec={spec} value={Number(value)} tip={tip} disabled={disabled} onPreview={onPreview} onCommit={onCommit} />;
}

function NumberParam({
  label,
  spec,
  value,
  tip,
  disabled,
  onPreview,
  onCommit,
}: {
  label: ReactNode;
  spec: ParamSpec;
  value: number;
  tip: string;
  disabled?: boolean;
  onPreview(v: number): void;
  onCommit(v: number): void;
}) {
  const min = spec.min ?? 0;
  const max = spec.max ?? Math.max(1, value * 2);
  const step = stepFor(max - min);
  // значение, ещё не сохранённое командой (идёт перетаскивание)
  const pending = useRef<number | null>(null);
  const [text, setText] = useState<string | null>(null);
  const commit = () => {
    if (pending.current == null) return;
    const v = pending.current;
    pending.current = null;
    onCommit(v);
  };
  const pct = ((Math.min(max, Math.max(min, value)) - min) / (max - min || 1)) * 100;
  return (
    <div className="param">
      {label}
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        title={tip}
        disabled={disabled}
        style={{ ["--p" as string]: `${pct}%` }}
        onChange={(e) => {
          pending.current = Number(e.target.value);
          onPreview(pending.current);
        }}
        onPointerUp={commit}
        onKeyUp={commit}
        onBlur={commit}
      />
      <span className="numwrap">
        <input
          className="num"
          type="number"
          min={min}
          max={max}
          step={step}
          disabled={disabled}
          value={text ?? fmt(value, step)}
          onChange={(e) => setText(e.target.value)}
          onBlur={() => {
            if (text != null && text !== "" && Number(text) !== value) onCommit(Number(text));
            setText(null);
          }}
          onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
        />
        <span className="unit">{spec.unit ?? ""}</span>
      </span>
    </div>
  );
}

const stepFor = (range: number) => (range >= 100 ? 1 : range >= 10 ? 0.1 : range >= 1 ? 0.05 : 0.01);
const fmt = (v: number, step: number) => (step >= 1 ? String(Math.round(v)) : String(+v.toFixed(step >= 0.1 ? 1 : 2)));
const same = (a: unknown, b: unknown) => (typeof a === "number" || typeof b === "number" ? Math.abs(Number(a) - Number(b)) < 1e-9 : a === b);
