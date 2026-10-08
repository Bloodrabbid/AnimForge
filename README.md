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
- `bridge/blender` — шаблоны тел (авториг-заготовки), импорт чужих моделей, отрисовка кадров.
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

## Каналы, пол и вторичная динамика

Повороты бывают двух видов. `lateral | vertical | roll` идут по осям цепочки, а `pitch | yaw | bank` — по осям тела
(наклон вперёд вокруг бока, поворот вокруг верха, крен вокруг «вперёд»). Рецепты ходьбы и ударов пишутся в осях тела, поэтому одинаково
работают на любом риге, как бы ни были повёрнуты локальные оси костей. Есть ещё сдвиги `move_up | move_forward | move_side`
(в метрах, по осям тела: up = `project.up`, forward = `project.forward`, по умолчанию +Z) и масштаб `scale_up | scale_forward | scale_side`.
Масштаб попадает на ту ось кости, что ближе к нужному направлению. Всё это экспортируется в glTF и сверяется в Godot (`af verify`).

- `af clip.ground --clip walk --bones foot_l,foot_r --mode floor --ik true` ставит ступни на пол после всех слоёв.
  Режим `contact` прижимает тело к полу, режим `floor` не даёт провалиться, `ik` сгибает колено (двухзвенная IK), а не двигает тело.
- Рецепт `jiggle` — уши, усы, хвосты по движению родителя: маятник с пружиной, у пресетов параметры DynamicBone из Tools Up!.
- Рецепт `waddle-walk` — ходьба вразвалку Tools Up! (подскок таза взят покадрово), `blink` — моргание масштабом,
  `compass-step` — шаг-циркуль Biped.
- `af video --clip walk1 --out out/walk.mp4 --view front_3q` — видео клипа; `sheet --view front|profile|front_3q` — виды для персонажей.
- Шаблоны тел: `fish | snake | tentacle | quadruped | biped | worker`.

## Бой, события и вставки в idle

- `melee-strike`: удар или серия. Фазы: замах, взмах с пиком скорости за `hitLag` до контакта, доводка, возврат, окно на следующий ввод.
  Слои ставятся на роли `arm` (плечо→локоть), `core`, `pelvis`. Пресеты: стили Геральта, телеграфы NPC от собаки до голема, молоток Tools Up!.
- `charge-release`: силовая атака — замах, удержание с пружинящим корнем, выпуск двумя ударами (`witcher-power`).
- События рецептов: `hit`, `whoosh`, `effort`, `trail_on/off`, `window_open/close`.
  Посмотреть их: `af clip.events --clip combo`. При экспорте они пишутся в extras анимации и в `<glb>.events.json`.
  В Godot их подключает `AnimForge.attach_events(player, "res://…events.json", self)`, дальше игра получает вызовы `animforge_event(name, clip)`.
- Вставки в idle по шансу и кулдауну (Witcher, TLJ): `AnimForge.idle_variety($AnimationPlayer, "witcher-geralt")`. Пресеты лежат в `library/idle/`.
- `af tweens.verify` проверяет аддон целиком: твины, события и вставки в idle.
- Шаблоны: детали тела слушаются только своих костей (`bodykit.restrict_weights`), поэтому взмах руки не мнёт туловище и голову.

## Чужие модели: перенос на любой скелет

```sh
pnpm af model.import --file Xbot.fbx --out assets/model.glb --project $P   # FBX, glTF, OBJ, DAE → glb со скином
pnpm af rig.detect --project $P            # цепочки, «вперёд», выравнивание рук
pnpm af clip.add --name walk --duration 1 --project $P
pnpm af recipe.rig --clip walk --recipe waddle-walk --preset toolsup-worker --project $P   # слой на каждую роль
pnpm af clip.ground --clip walk --bones LeftFoot,RightFoot --mode floor --ik true --project $P
```

- `rig.detect` узнаёт кости по именам: Mixamo, Unreal, Unity, Rigify, 3ds Max Biped, числовые префиксы.
  Если имён нет, строит цепочки по геометрии. Направление «вперёд» берёт по меткам L/R, а без них — по носкам.
- Руки, которые в rest отходят от «вниз» больше чем на 30° (T- и A-поза), записываются в `project.align`.
  Перед всеми слоями их опускает вниз с отведением 8°, так махи рецептов начинаются из одной позы у любой модели.
- Масштаб узлов учитывается везде: у FBX корень часто в 0.01 (сантиметры), а сдвиги, IK и пол считаются в метрах мира.
- `model.import` сажает кожу на свои кости. У моделей, вытащенных рипером из сцен-витрин, меш и скелет висят под разными узлами.
  Импорт пробует оба толкования вершин (как рисует Blender и как движок) и берёт то, где вершины ближе к своим костям.
- «Глаза» (`sheet`, `video`) рисуют кожу по спецификации glTF, так же как Godot: позу считает ядро, скиннинг — `packages/cli/src/skin.ts`,
  а Blender только рисует треугольники. Импортёр Blender для этого не годится: у таких моделей он показывает кожу не там, где кости.
  Камера вписывает персонажа во всех позах клипа (`--dist 1`) и смотрит ему в лицо по `project.forward`.
- `af verify` сверяет кости в Godot. Godot заменяет `:` в именах костей на `_` (`mixamorig:Hips`), и проверка это учитывает.
  Если кость не найдена, проверка падает, а не сравнивает с нулём.
- Проверено на Xbot (Mixamo, T-поза), Worker и DeliveryGuy (Tools Up!, A-поза, сцена-витрина) и April (The Longest Journey).
