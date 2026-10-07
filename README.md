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

## Устройство

- `packages/core` — модель проекта, рецепты, кривые, вычисление позы, запекание в glTF, реестр команд. Работает и в браузере, и в Node.
- `packages/cli` — адаптеры Node: файлы, Blender, Godot; CLI `af`.
- `bridge/blender` — шаблоны тел (авториг-заготовки) и рендер листа кадров.
- `godot/verify` — проверка экспорта в Godot 4.5.
- `library/presets` — пресеты рецептов; у каждого записано происхождение (из каких замеров взят).
- `research/` — контур «Исследование» (приватный): что извлечено из игр, в библиотеку не попадает.
- `projects/` — проекты анимации (`animforge.json` — текст, удобно править и смотреть в git).

## Твины UI и камеры

Пресеты лежат в `library/tweens/{ui,camera}.json`, у каждого указано происхождение (провенанс). Это 12 пресетов UI и 6 пресетов камеры, сняты с DREDGE. Одни и те же формулы считают ядро (`packages/core/src/tweens.ts`) и аддон Godot (`godot/sandbox/addons/animforge`).

```sh
pnpm af tweens.list --target ui
pnpm af tweens.plot --preset jump_spin --out out/tweens/jump_spin.png   # график свойств во времени
pnpm af tweens.verify      # синхронизирует пресеты в аддон и сверяет Godot с ядром без окна
```

Чтобы подключить в свою игру, скопируй `godot/sandbox/addons/animforge` в проект и включи плагин. Дальше:
`AnimForge.play($Panel, "window_in")`, `AnimForge.play($Camera3D, "shake_explosion")`,
`AnimForge.play(btn, "button_cascade_item", {"delay": 0.1 * i})`.
