// Простой режим: у клипа — 3–5 главных ручек рецепта (RecipeDef.main) и автопроверки с починкой.
// Всё остальное (слои, ключи, цели, пределы, веса) — за «Расширенным». Основная работа идёт словами через агента,
// здесь — посмотреть и поправить главное мышью.
import { useEffect, useState } from "react";
import { GAIT_STYLES, HAND_POSES, STYLE100, RECIPES, fingersOf, followBones, microBones, withDefaults, type Clip, type GaitStyle, type ParamSpec, type Project, type RecipeLayer, type Rig } from "../../../packages/core/src/index.ts";
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
  /** для поз кисти: есть ли пальцы */
  rig?: Rig;
  readOnly?: boolean;
  runMany(steps: Step[], label?: string): Promise<unknown>;
}

export function SimplePanel({ dir, project, clip, rig, readOnly, runMany }: Props) {
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
      {project.chains.leg_l && project.chains.leg_r && <StyleKnobs clip={clip} readOnly={readOnly} runMany={runMany} />}
      {microBones(project).length > 0 && <MicroKnobs clip={clip} readOnly={readOnly} runMany={runMany} />}
      {followBones(project).length > 0 && <FollowKnobs clip={clip} readOnly={readOnly} runMany={runMany} />}
      {rig && (fingersOf(project, rig, "l") || fingersOf(project, rig, "r")) && <HandKnobs clip={clip} readOnly={readOnly} runMany={runMany} />}
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

const FOLLOW: { k: "lag" | "bounce" | "loosen"; name: string; def: number; min: number; max: number; unit?: string; help: string }[] = [
  { k: "lag", name: "запаздывание", def: 0.08, min: 0.01, max: 0.5, unit: "с", help: "насколько грудь отстаёт от таза, голова и руки — от груди" },
  { k: "bounce", name: "перелёт", def: 0.3, min: 0, max: 1, help: "пружина: 0 — догоняет мягко, 1 — проскакивает и возвращается" },
  { k: "loosen", name: "доля", def: 0.6, min: 0, max: 1, help: "1 — грудь целиком отстаёт от таза, 0 — выключено" },
];

/** Догоняющее движение (clip.follow): верх тела догоняет низ через пружину. */
function FollowKnobs({ clip, readOnly, runMany }: { clip: Clip; readOnly?: boolean; runMany: Props["runMany"] }) {
  const f = clip.follow;
  const [drag, setDrag] = useState<Partial<Record<"lag" | "bounce" | "loosen", number>>>({});
  const set = (k: string, v: number) => runMany([{ name: "clip.follow", args: { clip: clip.name, [k]: v } }], `догоняющее: ${k} = ${v}`).then(() => setDrag({}));
  return (
    <section className="knobs">
      <h3>
        Догоняющее движение <span className="muted">clip.follow</span>
      </h3>
      <div className="gait-styles">
        {f ? (
          <button className="chip" disabled={readOnly} onClick={() => runMany([{ name: "clip.follow", args: { clip: clip.name } }], "догоняющее выключено")}>
            выключить
          </button>
        ) : (
          <button className="chip" disabled={readOnly} title="грудь догоняет таз, голова и руки — грудь" onClick={() => runMany([{ name: "clip.follow", args: { clip: clip.name, lag: 0.08, bounce: 0.3, loosen: 0.6 } }], "догоняющее включено")}>
            включить
          </button>
        )}
      </div>
      {f &&
        FOLLOW.map((x) => {
          const v = drag[x.k] ?? f[x.k] ?? x.def;
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
                onPointerUp={() => drag[x.k] != null && set(x.k, +drag[x.k]!.toFixed(3))}
                onKeyUp={() => drag[x.k] != null && set(x.k, +drag[x.k]!.toFixed(3))}
              />
              <span className="k-val">{`${+v.toFixed(2)}${x.unit ? ` ${x.unit}` : ""}`}</span>
            </label>
          );
        })}
    </section>
  );
}

const MICRO: { k: "amount" | "speed"; name: string; def: number; min: number; max: number; unit: string; help: string }[] = [
  { k: "amount", name: "размах", def: 1.5, min: 0, max: 10, unit: "°", help: "насколько покачиваются таз, спина, голова и руки" },
  { k: "speed", name: "частота", def: 0.4, min: 0.05, max: 3, unit: "Гц", help: "как часто: 0.2 — сонно, 1 — нервно" },
];

/** Микродвижения (clip.micro): случайные плавные покачивания поверх клипа; зерно — свой рисунок движений. */
function MicroKnobs({ clip, readOnly, runMany }: { clip: Clip; readOnly?: boolean; runMany: Props["runMany"] }) {
  const m = clip.micro;
  const [drag, setDrag] = useState<Partial<Record<"amount" | "speed", number>>>({});
  const set = (args: Record<string, number>, label: string) => runMany([{ name: "clip.micro", args: { clip: clip.name, ...m, ...args } }], label).then(() => setDrag({}));
  return (
    <section className="knobs">
      <h3>
        Микродвижения <span className="muted">clip.micro</span>
      </h3>
      <div className="gait-styles">
        {m ? (
          <>
            <button className="chip" disabled={readOnly} title="тот же размах и частота, другой рисунок" onClick={() => set({ seed: ((m.seed ?? 1) * 7 + 13) % 100000 }, "микродвижения: другое зерно")}>
              другие · зерно {m.seed ?? 1}
            </button>
            <button className="chip" disabled={readOnly} onClick={() => runMany([{ name: "clip.micro", args: { clip: clip.name } }], "микродвижения выключены")}>
              выключить
            </button>
          </>
        ) : (
          <button className="chip" disabled={readOnly} title="живость стойки: таз, спина, голова и руки чуть покачиваются" onClick={() => set({ amount: 1.5 }, "микродвижения включены")}>
            включить
          </button>
        )}
      </div>
      {m &&
        MICRO.map((x) => {
          const v = drag[x.k] ?? m[x.k] ?? x.def;
          return (
            <label key={x.k} className="knob" title={x.help}>
              <span className="k-name">{x.name}</span>
              <input type="range" min={x.min} max={x.max} step={(x.max - x.min) / 100} value={v} disabled={readOnly} onChange={(e) => setDrag({ ...drag, [x.k]: Number(e.target.value) })} onPointerUp={() => drag[x.k] != null && set({ [x.k]: +drag[x.k]!.toFixed(3) }, `микродвижения: ${x.name}`)} onKeyUp={() => drag[x.k] != null && set({ [x.k]: +drag[x.k]!.toFixed(3) }, `микродвижения: ${x.name}`)} />
              <span className="k-val">{`${+v.toFixed(2)} ${x.unit}`}</span>
            </label>
          );
        })}
    </section>
  );
}

