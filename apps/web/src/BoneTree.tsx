// Кости модели: по цепочкам (как их видят рецепты) или иерархией. Показываем только кости skin.
// В иерархии отступ растёт только на развилках — у сколопендры 10 позвонков подряд не уезжают за край.
import { useMemo, useState } from "react";
import type { Skeleton } from "../../../packages/core/src/index.ts";
import { Icon } from "./Icon.tsx";

interface Props {
  skeleton: Skeleton;
  chains: Record<string, string[]>;
  selected: string | null;
  onSelect(bone: string | null): void;
}

export function BoneTree({ skeleton, chains, selected, onSelect }: Props) {
  const [mode, setMode] = useState<"chains" | "tree">("chains");
  const [q, setQ] = useState("");
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const joints = skeleton.nodes.filter((n) => n.isJoint);

  const { depth, chainOf } = useMemo(() => {
    const byName = new Map(skeleton.nodes.map((n) => [n.name, n]));
    const jointParent = (name: string) => {
      for (let p = byName.get(name)?.parent; p; p = byName.get(p)?.parent) if (byName.get(p)?.isJoint) return p;
      return undefined;
    };
    const kids = new Map<string, number>();
    for (const n of joints) {
      const p = jointParent(n.name);
      if (p) kids.set(p, (kids.get(p) ?? 0) + 1);
    }
    const depth = new Map<string, number>();
    for (const n of joints) {
      let d = 0;
      for (let c = n.name, p = jointParent(c); p; c = p, p = jointParent(p)) if ((kids.get(p) ?? 0) > 1) d++;
      depth.set(n.name, d);
    }
    const chainOf = new Map<string, string[]>();
    for (const [c, bones] of Object.entries(chains)) for (const b of bones) chainOf.set(b, [...(chainOf.get(b) ?? []), c]);
    return { depth, chainOf };
  }, [skeleton, chains]);

  const match = (s: string) => !q || s.toLowerCase().includes(q.toLowerCase());
  const chainList = Object.entries(chains);
  const free = joints.filter((n) => !chainOf.has(n.name));

  return (
    <div className="bones">
      <div className="seg">
        <button className={mode === "chains" ? "on" : ""} onClick={() => setMode("chains")}>
          Цепочки <span className="n">{chainList.length}</span>
        </button>
        <button className={mode === "tree" ? "on" : ""} onClick={() => setMode("tree")}>
          Иерархия <span className="n">{joints.length}</span>
        </button>
      </div>
      <div className="lib-search small">
        <Icon name="search" size={14} />
        <input placeholder="кость или цепочка" value={q} onChange={(e) => setQ(e.target.value)} />
      </div>
      {joints.length === 0 && <p className="muted">В модели нет костей skin.</p>}

      {mode === "chains" ? (
        <div className="chain-list">
          {chainList
            .filter(([c, bones]) => match(c) || bones.some(match))
            .map(([c, bones]) => {
              const has = selected != null && bones.includes(selected);
              const isOpen = open[c] ?? (has || !!q);
              return (
                <div key={c} className={`chain ${has ? "has" : ""}`}>
                  <button className="chain-head" onClick={() => setOpen({ ...open, [c]: !isOpen })}>
                    <span className={`chev ${isOpen ? "open" : ""}`}>
                      <Icon name="chev" size={12} />
                    </span>
                    <b>{c}</b>
                    <span className="n">{bones.length}</span>
                  </button>
                  {isOpen && (
                    <div className="pills">
                      {bones.map((b, i) => (
                        <button key={b} className={`pill ${b === selected ? "sel" : ""}`} onClick={() => onSelect(b === selected ? null : b)} title={b}>
                          <span className="i">{i}</span>
                          {b}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              );
            })}
          {free.length > 0 && !q && <p className="muted hint">Ещё {free.length} костей вне цепочек — во вкладке «Иерархия».</p>}
        </div>
      ) : (
        <ul className="tree">
          {joints
            .filter((n) => match(n.name))
            .map((n) => (
              <li
                key={n.name}
                className={n.name === selected ? "sel" : ""}
                style={{ paddingLeft: 6 + Math.min(depth.get(n.name) ?? 0, 8) * 10 }}
                onClick={() => onSelect(n.name === selected ? null : n.name)}
                title={`${n.name}${n.parent ? ` · родитель: ${n.parent}` : " · корень"}`}
              >
                <span className="bname">{n.name}</span>
                {(chainOf.get(n.name) ?? []).slice(0, 1).map((c) => (
                  <span key={c} className="tag">
                    {c}
                  </span>
                ))}
              </li>
            ))}
        </ul>
      )}
    </div>
  );
}
