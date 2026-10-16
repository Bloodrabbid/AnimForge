// Готовые клипы (library/clips, CC0): клик — примерка дубля на своей модели (clip.import на копии проекта),
// «Применить» записывает клип со слоем основы «base». Поверх него библиотека добавляет рецепты (галочка «поверх»).
import { useEffect, useMemo, useState } from "react";
import { fetchClips, type ClipPackInfo } from "./api.ts";
import { StickPopover, useStickHover } from "./StickPreview.tsx";
import { norm, ruName, searchText, wordHit } from "./clipNames.ts";

interface Props {
  active: string | null;
  /** тип тела модели (rig.detect): по умолчанию показываются паки того же тела */
  body?: string;
  /** проект — для живого превью на его скелете */
  dir?: string;
  onTry(pack: ClipPackInfo, take: string): void;
}

/** Разделы по словам в имени дубля. */
const KINDS: { id: string; title: string; re: RegExp }[] = [
  { id: "move", title: "Ходьба и бег", re: /walk|jog|run|sprint|crouch_fwd|swim|slide|climb|strafe/i },
  { id: "idle", title: "Стойки", re: /idle|sit|lay|fold|talk/i },
  { id: "fight", title: "Бой", re: /sword|punch|melee|shield|pistol|spell|hit|death|knock|throw|block|zombie_scratch/i },
  { id: "act", title: "Действия", re: /.*/ },
];
const kindOf = (n: string) => KINDS.find((k) => k.re.test(n))!.id;


const BODY: Record<string, string> = { biped: "Люди", quadruped: "Четвероногие", other: "Прочие" };
const bodyOf = (p: ClipPackInfo) => p.body ?? "biped";
/** CC BY-NC: только некоммерческое — в игру на продажу нельзя */
export const nonCommercial = (p: ClipPackInfo) => /\bNC\b/i.test(p.license);
/** имя дубля без префиксов скелета («DogArmature|Idle» → «Idle») */
export const takeLabel = (n: string) => n.replace(/^.*\|/, "").replace(/_/g, " ");

export function ClipsPanel({ active, body, onTry, dir }: Props) {
  const { hover, bind } = useStickHover();
  const [fitOnly, setFitOnly] = useState(true);
  const [sellable, setSellable] = useState(() => localStorage.getItem("af.sellable") === "1");
  useEffect(() => localStorage.setItem("af.sellable", sellable ? "1" : "0"), [sellable]);
  const [packs, setPacks] = useState<ClipPackInfo[]>([]);
  const [q, setQ] = useState("");
  const [kind, setKind] = useState<string | null>(null);
  useEffect(() => void fetchClips().then(setPacks).catch(() => setPacks([])), []);
  const all = useMemo(() => packs.flatMap((p) => p.takes.filter((t) => !/tpose/i.test(t.name)).map((t) => ({ p, t, kind: kindOf(t.name), ru: ruName(t.name), text: norm(searchText(t.name, p.name)) }))), [packs]);
  const words = norm(q).split(/\s+/).filter(Boolean);
  // своё тело: двуногому — люди, четвероногому — звери; крылатым, рыбам и прочим — всё, что не люди
  const fits = (p: ClipPackInfo) => !body || (body === "biped" ? bodyOf(p) === "biped" : body === "quadruped" ? bodyOf(p) === "quadruped" : bodyOf(p) !== "biped");
  const pool = all.filter((x) => (!fitOnly || fits(x.p)) && (!sellable || !nonCommercial(x.p)));
  const shown = pool.filter((x) => (!kind || (KINDS.some((k) => k.id === kind) ? x.kind === kind : bodyOf(x.p) === kind)) && words.every((w) => wordHit(x.text, w)));
  const bodies = [...new Set(pool.map((x) => bodyOf(x.p)))];
  return (
    <div className="library clips-lib">
      <div className="lib-search">
        <input placeholder="Поиск: зомби, поклон, бег назад, sword…" value={q} onChange={(e) => setQ(e.target.value)} />
        <span className="count">{shown.length}</span>
      </div>
      <div className="chips">
        <button className={`chip ${kind == null ? "on" : ""}`} onClick={() => setKind(null)}>Все</button>
        {bodies.length > 1 &&
          bodies.map((b) => (
            <button key={b} className={`chip ${kind === b ? "on" : ""}`} onClick={() => setKind(kind === b ? null : b)}>
              {BODY[b] ?? b} <span className="n">{pool.filter((x) => bodyOf(x.p) === b).length}</span>
            </button>
          ))}
        {KINDS.map((k) => (
          <button key={k.id} className={`chip ${kind === k.id ? "on" : ""}`} onClick={() => setKind(kind === k.id ? null : k.id)}>
            {k.title} <span className="n">{pool.filter((x) => x.kind === k.id).length}</span>
          </button>
        ))}
      </div>
      <label className="fit-only">
        <input type="checkbox" checked={fitOnly} onChange={(e) => setFitOnly(e.target.checked)} /> только для такого тела ({pool.length} из {all.length})
      </label>
      <label className="fit-only" title="скрыть наборы CC BY-NC (Bandai Namco): их нельзя в игру, которую продают">
        <input type="checkbox" checked={sellable} onChange={(e) => setSellable(e.target.checked)} /> только для коммерческой игры
      </label>
      <p className="muted clips-note">Свободные клипы (CC0, мокап CMU, CC BY — с авторами в титрах) — основой клипа на вашей модели; поверх — рецепты из библиотеки. Метка «некоммерч.» — только для игр не на продажу.</p>
      <div className="cards">
        {shown.map(({ p, t, ru }) => (
          <button key={p.id + t.name} className={`card clip-card ${active === takeLabel(t.name) ? "active" : ""}`} onClick={() => onTry(p, t.name)} title={`${p.name} · ${p.author} · ${p.terms ?? p.license} · скелет: ${p.skeleton}`} {...(dir ? bind(`/api/stick?${new URLSearchParams({ dir, pack: p.id, take: t.name })}`, `${takeLabel(t.name)} на вашей модели`) : {})}>
            <div className="card-body">
              <div className="card-title">{ru}</div>
              <div className="card-help">
                <span className="orig">{takeLabel(t.name)}</span> · {t.duration.toFixed(2)} с{/loop/i.test(t.name) ? " · цикл" : ""}{/_RM$/.test(t.name) ? " · с ходом" : ""}
              </div>
              <div className="card-tags">
                <span className="src">{p.name.replace(/^[^·]*·\s*/, "")}</span>
                {nonCommercial(p) ? (
                  <span className="rec nc" title={p.terms}>некоммерч.</span>
                ) : (
                  <span className="rec" title={p.terms}>{p.license}</span>
                )}
              </div>
            </div>
          </button>
        ))}
        {shown.length === 0 && <p className="muted empty">{packs.length ? "Ничего не нашлось." : "Загрузка…"}</p>}
      </div>
      <StickPopover hover={hover} />
    </div>
  );
}
