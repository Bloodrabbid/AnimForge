// График амплитуд под вьюпортом: кривые движения конечностей за клип (motionGraph ядра) — вверх-вниз, вперёд-назад,
// вбок, сгиб колена/локтя, высота стопы над полом. У каждой конечности — свой цвет, галочка показа и размах за клип;
// полосы внизу — опора стоп. Клик и перетаскивание по графику — перемотка; наведение на кривую подсвечивает
// цепочку во вьюпорте. Считается с задержкой после правки и кешируется — перетаскивание ползунка не тормозит.
import { useEffect, useMemo, useRef, useState } from "react";
import { motionGraph, type Clip, type LimbCurve, type MotionGraph, type Project, type Rig } from "../../../packages/core/src/index.ts";

export type Quantity = "up" | "forward" | "side" | "bend" | "lift";
const QUANTITIES: { id: Quantity; title: string; hint: string }[] = [
  { id: "up", title: "Вверх-вниз", hint: "смещение конца цепочки по вертикали от среднего за клип, см" },
  { id: "forward", title: "Вперёд-назад", hint: "смещение вдоль взгляда персонажа от среднего за клип, см" },
  { id: "side", title: "Вбок", hint: "смещение вбок (влево +) от среднего за клип, см" },
  { id: "bend", title: "Сгиб", hint: "сгиб колена или локтя, °; у одиночной кости (таз, голова) — поворот от позы покоя" },
  { id: "lift", title: "Над полом", hint: "высота стопы над её высотой в позе покоя, см — только у стоп" },
];

// цвета по конечности: левые — холодные, правые — тёплые, туловище — по оси
const COLORS: Record<string, string> = {
  pelvis: "#ffb547",
  hips: "#ffb547",
  spine: "#d9a066",
  chest: "#c9a0ff",
  neck: "#b0b8c8",
  head: "#e6e4df",
  arm_l: "#6aa8ff",
  arm_r: "#ff8a8a",
  leg_l: "#7ee0a1",
  leg_r: "#ff9f43",
  tail: "#f06292",
};
const SPARE = ["#3fd0c9", "#b48cff", "#e7d36b", "#8fd3ff", "#ff7ac6", "#a3d977", "#d0a37a", "#9aa4ff"];
export function limbColor(chain: string, i = 0): string {
  return COLORS[chain] ?? COLORS[chain.replace(/_\d+$/, "")] ?? SPARE[i % SPARE.length];
}

/** Конечности, которые показываем сразу; глаза, уши и прочие мелочи — по галочке. */
const shownByDefault = (l: LimbCurve) => l.kind !== "other";

// ── расчёт: с задержкой после правки, по ключу всего, от чего зависит поза ─────────────────────────────────────
const cache = new Map<string, MotionGraph>();
const keyOf = (p: Project, clip: Clip) => JSON.stringify([clip, p.chains, p.up, p.forward, p.align, p.limits]);

export function useMotionGraph(project: Project | null, rig: Rig | null, clip: Clip | undefined, enabled: boolean, delay = 250): MotionGraph | null {
  const [graph, setGraph] = useState<MotionGraph | null>(null);
  const key = useMemo(() => (project && clip && enabled ? keyOf(project, clip) : ""), [project, clip, enabled]);
  useEffect(() => {
    if (!key || !project || !rig || !clip) return;
    const hit = cache.get(key);
    if (hit) return void setGraph(hit);
    // другой клип — сразу (старые кривые чужого клипа вводят в заблуждение), правка того же — после паузы
    const wait = graph && graph.clip === clip.name ? delay : 0;
    const id = setTimeout(() => {
      try {
        const g = motionGraph(project, rig, clip);
        if (cache.size > 32) cache.clear();
        cache.set(key, g);
        setGraph(g);
      } catch {
        /* кость пропала после перезагрузки модели — дождёмся следующего проекта */
      }
    }, wait);
    return () => clearTimeout(id);
  }, [key, rig]);
  return enabled ? graph : null;
}

// ── панель ──────────────────────────────────────────────────────────────────────────────────────────────────
interface Props {
  graph: MotionGraph | null;
  t: number;
  duration: number;
  hover: string | null;
  onHover(chain: string | null): void;
  onTime(t: number): void;
  /** какие конечности показаны (их же следы во вьюпорте) */
  shown: Record<string, boolean>;
  onShown(v: Record<string, boolean>): void;
}

