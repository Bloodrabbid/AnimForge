// Библиотека пресетов: поиск, разделы по типу существа, карточки с кривой движения и происхождением.
// Клик по карточке — примерка на свою модель (без записи на диск), «Применить» — команды ядра.
import { useMemo, useState } from "react";
import { StickPopover, useStickHover } from "./StickPreview.tsx";
import { BODY_FIRST, CATEGORIES, RECIPES, missingChains, withDefaults } from "../../../packages/core/src/index.ts";
export { CATEGORIES, chainsFor } from "../../../packages/core/src/index.ts";
import type { LibPreset, LibRecipe } from "./api.ts";

const SOURCES: Record<string, string> = {
  "research/witcher": "Witcher 3",
  "research/dredge": "DREDGE",
  "research/tlj": "Longest Journey",
  "research/toolsup": "Tools Up!",
  "research/biped": "Biped",
  "research/haven": "Haven",
  "research/ghostmaster": "Ghost Master",
  "research/breathedge": "Breathedge",
  "hand-tuned": "вручную",
};
export const sourceOf = (p: LibPreset) => [...new Set((p.provenance ?? []).map((s) => SOURCES[s.source] ?? s.source))];

export interface Entry {
  lib: LibRecipe;
  preset: LibPreset;
  category: string;
  missing: string[];
}

interface Props {
  library: LibRecipe[];
  chains: Record<string, string[]>;
  body?: string;
  active: string | null;
  onTry(e: Entry): void;
  /** проект — для живого превью на его скелете */
  dir?: string;
}

export function LibraryPanel({ library, chains, body, active, onTry, dir }: Props) {
  const { hover, bind } = useStickHover();
  const [q, setQ] = useState("");
  const [cat, setCat] = useState<string | null>(null);
  const [fitOnly, setFitOnly] = useState(true);

  const entries = useMemo(() => {
    const out: Entry[] = [];
    for (const lib of library) {
      const category = CATEGORIES.find((c) => c.recipes.includes(lib.recipe))?.id ?? "small";
      const missing = missingChains(lib.roles, chains);
      for (const preset of lib.presets) out.push({ lib, preset, category, missing });
    }
    return out;
  }, [library, chains]);

  const words = q.toLowerCase().split(/\s+/).filter(Boolean);
  const shown = entries
    .filter((e) => !cat || e.category === cat)
    .filter((e) => !fitOnly || e.missing.length === 0)
    .filter((e) => {
      const hay = `${e.preset.name} ${e.preset.help} ${e.lib.recipe} ${sourceOf(e.preset).join(" ")}`.toLowerCase();
      return words.every((w) => hay.includes(w));
    });
  // сначала рецепты с ролями, которым скелета хватает: это движения именно для такого тела
  const first = BODY_FIRST[body ?? ""] ?? [];
  const rank = (e: Entry) => {
    if (e.missing.length) return 100;
    const i = first.indexOf(e.category);
    return i >= 0 ? i : first.length + (e.lib.roles ? 0 : 1);
  };
  shown.sort((a, b) => rank(a) - rank(b));
  const fitCount = entries.filter((e) => e.missing.length === 0).length;

  return (
    <div className="library">
      <div className="lib-search">
        <input placeholder="Поиск: акула, рысь, Witcher, удар…" value={q} onChange={(e) => setQ(e.target.value)} />
        <span className="count">{shown.length}</span>
      </div>
      <div className="chips">
        <button className={`chip ${cat == null ? "on" : ""}`} onClick={() => setCat(null)}>
          Все
        </button>
        {CATEGORIES.map((c) => {
          const n = entries.filter((e) => e.category === c.id && (!fitOnly || e.missing.length === 0)).length;
          return (
            <button key={c.id} className={`chip ${cat === c.id ? "on" : ""}`} onClick={() => setCat(cat === c.id ? null : c.id)} disabled={n === 0}>
              {c.title} <span className="n">{n}</span>
            </button>
          );
        })}
      </div>
      <label className="fit-only" title="рецепты, которым хватает цепочек этого скелета">
        <input type="checkbox" checked={fitOnly} onChange={(e) => setFitOnly(e.target.checked)} /> только подходящие этому скелету ({fitCount} из{" "}
        {entries.length})
      </label>
      <div className="cards">
        {shown.map((e) => (
          <Card key={e.preset.name} e={e} active={active === e.preset.name} onClick={() => onTry(e)} hover={dir && !e.missing.length ? bind(`/api/stick?${new URLSearchParams({ dir, preset: e.preset.name })}`, `${e.preset.name} на вашей модели`) : undefined} />
        ))}
        {shown.length === 0 && <p className="muted empty">Ничего не нашлось.</p>}
      </div>
      <StickPopover hover={hover} />
    </div>
  );
}

