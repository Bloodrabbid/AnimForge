// Цели: IK (кисть или стопа тянется к точке) и взгляд (голова смотрит на точку). Цель — шарик во вьюпорте,
// его тащат мышью; в клипе с ключами цели перетаскивание ставит ключ в текущее время.
// Всё — команды ядра ik.add / aim.add / constraint.key / constraint.set / constraint.remove.
import { useMemo } from "react";
import { bodyFrame, posePartsAt, targetAt, worldPose, type Clip, type Constraint, type Project, type Rig, type Skeleton } from "../../../packages/core/src/index.ts";
import type { Step } from "./api.ts";
import { Icon } from "./Icon.tsx";

interface Props {
  project: Project;
  skeleton: Skeleton;
  rig: Rig;
  clip: Clip;
  t: number;
  active: string | null;
  readOnly?: boolean;
  onActive(id: string | null): void;
  runMany(steps: Step[], label?: string): Promise<unknown>;
}

type V3 = [number, number, number];
const fmt = (v: number[]) => v.map((x) => x.toFixed(2)).join(", ");
const LIMBS: [string, string][] = [
  ["arm_l", "рука л"],
  ["arm_r", "рука п"],
  ["leg_l", "нога л"],
  ["leg_r", "нога п"],
];

/** Кончик IK для цепочки — как в ik.add: последняя кость у длинной цепочки, иначе её дочерняя. */
function tipOf(project: Project, skeleton: Skeleton, chain: string) {
  const c = project.chains[chain];
  if (!c?.length) return undefined;
  const last = c[c.length - 1];
  // рука-варежка без кисти — тянется конец последней кости
  return c.length >= 3 ? last : (skeleton.nodes.find((n) => n.parent === last && n.isJoint)?.name ?? last);
}

