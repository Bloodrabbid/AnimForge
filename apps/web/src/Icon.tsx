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
