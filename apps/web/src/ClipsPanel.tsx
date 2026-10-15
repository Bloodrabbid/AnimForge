// Готовые клипы (library/clips, CC0): клик — примерка дубля на своей модели (clip.import на копии проекта),
// «Применить» записывает клип со слоем основы «base». Поверх него библиотека добавляет рецепты (галочка «поверх»).
import { useEffect, useMemo, useState } from "react";
import { fetchClips, type ClipPackInfo } from "./api.ts";

interface Props {
  active: string | null;
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

export function ClipsPanel({ active, onTry }: Props) {
  const [packs, setPacks] = useState<ClipPackInfo[]>([]);
  const [q, setQ] = useState("");
  const [kind, setKind] = useState<string | null>(null);
  useEffect(() => void fetchClips().then(setPacks).catch(() => setPacks([])), []);
  const all = useMemo(() => packs.flatMap((p) => p.takes.filter((t) => !/tpose/i.test(t.name)).map((t) => ({ p, t, kind: kindOf(t.name) }))), [packs]);
  const words = q.toLowerCase().split(/\s+/).filter(Boolean);
  const shown = all.filter((x) => (!kind || x.kind === kind) && words.every((w) => `${x.t.name} ${x.p.name}`.toLowerCase().includes(w)));
  return (
    <div className="library clips-lib">
      <div className="lib-search">
        <input placeholder="Поиск: walk, sword, zombie…" value={q} onChange={(e) => setQ(e.target.value)} />
        <span className="count">{shown.length}</span>
      </div>
      <div className="chips">
        <button className={`chip ${kind == null ? "on" : ""}`} onClick={() => setKind(null)}>Все</button>
        {KINDS.map((k) => (
          <button key={k.id} className={`chip ${kind === k.id ? "on" : ""}`} onClick={() => setKind(kind === k.id ? null : k.id)}>
            {k.title} <span className="n">{all.filter((x) => x.kind === k.id).length}</span>
          </button>
        ))}
      </div>
      <p className="muted clips-note">Свободные клипы (CC0) — основой клипа на вашей модели; поверх — рецепты из библиотеки.</p>
      <div className="cards">
        {shown.map(({ p, t }) => (
          <button key={p.id + t.name} className={`card clip-card ${active === t.name ? "active" : ""}`} onClick={() => onTry(p, t.name)} title={`${p.name} · ${p.license} · скелет: ${p.skeleton}`}>
            <div className="card-body">
              <div className="card-title">{t.name.replace(/_/g, " ")}</div>
              <div className="card-help">
                {t.duration.toFixed(2)} с{/loop/i.test(t.name) ? " · цикл" : ""}{/_RM$/.test(t.name) ? " · с ходом" : ""}
              </div>
              <div className="card-tags">
                <span className="src">{p.author}</span>
                <span className="rec">{p.license}</span>
              </div>
            </div>
          </button>
        ))}
        {shown.length === 0 && <p className="muted empty">{packs.length ? "Ничего не нашлось." : "Загрузка…"}</p>}
      </div>
    </div>
  );
}