export function ConstraintsPanel({ project, skeleton, rig, clip, t, active, readOnly, onActive, runMany }: Props) {
  const list = clip.constraints ?? [];
  const pose = useMemo(() => worldPose(rig, posePartsAt(project, rig, clip, t)), [project, rig, clip, t]);
  const at = (b: string) => pose.T[rig.index.get(b)!] as V3;
  const size = useMemo(() => {
    const ys = rig.worldT.map((p) => p[0] ** 2 + p[1] ** 2 + p[2] ** 2);
    return Math.sqrt(Math.max(...ys)) || 1;
  }, [rig]);
  const f = bodyFrame(project);
  const step = (v: V3, dir: number[], k: number): V3 => [v[0] + dir[0] * k, v[1] + dir[1] * k, v[2] + dir[2] * k];
  const id = (base: string) => {
    let n = base;
    for (let i = 2; list.some((c) => c.id === n); i++) n = `${base}_${i}`;
    return n;
  };

  const addIK = (chain: string) => {
    const tip = tipOf(project, skeleton, chain)!;
    // цель — там, где кисть сейчас, чуть вперёд: включение не дёргает позу, видно, что тянуть
    const c = project.chains[chain];
    const end = tip === c[c.length - 1] && c.length < 3;
    // у варежки кончик — продолжение последней кости на длину предыдущей
    const base = end && c.length > 1 ? step(at(tip), [0, 1, 2].map((k) => at(tip)[k] - at(c[c.length - 2])[k]), 1) : at(tip);
    const p = step(base, f.forward, size * 0.08);
    const cid = id(`ik_${chain}`);
    onActive(cid);
    return runMany([{ name: "ik.add", args: { clip: clip.name, chain, target: fmt(p), id: cid } }], "IK-цель");
  };
  const addAim = () => {
    const head = project.chains.head?.[0] ?? project.chains.neck?.at(-1);
    const p = head ? step(at(head), f.forward, size * 0.6) : step([0, 0, 0], f.forward, size);
    const cid = id("aim");
    onActive(cid);
    return runMany([{ name: "aim.add", args: { clip: clip.name, target: fmt(p), id: cid } }], "взгляд");
  };
  const set = (c: Constraint, args: Record<string, unknown>, label = "цель") => runMany([{ name: "constraint.set", args: { clip: clip.name, id: c.id, ...args } }], label);
  const hasHead = !!(project.chains.head || project.chains.neck);

  return (
    <div className="targets panel">
      <div className="lim-tools">
        {LIMBS.filter(([c]) => tipOf(project, skeleton, c)).map(([c, label]) => (
          <button key={c} disabled={readOnly} onClick={() => addIK(c)} title={`кончик цепочки ${c} тянется к цели; сгибаются две кости над ним`}>
            <Icon name="plus" size={12} /> IK: {label}
          </button>
        ))}
        {hasHead && (
          <button disabled={readOnly} onClick={addAim} title="голова и шея смотрят на цель">
            <Icon name="plus" size={12} /> Взгляд
          </button>
        )}
      </div>
      {!list.length ? (
        <p className="muted">
          IK — кисть или стопа тянется к точке: взять предмет, опереться о стену, поставить ногу на ступеньку. Взгляд — голова провожает цель.
          Пределы суставов из соседней вкладки действуют и тут.
        </p>
      ) : (
        <p className="muted small">Цель — цветной шарик на модели: выберите строку и тащите стрелки. Если у цели есть ключи, перетаскивание ставит ключ в текущем кадре.</p>
      )}
      {list.map((c) => {
        const p = targetAt(rig, posePartsAt(project, rig, clip, t), clip, c.target, t);
        const keyed = !!c.target.keys?.length;
        return (
          <div key={c.id} className={`target ${c.id === active ? "sel" : ""} ${c.muted ? "muted-row" : ""}`} onClick={() => onActive(c.id === active ? null : c.id)}>
            <div className="target-head">
              <span className={`dot ${c.type}`} />
              <b>{c.id}</b>
              <span className="muted">{c.type === "ik" ? `IK · ${c.tip}` : `взгляд · ${c.bones.join(" → ")}`}</span>
              <span className="spacer" />
              <button className="icon" disabled={readOnly} title={c.muted ? "включить" : "выключить"} onClick={(e) => (e.stopPropagation(), set(c, { muted: !c.muted }, c.muted ? "включён" : "выключен"))}>
                <Icon name={c.muted ? "eye-off" : "eye"} size={14} />
              </button>
              <button className="icon" disabled={readOnly} title="убрать" onClick={(e) => (e.stopPropagation(), runMany([{ name: "constraint.remove", args: { clip: clip.name, id: c.id } }], "убран"))}>
                <Icon name="trash" size={14} />
              </button>
            </div>
            <div className="target-row muted small">
              {c.target.bone ? `цель — кость ${c.target.bone}` : p ? `цель ${fmt(p)}` : "—"}
              {keyed && ` · ключей ${c.target.keys!.length}`}
            </div>
            <div className="target-row" onClick={(e) => e.stopPropagation()}>
              <label className="muted small">сила</label>
              <input
                type="range"
                min={0}
                max={1}
                step={0.05}
                disabled={readOnly}
                defaultValue={c.weight ?? 1}
                key={`${c.id}-${c.weight ?? 1}`}
                onPointerUp={(e) => set(c, { weight: Number((e.target as HTMLInputElement).value) }, "сила")}
                onKeyUp={(e) => set(c, { weight: Number((e.target as HTMLInputElement).value) }, "сила")}
              />
              <span className="num-label">{Math.round((c.weight ?? 1) * 100)}%</span>
            </div>
            <div className="target-row" onClick={(e) => e.stopPropagation()}>
              {p && !c.target.bone && (
                <button className="small" disabled={readOnly} title="ключ цели в текущем кадре: дальше цель может двигаться по ключам" onClick={() => runMany([{ name: "constraint.key", args: { clip: clip.name, id: c.id, t: +t.toFixed(3), target: fmt(p) } }], `ключ цели в ${t.toFixed(2)} с`)}>
                  <Icon name="key" size={12} /> ключ в {t.toFixed(2)} с
                </button>
              )}
              {c.type === "ik" && (
                <select
                  disabled={readOnly}
                  value={c.pole ? "set" : "auto"}
                  title="куда смотрит локоть или колено"
                  onChange={(e) => {
                    const v = e.target.value;
                    if (v === "auto") return set(c, { pole: "none" }, "сгиб");
                    const mid = skeleton.nodes.find((n) => n.name === c.tip)?.parent;
                    if (!mid) return;
                    const dir = { fwd: f.forward, back: f.forward.map((x) => -x), up: f.up, down: f.up.map((x) => -x) }[v as "fwd"]!;
                    return set(c, { pole: fmt(step(at(mid), dir, size * 0.5)) }, "сгиб");
                  }}
                >
                  <option value="auto">сгиб: как в анимации</option>
                  <option value="fwd">сгиб вперёд</option>
                  <option value="back">сгиб назад</option>
                  <option value="up">сгиб вверх</option>
                  <option value="down">сгиб вниз</option>
                  {c.pole && <option value="set">сгиб: задан</option>}
                </select>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}
