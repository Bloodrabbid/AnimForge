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

## Четвероногие

```sh
pnpm af rig.detect --project $P     # четвероногое узнаётся по лапам, «вперёд» — к голове
pnpm af recipe.rig --clip walk --recipe quadruped-gait --preset witcher-dog-walk --project $P
pnpm af recipe.add --clip walk --recipe jiggle --chain tail --id tail_jiggle --project $P
pnpm af clip.ground --clip walk --bones <4 лапы из rig.detect: paws> --mode floor --ik true --project $P
```

- `rig.detect` узнаёт четвероногое по геометрии, имена не нужны. Внизу должно быть четыре лапы, корень каждой — у тела.
  Передняя пара — та, что ближе к голове. Цепочки те же, что у двуногих: передние лапы — `arm_l/arm_r`, задние — `leg_l/leg_r`,
  таз и грудь — места крепления лап, а также `spine`, `neck`, `head`, `tail`. В ответе есть `paws` — концы лап для `clip.ground`.
- `quadruped-gait` построен по собаке Witcher (`cr_canine`, у баргеста те же клипы). У каждой лапы четыре кривые суставов за цикл:
  плечо или бедро, локоть или колено, пясть или плюсна, пальцы. Вынос лапы быстрый, опора занимает около 70 % цикла.
  Лапы сдвинуты по фазе, корпус качается, шея считается как «своё минус корпус», таз подскакивает.
- Пресеты: `witcher-dog-walk` (шаг, пары почти диагональные), `witcher-dog-run` (поперечный галоп),
  `trot` (рысь) и `pace` (иноходь). В двух последних фазы взяты из определения аллюра, а кривые — от шага собаки.
- Проверено на лисе Khronos Fox (glTF Sample Assets, CC-BY 4.0) и на шаблоне `quadruped`, у которого теперь есть ступни.

## Бестиарий: многоногие, крылатые, парящие, щупальца, водные

`rig.detect` возвращает `body`: `quadruped`, `multileg` (6 и больше ног, цепочки `leg_l0…`, `leg_r0…` спереди назад),
`winged` (размах рук больше 1.6 роста — цепочки `wing_l/wing_r`), `biped` или `other`. Рецепты вешаются через `recipe.rig`,
а слой из готового пресета — через `preset.apply` (у `recipe.add` аргумент `preset` — только пометка происхождения).

| рецепт | для кого | пресеты (игра) |
|---|---|---|
| `multileg-gait` | насекомые, пауки, сколопендры, кикиморы | `tripod`, `witcher-centipede`, `witcher-kikimora-trot/run`, `witcher-kosh-walk` |
| `quadruped-gait` | звери, ходьба на кулаках | `witcher-dog-*`, `trot`, `pace`, `witcher-gigant-knuckle/bound` |
| `waddle-walk` | големы, мелкие двуногие | `witcher-golem-walk`, `witcher-zjad-walk` |
| `wing-flap` | птицы, ласты, бабочки | `witcher-cockatrice-flap`, `tlj-crow-flap`, `toolsup-butterfly`, `dredge-turtle-stroke` |
| `hover` | призраки, ифриты | `witcher-wraith-move/idle/ready`, `witcher-ifryt-dive` |
| `tentacle-strike` | щупальца, хлысты | `witcher-tentacle-slam`, `witcher-echinops-whip/slam` |
| `emerge` | из-под земли или воды и обратно | `witcher-tentacle-up/down`, `witcher-dagon-surface`, `witcher-zeugl-rise`, `witcher-wraith-vanish`, `witcher-drowner-dive` |
| `wave` | рыбы, змеи, черви, хвосты | `dredge-ghost-shark-*`, `dredge-great-white`, `dredge-leviathan`, `dredge-twisted-strand`, `dredge-dog-tail-wag`, `tlj-mermaid-tail`, `tlj-snapjaw-idle`, `toolsup-dog-tail-*` |

Шаблоны `template.make`: `quadruped`, `insect`, `spider`, `centipede`, `bird`, `ghost`, `plant`. Разборы, из которых взяты числа:
`research/` (Witcher — главы 05–06, DREDGE — глава 04, TLJ, Biped и Tools Up! — главы 05).