const STYLE_FROM: [string, string][] = [["walk", "шаг"], ["run", "бег"], ["walk-back", "шаг назад"], ["strafe-walk", "шаг вбок"], ["idle", "стойка"]];

/** Стиль 100STYLE поверх клипа (clip.style): зомби, старик, руки в боки… — в такт шагам клипа. */
function StyleKnobs({ clip, readOnly, runMany }: { clip: Clip; readOnly?: boolean; runMany: Props["runMany"] }) {
  const layer = clip.layers.find((l) => l.id === "style") as { source?: { take?: string }; weight?: number } | undefined;
  const cur = layer?.source?.take?.match(/^(.+?)_([A-Za-z]+)_loop$/);
  const [style, setStyle] = useState(cur?.[2] ?? "Zombie");
  const [from, setFrom] = useState(cur?.[1] ?? "walk");
  const [amount, setAmount] = useState(1);
  const names = Object.entries(STYLE100).filter(([k]) => k !== "Neutral").sort((a, b) => a[1].localeCompare(b[1], "ru"));
  const apply = (st = style, fr = from, am = amount) => runMany([{ name: "clip.style", args: { clip: clip.name, style: st, from: fr, amount: am } }], `стиль: ${STYLE100[st]}`);
  return (
    <section className="knobs">
      <h3>
        Стиль <span className="muted">clip.style · 100STYLE, CC BY</span>
      </h3>
      <label className="param">
        <span className="pname">стиль</span>
        <select value={style} disabled={readOnly} onChange={(e) => { setStyle(e.target.value); if (layer) apply(e.target.value); }}>
          {names.map(([k, v]) => (
            <option key={k} value={k}>{v}</option>
          ))}
        </select>
      </label>
      <label className="param">
        <span className="pname">из записи</span>
        <select value={from} disabled={readOnly} onChange={(e) => { setFrom(e.target.value); if (layer) apply(style, e.target.value); }}>
          {STYLE_FROM.map(([k, v]) => (
            <option key={k} value={k}>{v}</option>
          ))}
        </select>
      </label>
      <label className="knob" title="доля разницы: 1 — как в записи">
        <span className="k-name">сила</span>
        <input type="range" min={0} max={2} step={0.05} value={amount} disabled={readOnly} onChange={(e) => setAmount(Number(e.target.value))} onPointerUp={() => layer && apply()} onKeyUp={() => layer && apply()} />
        <span className="k-val">{amount.toFixed(2)}</span>
      </label>
      <div className="gait-styles">
        <button className="chip" disabled={readOnly} onClick={() => apply()}>
          {layer ? "обновить" : "наложить"}
        </button>
        {layer && (
          <button className="chip" disabled={readOnly} onClick={() => runMany([{ name: "clip.style", args: { clip: clip.name, off: true } }], "стиль снят")}>
            снять
          </button>
        )}
      </div>
    </section>
  );
}

const HAND_LABEL: Record<string, string> = { fist: "кулак", relaxed: "расслабленно", open: "раскрыта", point: "указательный", grip: "хват", thumbs_up: "палец вверх" };

/** Поза кисти (hand.pose) на весь клип: кулак, хват, указательный… — слой «hands». */
function HandKnobs({ clip, readOnly, runMany }: { clip: Clip; readOnly?: boolean; runMany: Props["runMany"] }) {
  const [side, setSide] = useState<"both" | "l" | "r">("both");
  const has = clip.layers.some((l) => l.id === "hands");
  return (
    <section className="knobs">
      <h3>
        Кисти <span className="muted">hand.pose</span>
      </h3>
      <div className="seg">
        {([["both", "обе"], ["l", "левая"], ["r", "правая"]] as const).map(([k, t]) => (
          <button key={k} className={side === k ? "on" : ""} onClick={() => setSide(k)}>
            {t}
          </button>
        ))}
      </div>
      <div className="gait-styles">
        {Object.entries(HAND_POSES).map(([name, p]) => (
          <button key={name} className="chip" disabled={readOnly} title={p.help} onClick={() => runMany([{ name: "hand.pose", args: { clip: clip.name, side, pose: name } }], `кисти: ${p.help}`)}>
            {HAND_LABEL[name] ?? name}
          </button>
        ))}
        {has && (
          <button className="chip" disabled={readOnly} onClick={() => runMany([{ name: "layer.remove", args: { clip: clip.name, layer: "hands" } }], "кисти: как в клипе")}>
            сбросить
          </button>
        )}
      </div>
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
