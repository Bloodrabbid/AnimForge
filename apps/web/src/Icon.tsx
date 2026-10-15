// Иконки интерфейса — свои SVG в одну линию, без библиотек.
const PATHS: Record<string, string> = {
  play: "M7 4.5v15l12-7.5z",
  pause: "M7 5h3.5v14H7zM13.5 5H17v14h-3.5z",
  first: "M6 5v14M18 5 9 12l9 7z",
  last: "M18 5v14M6 5l9 7-9 7z",
  prev: "M15 6l-6 6 6 6",
  next: "M9 6l6 6-6 6",
  loop: "M4 12a6 6 0 0 1 6-6h8m-3-3 3 3-3 3M20 12a6 6 0 0 1-6 6H6m3 3-3-3 3-3",
  bones: "M6.5 4.5a2 2 0 1 0-2 2l13 13a2 2 0 1 0 2-2zM8 8l8 8",
  mesh: "M12 3 4 7.5v9L12 21l8-4.5v-9zM4 7.5 12 12l8-4.5M12 12v9",
  wire: "M12 3 4 7.5v9L12 21l8-4.5v-9zM4 7.5 12 12l8-4.5M12 12v9M4 16.5l8-4.5 8 4.5M12 3v9",
  fit: "M4 9V4h5M15 4h5v5M20 15v5h-5M9 20H4v-5",
  front: "M8 4h8v16H8zM8 9h8",
  side: "M5 8h14v8H5zM15 8v8",
  top: "M5 5h14v14H5zM12 5v14M5 12h14",
  upload: "M12 16V5m-5 5 5-5 5 5M5 20h14",
  download: "M12 4v11m-5-5 5 5 5-5M5 20h14",
  search: "M10.5 17a6.5 6.5 0 1 0 0-13 6.5 6.5 0 0 0 0 13zM20 20l-4.8-4.8",
  library: "M4 5h4v14H4zM10 5h4v14h-4zM16.5 5.5l3.5-1 3 13.5-3.5 1z",
  tree: "M6 4v16M6 8h6M6 14h6M12 6h6v4h-6zM12 12h6v4h-6z",
  trash: "M5 7h14M10 7V5h4v2M7 7l1 13h8l1-13M10.5 11v5M13.5 11v5",
  check: "M5 12.5l4.5 4.5L19 7.5",
  x: "M6 6l12 12M18 6 6 18",
  chev: "M9 6l6 6-6 6",
  floor: "M3 17l5-8h8l5 8zM8 9l-1 8M16 9l1 8M5.5 13h13",
  keyboard: "M3 7h18v10H3zM6 10h1M9 10h1M12 10h1M15 10h1M18 10h1M7 14h10",
  plus: "M12 5v14M5 12h14",
  hand: "M8 13V5.5a1.5 1.5 0 0 1 3 0V11M11 10V4.5a1.5 1.5 0 0 1 3 0V11M14 10.5V6a1.5 1.5 0 0 1 3 0v8a6 6 0 0 1-6 6h-1a6 6 0 0 1-4.6-2.2L3 14.5a1.5 1.5 0 0 1 2.3-1.9L8 15",
  eye: "M2 12s3.5-6 10-6 10 6 10 6-3.5 6-10 6S2 12 2 12zM12 9.5a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5z",
  "eye-off": "M3 3l18 18M10.6 6.1A10 10 0 0 1 12 6c6.5 0 10 6 10 6a17 17 0 0 1-3.2 3.8M6.6 6.6C3.7 8.4 2 12 2 12s3.5 6 10 6a9.6 9.6 0 0 0 4.4-1.1",
  key: "M14.5 3.5a5 5 0 1 0 0 7l-1.5 1.5H11v2H9v2H7v2H3.5v-3.5l7-7M16 7h.01",
  graph: "M4 4v16h16M7 15l3.5-5 3 3L19 6",
  trail: "M5 19c3-1 3-6 7-7s4-5 7-7M5 19h.01M19 5h.01",
  target: "M12 3v4M12 17v4M3 12h4M17 12h4M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8z",
};

export function Icon({ name, size = 16 }: { name: string; size?: number }) {
  const filled = name === "play" || name === "pause";
  return (
    <svg
      className="ic"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill={filled ? "currentColor" : "none"}
      stroke={filled ? "none" : "currentColor"}
      strokeWidth={1.7}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d={PATHS[name] ?? ""} />
    </svg>
  );
}
