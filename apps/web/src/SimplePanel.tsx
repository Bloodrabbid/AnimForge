// Простой режим: у клипа — 3–5 главных ручек рецепта (RecipeDef.main) и автопроверки с починкой.
// Всё остальное (слои, ключи, цели, пределы, веса) — за «Расширенным». Основная работа идёт словами через агента,
// здесь — посмотреть и поправить главное мышью.
import { useEffect, useState } from "react";
import { GAIT_STYLES, RECIPES, withDefaults, type Clip, type GaitStyle, type ParamSpec, type Project, type RecipeLayer } from "../../../packages/core/src/index.ts";
import { command, type Step } from "./api.ts";
import { Icon } from "./Icon.tsx";

interface Finding {
  check: string;
  level: "fail" | "warn";
  msg: string;
  fixed?: string;
}
interface Report {
  clip: string;
  ok: boolean;
  findings: Finding[];
}

interface Props {
  dir: string;
  project: Project;
  clip: Clip;
  readOnly?: boolean;
  runMany(steps: Step[], label?: string): Promise<unknown>;
}

export function SimplePanel({ dir, project, clip, readOnly, runMany }: Props) {
  // слои одного рецепта (ходьба на всё тело — 7 слоёв) правятся вместе: ручка одна на рецепт
  const byRecipe = new Map<string, RecipeLayer[]>();
  for (const l of clip.layers) if (l.type === "recipe" && RECIPES[l.recipe]?.main?.length) byRecipe.set(l.recipe, [...(byRecipe.get(l.recipe) ?? []), l]);

  return (
    <div className="simple panel">
      {[...byRecipe].map(([recipe, layers]) => (
        <RecipeKnobs key={recipe} clip={clip} recipe={recipe} layers={layers} readOnly={readOnly} runMany={runMany} />
      ))}
      {!byRecipe.size && <p className="muted">У клипа нет рецептов с ручками — только ключи и позы. Они — в «Расширенном».</p>}
      {clip.loop && Object.keys(project.chains).some((c) => c.startsWith("leg_")) && <GaitKnobs clip={clip} readOnly={readOnly} runMany={runMany} />}
      <Checks dir={dir} project={project} clip={clip} readOnly={readOnly} runMany={runMany} />
    </div>
  );
}

function RecipeKnobs({ clip, recipe, layers, readOnly, runMany }: { clip: Clip; recipe: string; layers: RecipeLayer[]; readOnly?: boolean; runMany: Props["runMany"] }) {
  const def = RECIPES[recipe];
  const p = withDefaults(def, layers[0].params);
  const [drag, setDrag] = useState<Record<string, number>>({});
  const set = (k: string, v: number) =>
    runMany(layers.map((l) => ({ name: "recipe.set", args: { clip: clip.name, layer: l.id, params: { [k]: v } } })), `${k} = ${v}`).then(() => setDrag({}));
  return (
    <section className="knobs">
      <h3>
        {layers[0].preset ?? recipe} <span className="muted">{recipe}</span>
      </h3>
      {def.main!.map((k) => {
        const spec: ParamSpec = def.params[k];
        if (!spec || spec.type !== "number") return null;
        const v = drag[k] ?? Number(p[k]);
        const step = (spec.max! - spec.min!) / 200;
        return (
          <label key={k} className="knob" title={spec.help}>
            <span className="k-name">{label(k, spec)}</span>
            <input
              type="range"
              min={spec.min}
              max={spec.max}
              step={step}
              value={v}
              disabled={readOnly}
              onChange={(e) => setDrag({ ...drag, [k]: Number(e.target.value) })}
              onPointerUp={() => drag[k] != null && set(k, +drag[k].toFixed(3))}
              onKeyUp={() => drag[k] != null && set(k, +drag[k].toFixed(3))}
            />
            <span className="k-val">
              {+v.toFixed(v < 10 ? 2 : 0)}
              {spec.unit ? ` ${spec.unit}` : ""}
            </span>
          </label>
        );
      })}
    </section>
  );
}

/** Стиль походки (clip.gait) поверх любого цикла: готовый набор и ручки; ×1 / 0 — без изменений. */
const GAIT_KNOBS: { k: keyof GaitStyle; name: string; min: number; max: number; def: number; unit?: string; help: string }[] = [
  { k: "speed", name: "скорость", min: 0.5, max: 2.5, def: 1, unit: "×", help: "частота шагов ^0.6, длина шага ^0.4 — длина клипа меняется сама" },
  { k: "stance", name: "доля опоры", min: 0.2, max: 0.85, def: 0, help: "какую часть цикла стопа на земле: шаг ~0.6, бег ~0.35; 0 — как в рецепте" },
  { k: "bounce", name: "подскок", min: 0, max: 3, def: 1, unit: "×", help: "подскок таза вокруг средней высоты" },
  { k: "sway", name: "раскачка", min: 0, max: 3, def: 1, unit: "×", help: "рыскание и крен таза" },
  { k: "arms", name: "мах рук", min: 0, max: 3, def: 1, unit: "×", help: "размах рук" },
  { k: "lift", name: "подъём стопы", min: 0, max: 3, def: 1, unit: "×", help: "сгиб колена в переносе" },
  { k: "lean", name: "наклон", min: -20, max: 40, def: 0, unit: "°", help: "наклон корпуса вперёд" },
];

