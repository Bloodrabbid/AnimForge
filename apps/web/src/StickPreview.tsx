// Живое превью движения на наведении: скелет модели проекта в этом движении (сервер /api/stick считает кадры суставов
// на копии проекта), рисуется по кругу на холсте во всплывающем окошке справа от карточки.
import { useEffect, useRef, useState } from "react";

interface StickAnim {
  fps: number;
  edges: [number, number][];
  frames: [number, number][][];
}

const cache = new Map<string, Promise<StickAnim>>();
const load = (url: string) => {
  if (!cache.has(url)) cache.set(url, fetch(url).then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status))))));
  return cache.get(url)!;
};

export interface Hover {
  url: string;
  rect: DOMRect;
  title: string;
}

/** Обработчики наведения для карточки: через 250 мс — окошко с превью. */
export function useStickHover() {
  const [hover, setHover] = useState<Hover | null>(null);
  const timer = useRef<number>(0);
  const bind = (url: string, title: string) => ({
    onMouseEnter: (e: React.MouseEvent) => {
      const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
      clearTimeout(timer.current);
      timer.current = window.setTimeout(() => setHover({ url, rect, title }), 250);
    },
    onMouseLeave: () => {
      clearTimeout(timer.current);
      setHover(null);
    },
  });
  return { hover, bind };
}

export function StickPopover({ hover }: { hover: Hover | null }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const [state, setState] = useState<"load" | "ok" | "err">("load");
  useEffect(() => {
    if (!hover) return;
    let raf = 0, alive = true;
    setState("load");
    load(hover.url)
      .then((a) => {
        if (!alive) return;
        setState("ok");
        const t0 = performance.now();
        const draw = () => {
          const c = canvas.current;
          if (!c || !alive) return;
          const g = c.getContext("2d")!;
          const W = c.width, H = c.height;
          g.clearRect(0, 0, W, H);
          // пол — линия под самой нижней точкой всех кадров
          const k = Math.floor(((performance.now() - t0) / 1000) * a.fps) % a.frames.length;
          const fr = a.frames[k];
          g.lineCap = "round";
          g.strokeStyle = "#ffb547";
          g.lineWidth = 3;
          for (const [p, q] of a.edges) {
            g.beginPath();
            g.moveTo(fr[p][0] * W, fr[p][1] * H);
            g.lineTo(fr[q][0] * W, fr[q][1] * H);
            g.stroke();
          }
          g.fillStyle = "#fff3dc";
          for (const [x, y] of fr) {
            g.beginPath();
            g.arc(x * W, y * H, 2.2, 0, Math.PI * 2);
            g.fill();
          }
          raf = requestAnimationFrame(draw);
        };
        draw();
      })
      .catch(() => alive && setState("err"));
    return () => {
      alive = false;
      cancelAnimationFrame(raf);
    };
  }, [hover]);
  if (!hover) return null;
  const top = Math.min(hover.rect.top, window.innerHeight - 236);
  return (
    <div className="stick-pop" style={{ left: hover.rect.right + 8, top }}>
      <canvas ref={canvas} width={220} height={220} />
      <div className="stick-title">{state === "load" ? "считаю…" : state === "err" ? "превью не вышло" : hover.title}</div>
    </div>
  );
}
