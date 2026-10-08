// Выпадающее меню: кнопка и список пунктов, закрывается кликом мимо или Esc.
import { useEffect, useRef, useState, type ReactNode } from "react";

export function Menu({ label, title, children, align = "left", className = "" }: { label: ReactNode; title?: string; children: (close: () => void) => ReactNode; align?: "left" | "right"; className?: string }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const away = (e: PointerEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    const esc = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    window.addEventListener("pointerdown", away);
    window.addEventListener("keydown", esc);
    return () => {
      window.removeEventListener("pointerdown", away);
      window.removeEventListener("keydown", esc);
    };
  }, [open]);
  return (
    <div className={`menu ${className}`} ref={ref}>
      <button className={`menu-btn ${open ? "on" : ""}`} title={title} onClick={() => setOpen((v) => !v)}>
        {label}
      </button>
      {open && <div className={`menu-list ${align}`}>{children(() => setOpen(false))}</div>}
    </div>
  );
}
