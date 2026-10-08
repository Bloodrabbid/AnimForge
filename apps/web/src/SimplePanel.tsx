// Простой режим: у клипа — 3–5 главных ручек рецепта (RecipeDef.main) и автопроверки с починкой.
// Всё остальное (слои, ключи, цели, пределы, веса) — за «Расширенным». Основная работа идёт словами через агента,
// здесь — посмотреть и поправить главное мышью.
import { useEffect, useState } from "react";
import { RECIPES, withDefaults, type Clip, type ParamSpec, type Project, type RecipeLayer } from "../../../packages/core/src/index.ts";
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
