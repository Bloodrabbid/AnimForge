// Русские названия клипов библиотеки: имена дублей в паках английские («walk_Zombie_loop», «Sword_Attack»,
// «bow_not-confident_001»). Стили 100STYLE и Bandai — готовыми фразами (по описаниям наборов), остальное — по словам.
// Поиск идёт и по русскому названию, и по исходному имени.
import { STYLE100 } from "../../../packages/core/src/style.ts";

/** Стили 100STYLE (по Dataset_List.csv) и Bandai Namco (по README набора). */
export const STYLES: Record<string, string> = {
  ...STYLE100,
  // Bandai Namco
  normal: "обычно", happy: "радостно", sad: "грустно", angry: "сердито", proud: "гордо", "not-confident": "неуверенно",
  masculinity: "по-мужски", masculine: "по-мужски", feminine: "по-женски", childish: "по-детски", children: "по-детски",
  old: "старик", elderly: "старик", tired: "устало", exhausted: "устало", active: "бодро", musical: "как в мюзикле",
  giant: "великан", chimpira: "хулиган",
};

/** Слова имён (в нижнем регистре). */
export const WORDS: Record<string, string> = {
  walk: "шаг", walking: "шаг", run: "бег", running: "бег", jog: "трусцой", sprint: "спринт", idle: "стойка",
  back: "назад", backward: "назад", backwards: "назад", bkwd: "назад", bck: "назад", forward: "вперёд", fwd: "вперёд",
  strafe: "вбок", left: "влево", right: "вправо", transition: "переход", "walk-run": "шаг-бег", jump: "прыжок", jumps: "прыжки",
  hop: "прыжок", land: "приземление", fall: "падение", attack: "атака", bite: "укус", death: "смерть", die: "смерть",
  hit: "удар", melee: "ближний бой", punch: "удар кулаком", jab: "джеб", kick: "пинок", dance: "танец", dancing: "танец",
  spin: "кружение", robot: "робот", crouch: "присед", crouched: "присед", sit: "сидя", sitting: "сидя", stand: "встать",
  standing: "стоя", lie: "лёжа", laying: "лёжа", lay: "лёжа", phone: "телефон", dash: "рывок", yes: "да", no: "нет",
  bow: "поклон", bye: "пока", byebye: "пока-пока", guide: "показывает дорогу", call: "подзывает", respond: "отвечает",
  wave: "машет", waving: "машет", shoot: "выстрел", shooting: "стрельба", aim: "прицел", aiming: "прицел", reload: "перезарядка",
  pistol: "пистолет", gun: "оружие", sword: "меч", slash: "взмах мечом", slice: "рубящий", stab: "укол", chop: "рубит",
  shield: "щит", block: "блок", blocking: "блок", dodge: "уклон", roll: "кувырок", spell: "заклинание", spellcast: "заклинание",
  spellcasting: "заклинание", summon: "призыв", cast: "заклинание", swim: "плавание", swimming: "плавание", flying: "полёт",
  fly: "полёт", climb: "лазанье", push: "толкает", pull: "тянет", pulling: "тянет", carry: "несёт", throw: "бросок",
  pick: "поднять", up: "вверх", down: "вниз", interact: "действие", use: "использовать", item: "предмет", eat: "ест",
  consume: "ест", drink: "пьёт", sneak: "крадучись", sneaky: "крадучись", sneaking: "крадучись", limp: "хромая",
  drunk: "пьяно", zombie: "зомби", scratch: "царапает", knockback: "отброшен", stumble: "спотыкается", victory: "победа",
  defeat: "поражение", cheer: "радуется", taunt: "дразнит", emote: "эмоция", gesture: "жест", talking: "говорит",
  thumbs: "палец вверх", positive: "одобрение", negative: "неодобрение", wheelchair: "коляска", drive: "вождение",
  driving: "вождение", fixing: "чинит", kneeling: "на коленях", torch: "факел", lantern: "фонарь", harvest: "урожай",
  plant: "сажает", seed: "семена", watering: "поливает", farm: "ферма", tree: "дерево", chopping: "рубит", fishing: "рыбалка",
  cartwheel: "колесо", cartwheels001: "колесо", flip: "сальто", summersult: "сальто", twist: "поворот", karate: "карате",
  ninja: "ниндзя", spawn: "появление", awaken: "пробуждение", resurrect: "воскрешение", static: "неподвижно",
  tpose: "T-поза", pose: "поза", look: "смотрит", looking: "смотрит", turn: "разворот", around: "кругом",
  combat: "бой", unarmed: "без оружия", dualwield: "два оружия", "1h": "одноручное", "2h": "двуручное", ranged: "дальний бой",
  start: "начало", stop: "остановка", slow: "медленно", fast: "быстро", quick: "быстро", casual: "небрежно",
  formal: "чинно", female: "женщина", male: "мужчина", lady: "дама", teen: "подросток", gorilla: "горилла",
  monkey: "обезьяна", bear: "медведь", dinosaur: "динозавр", insect: "насекомое", squirrel: "белка", hummingbird: "колибри",
  alien: "пришелец", dragon: "дракон", slime: "слизень", bat: "летучая мышь", skeleton: "скелет", skeletons: "скелеты",
  chair: "стул", table: "стол", rail: "поручень", air: "воздух", ground: "земля", floor: "пол", head: "голова",
  arms: "руки", arm: "рука", legs: "ноги", leg: "нога", hands: "руки", hand: "рука", feet: "ноги", foot: "нога",
  chest: "грудь", hips: "бёдра", knees: "колени", toes: "носки", heels: "пятки", shoulders: "плечи",
  "dance-long": "танец длинный", "dance-short": "танец короткий", "walk-back": "шаг назад", "walk-left": "шаг влево",
  "walk-right": "шаг вправо", "strafe-walk": "шаг вбок", "strafe-run": "бег вбок", "run-back": "бег назад",
  "raise-up-both-hands": "поднимает обе руки", "wave-both-hands": "машет обеими руками",
  front: "спереди", recieve: "получает удар", receive: "получает удар", place: "ставит", holding: "держит", side: "бок",
  move: "движение", action: "действие", regular: "обычный", simple: "простой", charleston: "чарльстон", mickey: "Микки",
  bent: "согнувшись", both: "обе", enter: "вход", exit: "выход", slide: "скольжение", get: "получает", long: "длинный",
  plane: "самолёт", cross: "накрест", break: "брейк", hook: "хук", one: "одна", step: "шаг", normal: "обычно",
  full: "полный", inactive: "неактивно", open: "открывает", overhand: "сверху", shot: "выстрел", combo: "комбо",
  mawashigeri: "маваси-гери", oiduki: "ой-цуки", syutouuke: "сюто-укэ", sequence: "серия", reach: "тянется",
  helicopter: "вертолёт", spring: "прыжок", shifting: "переносит", weight: "вес", poking: "тычет", ducking: "пригибается",
  circles: "круги", face: "лицо", wide: "широко", angle: "под углом", pterosaur: "птерозавр", praying: "молящийся",
  mantis: "богомол", chicken: "курица", whirl: "вихрь", lambada: "ламбада", lindy: "линди-хоп", duck: "утка",
  underneath: "снизу", balancing: "балансирует", bouncy: "пружинисто", leaning: "наклонившись", swinging: "раскачиваясь",
  gangly: "долговязый", graceful: "изящно", singing: "поёт", rain: "дождь", diagonal: "по диагонали",
  horizontal: "горизонтально", spinning: "кружится", short: "короткий", raise: "поднимает", longer: "дольше",
  handed: "руками", fold: "складывает", out: "наружу", again: "снова", flp: "сальто", twst: "поворот", twists: "повороты",
  heavy: "тяжело", light: "легко", happy: "радостно", sad: "грустно", angry: "сердито", proud: "гордо", old: "старик",
  tired: "устало", giant: "великан", mower: "газонокосилка", lawn: "газон", crowd: "толпа", stick: "трость",
  neutral: "обычно", endof: "конец", onto: "на", from: "из", xtra: "экстра", fanc: "фантазия", stiff: "скованно",
  rec: "запись", m: "м",
};