function Card({ e, active, onClick, hover }: { e: Entry; active: boolean; onClick(): void; hover?: ReturnType<ReturnType<typeof useStickHover>["bind"]> }) {
  const src = sourceOf(e.preset);
  return (
    <button className={`card ${active ? "active" : ""} ${e.missing.length ? "unfit" : ""}`} onClick={onClick} title={e.preset.help} {...hover}>
      <MiniCurve lib={e.lib} preset={e.preset} />
      <div className="card-body">
        <div className="card-title">{e.preset.name}</div>
        <div className="card-help">{e.preset.help}</div>
        <div className="card-tags">
          {src.map((s) => (
            <span key={s} className={`src ${s === "вручную" ? "hand" : ""}`}>
              {s}
            </span>
          ))}
          <span className="rec">{e.lib.recipe}</span>
        </div>
        {e.missing.length > 0 && <div className="card-missing">нет цепочек: {e.missing.join(", ")}</div>}
      </div>
    </button>
  );
}

const COLORS = ["#ffb547", "#6aa8ff", "#7ee0a1"];

/** Кривые главной кости рецепта за цикл — считает само ядро (evaluate), как и при запекании. */
function MiniCurve({ lib, preset }: { lib: LibRecipe; preset: LibPreset }) {
  const lines = useMemo(() => {
    const def = RECIPES[lib.recipe];
    if (!def) return [];
    const role = lib.roles ? Object.keys(lib.roles).find((r) => /leg|wing|arm|fl|l0|tentacle/.test(r)) ?? Object.keys(lib.roles)[0] : undefined;
    const params = withDefaults(def, { ...preset.params, ...(role && def.params.role ? { role } : {}) });
    const T = Number(params.period) > 0 ? Number(params.period) : Number(params.duration) > 0 ? Number(params.duration) : 1.6;
    const N = 48;
    // кончик цепочки, потом основание — у появления двигается только корень
    const sample = (bone: number) => {
      const series = new Map<string, number[]>();
      for (let i = 0; i <= N; i++) {
        let ch: Record<string, number | undefined> = {};
        try {
          ch = def.evaluate(params, bone, 3, (i / N) * T, { height: 1, size: 1 }) as Record<string, number | undefined>;
        } catch {
          /* рецепт без оценки в отрыве от скелета — кривой не будет */
        }
        for (const [k, v] of Object.entries(ch)) {
          if (typeof v !== "number" || !Number.isFinite(v)) continue;
          if (!series.has(k)) series.set(k, Array(N + 1).fill(0));
          series.get(k)![i] = v;
        }
      }
      return [...series.entries()]
        .map(([k, v]) => ({ k, v, r: Math.max(...v) - Math.min(...v) }))
        .filter((s) => s.r > 1e-6)
        .sort((a, b) => b.r - a.r)
        .slice(0, 3);
    };
    let ranked = sample(lib.roles ? 0 : 2);
    if (!ranked.length) ranked = sample(0);
    return ranked.map(({ k, v }) => {
      const lo = Math.min(...v), hi = Math.max(...v);
      const d = v.map((y, i) => `${i ? "L" : "M"}${((i / N) * 100).toFixed(1)},${(36 - ((y - lo) / (hi - lo || 1)) * 28).toFixed(1)}`).join("");
      return { k, d };
    });
  }, [lib, preset]);
  return (
    <svg className="mini" viewBox="0 0 100 40" preserveAspectRatio="none">
      <line x1="0" x2="100" y1="20" y2="20" className="mid" />
      {lines.map((l, i) => (
        <path key={l.k} d={l.d} stroke={COLORS[i]} vectorEffect="non-scaling-stroke">
          <title>{l.k}</title>
        </path>
      ))}
    </svg>
  );
}
