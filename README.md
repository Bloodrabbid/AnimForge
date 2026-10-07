# AnimForge

Инструмент анимации под любую игру: рецепты с параметрами + ручной слой правок + клипы, экспорт в glTF, проверка в Godot.
Одно ядро команд (`packages/core`) — его вызывают CLI, MCP и веб-интерфейс.

## Быстрый старт

```sh
pnpm install
P=projects/fish-demo
pnpm af help                                   # все команды с аргументами (JSON)
pnpm af info --project $P                      # кости, цепочки, клипы
pnpm af preset.list --project $P               # пресеты библиотеки
pnpm af recipe.set --clip swim --layer wave --params '{"period":1.6}' --project $P
pnpm af key.set --clip swim --bone spine_5 --axis lateral --t 1.0 --v 25 --project $P
pnpm af sheet --clip swim --view top --out out/swim.png --project $P   # «глаза»: лист кадров через Blender
pnpm af export --out out/fish.glb --project $P                         # glTF для Blender/Godot/любого движка
pnpm af verify --project $P                                            # проверка в Godot без окна
```

## Веб-интерфейс

```sh
pnpm web                     # http://localhost:5178/?dir=projects/fish-demo  (порт — PORT=…)
pnpm web:shot 't=0.3&paused=1&bone=spine_5' out/web/t0.3.png   # скриншот без окна (headless Chromium по CDP)
```

Поза во вьюпорте считается вживую ядром (`poseAt`) на каждом кадре; любое действие в интерфейсе — команда ядра
через `POST /api/command` (тот же `call()`, что у CLI). Если `animforge.json` поменять снаружи (`pnpm af key.set …`),
открытая страница перечитает проект сама (SSE `/api/events` + `fs.watch`).
Параметры адреса: `dir`, `clip`, `t`, `paused=1`, `bone`, `skeleton=0`.

## Устройство

- `packages/core` — модель проекта, рецепты, кривые, вычисление позы, запекание в glTF, реестр команд. Работает и в браузере, и в Node.
- `packages/cli` — адаптеры Node: файлы, Blender, Godot; CLI `af`.
- `apps/web` — веб-интерфейс: Vite + React + three.js, dev-сервер `server.ts` с API поверх адаптеров CLI.
- `bridge/blender` — шаблоны тел (авториг-заготовки) и рендер листа кадров.
- `godot/verify` — проверка экспорта в Godot 4.5.
- `library/presets` — пресеты рецептов; у каждого записано происхождение (из каких замеров взят).
- `research/` — контур «Исследование» (приватный): что извлечено из игр, в библиотеку не попадает.
- `projects/` — проекты анимации (`animforge.json` — текст, удобно править и смотреть в git).
