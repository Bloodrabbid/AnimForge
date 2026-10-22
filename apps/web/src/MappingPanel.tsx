// Сопоставление скелетов бок о бок (готовый клип → своя модель): слева скелет пака, справа — модели, оба в покое
// спереди. Пары одного цвета; ручные — с обводкой. Клик по суставу слева, потом справа — связать; слева и «×» —
// не переносить; наведение — подсветить пару. «Применить» перезапускает примерку с ручными парами (clip.import map).
import { useEffect, useMemo, useState } from "react";

interface View {
  names: string[];
  parent: number[];
  chain: (string | null)[];
  pos: [number, number][];
}
interface Mapping {
  src: View;
  dst: View;
  pairs: { src: number; dst: number; manual: boolean }[];
}
export type BoneMap = Record<string, string | null>;

const PALETTE = ["#ffb547", "#5cc8ff", "#9be26a", "#ff7a90", "#c79bff", "#5fe0c6", "#ffd84a", "#ff9a5c"];

export function MappingPanel({ dir, pack, initial, onApply, onClose }: { dir: string; pack: string; initial: BoneMap; onApply(map: BoneMap): void; onClose(): void }) {
  const [map, setMap] = useState<BoneMap>(initial);
  const [m, setM] = useState<Mapping | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [pick, setPick] = useState<number | null>(null);
  const [hot, setHot] = useState<{ side: "src" | "dst"; i: number } | null>(null);
  useEffect(() => {
    fetch("api/mapping", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ dir, pack, map }) })
      .then((r) => r.json())
      .then((b) => (b.ok ? (setM(b), setErr(null)) : setErr(b.error)));
  }, [dir, pack, map]);
  // цвет пары — по цепочке кости модели (рука, нога, хвост…): так видно, что куда ушло целиком
  const colors = useMemo(() => {
    const out = new Map<number, string>();
    const chains = [...new Set(m?.dst.chain.filter(Boolean) as string[])];
    m?.pairs.forEach((p) => {
      const ch = m.dst.chain[p.dst];
      out.set(p.src, ch ? PALETTE[chains.indexOf(ch) % PALETTE.length] : "#d9dbe3");
    });
    return out;
  }, [m]);
  if (!m) return <div className="mapping-modal"><div className="mapping-box">{err ?? "загрузка…"}</div></div>;
  const pairOfSrc = new Map(m.pairs.map((p) => [p.src, p]));
  const pairsOfDst = new Map(m.pairs.map((p) => [p.dst, p]));
  const lit = (side: "src" | "dst", i: number) => {
    if (!hot) return false;
    if (hot.side === side) return hot.i === i;
    const p = side === "src" ? pairsOfDst.get(hot.i) : pairOfSrc.get(hot.i);
    return !!p && (side === "src" ? p.src === i : p.dst === i);
  };
  const skel = (side: "src" | "dst", v: View) => (
    <svg viewBox="0 0 100 100" className="mapping-skel">
      {v.parent.map((p, i) => (p >= 0 ? <line key={i} x1={v.pos[p][0] * 100} y1={v.pos[p][1] * 100} x2={v.pos[i][0] * 100} y2={v.pos[i][1] * 100} className="bone" /> : null))}
      {v.pos.map(([x, y], i) => {
        const pr = side === "src" ? pairOfSrc.get(i) : pairsOfDst.get(i);
        const c = pr ? colors.get(pr.src) : undefined;
        return (
          <circle
            key={i}
            cx={x * 100}
            cy={y * 100}
            r={lit(side, i) ? 2.6 : pick === i && side === "src" ? 2.4 : 1.5}
            fill={c ?? "#555863"}
            stroke={pr?.manual ? "#fff" : pick === i && side === "src" ? "#fff" : "none"}
            strokeWidth={0.6}
            onMouseEnter={() => setHot({ side, i })}
            onMouseLeave={() => setHot(null)}
            onClick={() => {
              if (side === "src") setPick(pick === i ? null : i);
              else if (pick != null) {
                setMap({ ...map, [m.src.names[pick]]: m.dst.names[i] });
                setPick(null);
              }
            }}
          >
            <title>{v.names[i]}{v.chain[i] ? ` · ${v.chain[i]}` : ""}</title>
          </circle>
        );
      })}
    </svg>
  );
  const hotName = hot ? (hot.side === "src" ? m.src.names[hot.i] : m.dst.names[hot.i]) : null;
  return (
    <div className="mapping-modal" onClick={onClose}>
      <div className="mapping-box" onClick={(e) => e.stopPropagation()}>
        <div className="mapping-head">
          <b>Сопоставление костей</b>
          <span className="muted">пар {m.pairs.length} · ручных {m.pairs.filter((p) => p.manual).length}</span>
          <span className="muted grow">{pick != null ? `«${m.src.names[pick]}» → кликните кость модели справа` : hotName ?? "клик по суставу слева, потом справа — связать"}</span>
          {pick != null && (
            <button className="ghost" onClick={() => (setMap({ ...map, [m.src.names[pick]]: null }), setPick(null))} title="эту кость источника не переносить">
              × не переносить
            </button>
          )}
          <button className="ghost" onClick={() => setMap({})} disabled={!Object.keys(map).length}>
            как само
          </button>
        </div>
        {err && <div className="mapping-err">{err}</div>}
        <div className="mapping-sides">
          <div>
            <div className="muted">источник (пак)</div>
            {skel("src", m.src)}
          </div>
          <div>
            <div className="muted">ваша модель</div>
            {skel("dst", m.dst)}
          </div>
        </div>
        <div className="mapping-foot">
          <button className="ghost" onClick={onClose}>Отмена</button>
          <button className="btn accent" onClick={() => onApply(map)}>Применить</button>
        </div>
      </div>
    </div>
  );
}
