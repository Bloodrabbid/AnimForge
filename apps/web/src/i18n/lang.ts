// Язык интерфейса: ?lang=en|ru → выбор пользователя (localStorage) → язык браузера (русский — ru, любой другой — en).
const pick = (): "ru" | "en" => {
  const q = new URLSearchParams(location.search).get("lang");
  if (q === "ru" || q === "en") {
    localStorage.setItem("af.lang", q);
    return q;
  }
  const saved = localStorage.getItem("af.lang");
  if (saved === "ru" || saved === "en") return saved;
  return /^ru\b/i.test(navigator.language) ? "ru" : "en";
};
export const LANG = typeof location === "undefined" ? "ru" : pick();
export const EN = LANG === "en";

export function setLang(l: "ru" | "en") {
  localStorage.setItem("af.lang", l);
  const u = new URL(location.href);
  u.searchParams.delete("lang");
  location.href = u.toString();
}

/** «ArmsAboveHead» → «arms above head»: английская подпись из исходного имени */
export const humanize = (s: string) => s.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/[_-]+/g, " ").toLowerCase().trim();