function GaitKnobs({ clip, readOnly, runMany }: { clip: Clip; readOnly?: boolean; runMany: Props["runMany"] }) {
  const g = clip.gait ?? {};
  const [drag, setDrag] = useState<Partial<Record<keyof GaitStyle, number>>>({});
  const put = (next: GaitStyle | null, label: string) =>
    runMany([{ name: "clip.gait", args: { clip: clip.name, ...(next && Object.keys(next).length ? { gait: next } : {}) } }], label).then(() => setDrag({}));
  const set = (k: keyof GaitStyle, v: number, def: number) => {
    const next: GaitStyle = { ...g, [k]: v };
    // ручка в нейтрали (×1, 0°; доля опоры 0 — «как в рецепте») — поле убирается
    if (v === def || (k === "stance" && v < 0.2)) delete next[k];
    return put(next, `походка: ${k} = ${v}`);
  };
  return (
    <section className="knobs gait-knobs">
      <h3>
        Походка <span className="muted">clip.gait</span>
      </h3>
      <div className="gait-styles">
        {Object.entries(GAIT_STYLES).map(([name, st]) => (
          <button key={name} className="chip" disabled={readOnly} title={st.help} onClick={() => runMany([{ name: "clip.gait", args: { clip: clip.name, style: name } }], `походка: ${name}`)}>
            {name}
          </button>
        ))}
        {clip.gait && (
          <button className="chip" disabled={readOnly} onClick={() => put(null, "походка: как в рецепте")}>
            сбросить
          </button>
        )}
      </div>
      {GAIT_KNOBS.map((x) => {
        const v = drag[x.k] ?? (g[x.k] as number | undefined) ?? (x.k === "stance" ? 0.2 : x.def);
        const shown = x.k === "stance" && g.stance == null && drag.stance == null ? "рецепт" : `${+v.toFixed(2)}${x.unit ? ` ${x.unit}` : ""}`;
        return (
          <label key={x.k} className="knob" title={x.help}>
            <span className="k-name">{x.name}</span>
            <input
              type="range"
              min={x.min}
              max={x.max}
              step={(x.max - x.min) / 100}
              value={v}
              disabled={readOnly}
              onChange={(e) => setDrag({ ...drag, [x.k]: Number(e.target.value) })}
              onPointerUp={() => drag[x.k] != null && set(x.k, +drag[x.k]!.toFixed(3), x.def)}
              onKeyUp={() => drag[x.k] != null && set(x.k, +drag[x.k]!.toFixed(3), x.def)}
            />
            <span className="k-val">{shown}</span>
          </label>
        );
      })}
    </section>
  );
}

/** Подпись ручки — начало подсказки («крен таза «вразвалку»»); если там формула или символ (ζ: 0.2…) — имя параметра. */
const label = (k: string, spec: ParamSpec) => {
  const h = spec.help.split(/[(,—:]/)[0].trim();
  return h.length >= 4 ? h : k;
};

const ICON: Record<string, string> = { fail: "✗", warn: "△" };

function Checks({ dir, project, clip, readOnly, runMany }: Props) {
  const [rep, setRep] = useState<Report | null>(null);
  const [busy, setBusy] = useState(false);
  const run = async (fix: boolean) => {
    setBusy(true);
    try {
      if (fix) await runMany([{ name: "check", args: { clip: clip.name, fix: true } }], "починка");
      const r = await command<Report[]>(dir, "check", { clip: clip.name });
      setRep(r[0] ?? null);
    } finally {
      setBusy(false);
    }
  };
  // клип или проект поменялись — прежний отчёт устарел
  useEffect(() => setRep(null), [clip, project]);
  return (
    <section className="checks">
      <h3>
        Проверка{" "}
        {rep && <span className={rep.ok ? "ok" : "bad"}>{rep.ok ? (rep.findings.length ? "с замечаниями" : "чисто") : "есть брак"}</span>}
      </h3>
      {rep?.findings.map((f, i) => (
        <p key={i} className={`finding ${f.level}`}>
          <b>{ICON[f.level]}</b> {f.msg}
          {f.fixed && <span className="muted"> — починено: {f.fixed}</span>}
        </p>
      ))}
      <div className="row">
        <button onClick={() => run(false)} disabled={busy} title="кожа не рвётся, не проваливается в пол, шов цикла, рывки, пределы, тайминг удара">
          <Icon name="check" size={13} /> Проверить
        </button>
        <button className="btn accent" onClick={() => run(true)} disabled={busy || readOnly || (rep != null && rep.ok && !rep.findings.length)} title="сгладить веса, поставить стопы на пол, ослабить то, что рвёт кожу">
          Починить
        </button>
      </div>
    </section>
  );
}