export const isShown = (shown: Record<string, boolean>, l: LimbCurve) => shown[l.chain] ?? shownByDefault(l);

const ORDER: LimbCurve["kind"][] = ["pelvis", "foot", "hand", "body", "head", "tail", "other"];
const PAD_L = 40, PAD_R = 10, PAD_T = 10, PAD_B = 22;

function values(l: LimbCurve, q: Quantity): number[] | null {
  if (q === "bend") return l.bend;
  if (q === "lift") return l.lift ? l.lift.map((v) => v * 100) : null;
  return l[q].map((v) => v * 100);
}
const ampOf = (l: LimbCurve, q: Quantity) => (q === "lift" ? l.amp.lift : l.amp[q]);

export function GraphPanel({ graph, t, duration, hover, onHover, onTime, shown, onShown }: Props) {
  const [q, setQ] = useState<Quantity>(() => (new URLSearchParams(location.search).get("gq") as Quantity) || (localStorage.getItem("af.graph.q") as Quantity) || "forward");
  useEffect(() => localStorage.setItem("af.graph.q", q), [q]);
  const svg = useRef<SVGSVGElement>(null);
  // рисуем в пикселях самого элемента: текст и линии не растягиваются вместе с панелью
  const [{ W, H }, setSize] = useState({ W: 800, H: 180 });
  useEffect(() => {
    const el = svg.current!;
    const ro = new ResizeObserver(() => setSize({ W: Math.max(200, el.clientWidth), H: Math.max(80, el.clientHeight) }));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // в легенде — сначала главное: таз, ноги, руки, корпус, голова, хвост; мелочи (глаза, уши) — в конце
  const limbs = useMemo(() => [...(graph?.limbs ?? [])].sort((a, b) => ORDER.indexOf(a.kind) - ORDER.indexOf(b.kind)), [graph]);
  const col = (l: LimbCurve) => limbColor(l.chain, graph!.limbs.indexOf(l)); // как у следов во вьюпорте
  const visible = limbs.filter((l) => isShown(shown, l) && values(l, q));
  const unit = q === "bend" ? "°" : "см";

  // общий масштаб по видимым кривым, с запасом и «круглыми» делениями
  const { lo, hi, ticks } = useMemo(() => {
    let lo = Infinity, hi = -Infinity;
    for (const l of visible) for (const v of values(l, q)!) (lo = Math.min(lo, v)), (hi = Math.max(hi, v));
    if (!Number.isFinite(lo)) (lo = -1), (hi = 1);
    if (hi - lo < 1) {
      const m = (hi + lo) / 2;
      (lo = m - 0.5), (hi = m + 0.5);
    }
    const span = hi - lo;
    const step = [0.5, 1, 2, 5, 10, 20, 25, 50, 100, 200].find((s) => span / s <= 5) ?? 500;
    lo = Math.floor(lo / step) * step;
    hi = Math.ceil(hi / step) * step;
    const ticks: number[] = [];
    for (let v = lo; v <= hi + 1e-9; v += step) ticks.push(+v.toFixed(3));
    return { lo, hi, ticks };
  }, [graph, q, visible.map((l) => l.chain).join()]);

  const d = graph ? graph.times[graph.times.length - 1] || duration : duration;
  const X = (tt: number) => PAD_L + (tt / (d || 1)) * (W - PAD_L - PAD_R);
  const Y = (v: number) => PAD_T + (1 - (v - lo) / (hi - lo || 1)) * (H - PAD_T - PAD_B);
  const paths = useMemo(
    () => visible.map((l) => ({ l, d: values(l, q)!.map((v, k) => `${k ? "L" : "M"}${X(graph!.times[k]).toFixed(1)},${Y(v).toFixed(1)}`).join("") })),
    [graph, q, lo, hi, W, H, visible.map((l) => l.chain).join()],
  );
  const feet = visible.filter((l) => l.stance?.length);

  // координаты указателя в системе viewBox
  const local = (e: React.PointerEvent) => {
    const r = svg.current!.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };
  const seek = (e: React.PointerEvent) => {
    const { x } = local(e);
    onTime(Math.min(d, Math.max(0, ((x - PAD_L) / (W - PAD_L - PAD_R)) * d)));
  };
  // ближайшая к указателю кривая — по вертикали в этом моменте, не дальше 10 пикселей экрана
  const nearest = (e: React.PointerEvent) => {
    if (!graph) return null;
    const { x, y } = local(e);
    const tt = ((x - PAD_L) / (W - PAD_L - PAD_R)) * d;
    const k = Math.max(0, Math.min(graph.times.length - 1, Math.round((tt / (d || 1)) * (graph.times.length - 1))));
    let best: string | null = null, bd = 10;
    for (const l of visible) {
      const dy = Math.abs(Y(values(l, q)![k]) - y);
      if (dy < bd) (bd = dy), (best = l.chain);
    }
    return best;
  };

  const toggle = (l: LimbCurve) => onShown({ ...shown, [l.chain]: !isShown(shown, l) });

  return (
    <div className="graph-panel">
      <div className="graph-side">
        <div className="seg graph-q">
          {QUANTITIES.map((m) => (
            <button key={m.id} className={q === m.id ? "on" : ""} onClick={() => setQ(m.id)} title={m.hint}>
              {m.title}
            </button>
          ))}
        </div>
        <div className="graph-legend">
          {!graph && <p className="muted pad">считаю кривые…</p>}
          {limbs.map((l) => {
            const a = ampOf(l, q);
            const on = isShown(shown, l);
            return (
              <label
                key={l.chain}
                className={`gl-row ${hover === l.chain ? "hot" : ""} ${a == null ? "na" : ""}`}
                onMouseEnter={() => onHover(l.chain)}
                onMouseLeave={() => onHover(null)}
                title={`${l.chain}: конец — ${l.tip}${l.bendKind === "bend" ? `, сгиб в ${l.joint}` : ""}${l.stance?.length ? `, опора ${l.stance.length} раз` : ""}`}
              >
                <input type="checkbox" checked={on} onChange={() => toggle(l)} />
                <span className="sw" style={{ background: col(l) }} />
                <span className="gl-name">{l.chain}</span>
                <span className="gl-amp">{a == null ? "—" : `${a.toFixed(a < 10 ? 1 : 0)} ${unit}`}</span>
              </label>
            );
          })}
        </div>
      </div>
      <svg
        ref={svg}
        className="graph-plot"
        viewBox={`0 0 ${W} ${H}`}
        onPointerDown={(e) => {
          (e.target as Element).setPointerCapture?.(e.pointerId);
          seek(e);
        }}
        onPointerMove={(e) => {
          if (e.buttons & 1) seek(e);
          else {
            const n = nearest(e);
            if (n !== hover) onHover(n);
          }
        }}
        onPointerLeave={() => hover && onHover(null)}
      >
        {/* сетка и подписи значений */}
        {ticks.map((v) => (
          <g key={v}>
            <line x1={PAD_L} x2={W - PAD_R} y1={Y(v)} y2={Y(v)} className={v === 0 ? "gz" : "gg"} />
            <text x={PAD_L - 6} y={Y(v) + 3.5} className="gt" textAnchor="end">
              {v}
            </text>
          </g>
        ))}
        <text x={4} y={PAD_T + 9} className="gt unit">
          {unit}
        </text>
        {/* опора стоп — полосы внизу, по стопе на строку */}
        {feet.map((l, j) =>
          l.stance!.map(([a, b], k) => (
            <rect key={`${l.chain}${k}`} x={X(a)} width={Math.max(1, X(b) - X(a))} y={H - PAD_B + 4 + j * 5} height={4} rx={1} fill={col(l)} opacity={0.75}>
              <title>{`${l.chain}: опора ${a.toFixed(2)}–${b.toFixed(2)} с`}</title>
            </rect>
          )),
        )}
        {paths.map(({ l, d: p }) => (
          <path
            key={l.chain}
            d={p}
            fill="none"
            stroke={col(l)}
            strokeWidth={hover === l.chain ? 3 : hover ? 1.2 : 1.8}
            opacity={hover && hover !== l.chain ? 0.35 : 1}
           
          />
        ))}
        <line x1={X(Math.min(t, d))} x2={X(Math.min(t, d))} y1={0} y2={H} className="gnow" />
      </svg>
    </div>
  );
}