/** Движения, после которых в имени идёт стиль набора (100STYLE, Bandai): «walk_Zombie_loop», «bow_happy_001». */
const STYLED = /^(walk|walk-back|walk-left|walk-right|strafe-walk|run|run-back|strafe-run|idle|dash|transition-walk-run-\d|bow|bye|byebye|guide|call|respond|kick|punch|slash|dance-long|dance-short)$/;

const DROP = new Set(["loop", "rm", "armature", "the", "a", "on", "in", "by", "with", "to", "and", "of"]);

/** Русское название дубля: «walk_Zombie_loop» → «шаг · зомби», «bow_not-confident_001» → «поклон · неуверенно». */
export function ruName(take: string): string {
  const name = take.replace(/^.*\|/, "");
  const parts: string[] = [];
  const segs = name.split(/_+/);
  const styled = STYLED.test(segs[0]);
  for (const [k, seg] of segs.entries()) {
    if (!seg || /^\d+$/.test(seg)) continue;
    if (styled && k > 0 && STYLES[seg]) { parts.push(STYLES[seg]); continue; }
    const low = seg.toLowerCase();
    if (WORDS[low]) { parts.push(WORDS[low]); continue; }
    if (DROP.has(low)) continue;
    // переход шаг ↔ бег с номером записи
    const tr = low.match(/^transition-walk-run-(\d)$/);
    if (tr) { parts.push("переход шаг ↔ бег"); continue; }
    const words = seg.replace(/([a-z])([A-Z])/g, "$1 $2").split(/[\s\-.,()]+/).map((w) => w.toLowerCase().replace(/\d+$/, "").replace(/^\d+/, "")).filter((w) => w && !DROP.has(w));
    const ru = words.map((w) => WORDS[w] ?? (w.length === 1 ? w.toUpperCase() : w));
    if (ru.length) parts.push(ru.join(" "));
  }
  return parts.join(" · ") || name;
}

/** Текст для поиска: русское название и исходное имя (слова раздельно, «WalkingStick» → «walking stick»). */
export function searchText(take: string, pack: string): string {
  const raw = take.replace(/^.*\|/, "");
  return `${ruName(raw)} ${raw} ${raw.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/[_-]+/g, " ")} ${pack}`.toLowerCase();
}

/** Нижний регистр, ё = е. */
export const norm = (x: string) => x.toLowerCase().replace(/ё/g, "е");

/** Слово запроса в тексте: целиком или без окончания («поклоны» → «поклон», «прыжками» → «прыжк…»). */
export const wordHit = (text: string, w: string) => text.includes(w) || (w.length >= 5 && text.includes(w.slice(0, -2))) || (w.length >= 4 && /[а-я]$/.test(w) && text.includes(w.slice(0, -1)));
