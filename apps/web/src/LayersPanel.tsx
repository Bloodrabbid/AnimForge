// Слои клипа. Для слоя-рецепта ползунки строятся из схемы RECIPES[recipe].params.
// Во время перетаскивания меняется только рабочая копия (поза сразу видна), при отпускании — команда recipe.set.
import { useRef, useState, type ReactNode } from "react";
import { RECIPES, withDefaults, type Clip, type ParamSpec, type Project, type RecipeLayer } from "../../../packages/core/src/index.ts";
import type { PresetLib } from "./api.ts";

interface Props {
  project: Project;
  clip: Clip;
  presets: PresetLib[];
  setProject(p: Project): void;
  run(name: string, args: Record<string, unknown>): Promise<unknown>;
}

export function LayersPanel({ project, clip, presets, setProject, run }: Props) {
  /** Правка рабочей копии без записи на диск — для плавности во время перетаскивания. */
  const preview = (layerId: string, key: string, value: unknown) => {
    const next: Project = structuredClone(project);
    const l = next.clips.find((c) => c.name === clip.name)?.layers.find((l) => l.id === layerId);
    if (l && l.type === "recipe") l.params[key] = value as number | string;
    setProject(next);
  };

  return (
    <section className="panel">
      <h2>Слои клипа «{clip.name}»</h2>
      {clip.layers.length === 0 && <p className="muted">Слоёв нет.</p>}
      {clip.layers.map((l) =>
        l.type === "recipe" ? (
          <RecipeCard
            key={l.id}
            layer={l}
            presets={presets}
            onPreview={(k, v) => preview(l.id, k, v)}
            onCommit={(params) => run("recipe.set", { clip: clip.name, layer: l.id, params })}
            onResetPreset={(preset) => run("preset.apply", { clip: clip.name, layer: l.id, preset })}
          />
        ) : (
          <div key={l.id} className="layer">
            <div className="layer-head">
              <b>{l.id}</b> <span className="muted">ручные ключи · треков {l.tracks.length}</span>
            </div>
          </div>
        ),
      )}
    </section>
  );
}

function RecipeCard({
  layer,
  presets,
  onPreview,
  onCommit,
  onResetPreset,
}: {
  layer: RecipeLayer;
  presets: PresetLib[];
  onPreview(key: string, value: unknown): void;
  onCommit(params: Record<string, unknown>): void;
  onResetPreset(preset: string): void;
}) {
  const def = RECIPES[layer.recipe];
  if (!def) return <div className="layer error">Неизвестный рецепт «{layer.recipe}»</div>;
  const values = withDefaults(def, layer.params);
  const preset = layer.preset ? presets.flatMap((p) => p.presets).find((p) => p.name === layer.preset) : undefined;
  const changed = preset ? Object.keys(def.params).filter((k) => preset.params[k] !== undefined && !same(preset.params[k], values[k])) : [];

  return (
    <div className="layer">
      <div className="layer-head" title={def.help}>
        <b>{layer.id}</b> <span className="muted">рецепт {layer.recipe} → цепочка {layer.target.chain}</span>
        {layer.weight != null && layer.weight !== 1 && <span className="muted"> · вес {layer.weight}</span>}
      </div>
      <div className="preset-line">
        {layer.preset ? (
          <>
            пресет <b title={preset?.help}>{layer.preset}</b>
            {!preset && presets.length > 0 && <span className="warn"> (нет в библиотеке)</span>}
            {changed.length > 0 ? (
              <>
                <span className="warn"> · изменено: {changed.join(", ")}</span>
                <button className="small" onClick={() => onResetPreset(layer.preset!)} title="команда preset.apply с этим слоем">
                  вернуть пресет
                </button>
              </>
            ) : (
              preset && <span className="muted"> · как в пресете</span>
            )}
          </>
        ) : (
          <span className="muted">без пресета</span>
        )}
      </div>
      {Object.entries(def.params).map(([k, spec]) => (
        <ParamRow
          key={k}
          name={k}
          spec={spec}
          value={values[k]}
          presetValue={preset?.params[k]}
          onPreview={(v) => onPreview(k, v)}
          onCommit={(v) => onCommit({ [k]: v })}
        />
      ))}
    </div>
  );
}

function ParamRow({
  name,
  spec,
  value,
  presetValue,
  onPreview,
  onCommit,
}: {
  name: string;
  spec: ParamSpec;
  value: number | string;
  presetValue: unknown;
  onPreview(v: unknown): void;
  onCommit(v: unknown): void;
}) {
  const dirty = presetValue !== undefined && !same(presetValue, value);
  const tip = `${spec.help}${presetValue !== undefined ? `\nв пресете: ${presetValue}` : ""}\nпо умолчанию: ${spec.default}`;
  const label = (
    <label className={`pname ${dirty ? "dirty" : ""}`} title={tip}>
      {dirty ? "● " : ""}
      {name}
    </label>
  );

  if (spec.type === "enum") {
    return (
      <div className="param">
        {label}
        <select value={String(value)} onChange={(e) => onCommit(e.target.value)} title={tip}>
          {spec.options?.map((o) => (
            <option key={o}>{o}</option>
          ))}
        </select>
      </div>
    );
  }
  return <NumberParam label={label} spec={spec} value={Number(value)} tip={tip} onPreview={onPreview} onCommit={onCommit} />;
}

function NumberParam({
  label,
  spec,
  value,
  tip,
  onPreview,
  onCommit,
}: {
  label: ReactNode;
  spec: ParamSpec;
  value: number;
  tip: string;
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
        onChange={(e) => {
          pending.current = Number(e.target.value);
          onPreview(pending.current);
        }}
        onPointerUp={commit}
        onKeyUp={commit}
        onBlur={commit}
      />
      <input
        className="num"
        type="number"
        min={min}
        max={max}
        step={step}
        value={text ?? fmt(value, step)}
        onChange={(e) => setText(e.target.value)}
        onBlur={() => {
          if (text != null && text !== "" && Number(text) !== value) onCommit(Number(text));
          setText(null);
        }}
        onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
      />
      <span className="unit">{spec.unit ?? ""}</span>
    </div>
  );
}

const stepFor = (range: number) => (range >= 100 ? 1 : range >= 10 ? 0.1 : range >= 1 ? 0.05 : 0.01);
const fmt = (v: number, step: number) => (step >= 1 ? String(Math.round(v)) : String(+v.toFixed(step >= 0.1 ? 1 : 2)));
const same = (a: unknown, b: unknown) => (typeof a === "number" || typeof b === "number" ? Math.abs(Number(a) - Number(b)) < 1e-9 : a === b);
