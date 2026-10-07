// Дерево костей из скелета модели. Показываем только кости skin; вложенность — по ближайшему предку-кости.
import type { Skeleton } from "../../../packages/core/src/index.ts";

interface Props {
  skeleton: Skeleton;
  chains: Record<string, string[]>;
  selected: string | null;
  onSelect(bone: string | null): void;
}

export function BoneTree({ skeleton, chains, selected, onSelect }: Props) {
  const byName = new Map(skeleton.nodes.map((n) => [n.name, n]));
  const depth = (name: string): number => {
    let d = 0;
    for (let p = byName.get(name)?.parent; p; p = byName.get(p)?.parent) if (byName.get(p)?.isJoint) d++;
    return d;
  };
  const chainOf = (bone: string) => Object.entries(chains).filter(([, bones]) => bones.includes(bone)).map(([c]) => c);
  const joints = skeleton.nodes.filter((n) => n.isJoint);

  return (
    <section className="panel">
      <h2>Кости</h2>
      {joints.length === 0 && <p className="muted">В модели нет костей skin.</p>}
      <ul className="tree">
        {joints.map((n) => (
          <li
            key={n.name}
            className={n.name === selected ? "sel" : ""}
            style={{ paddingLeft: 8 + depth(n.name) * 12 }}
            onClick={() => onSelect(n.name === selected ? null : n.name)}
            title={n.parent ? `родитель: ${n.parent}` : "корень"}
          >
            {n.name}
            {chainOf(n.name).map((c) => (
              <span key={c} className="tag">
                {c}
              </span>
            ))}
          </li>
        ))}
      </ul>
    </section>
  );
}
