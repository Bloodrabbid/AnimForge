# Живые рецепты: поза скелета считается в игре каждый кадр из <имя>.af.json (его пишет `af publish` рядом с glb).
# Узел — ребёнок Skeleton3D (модификатор скелета). Главные ручки рецептов клипа видны в инспекторе в группе «Ручки»
# и крутятся прямо в запущенной игре; из кода — set_knob("waddle-walk", "period", 0.6).
#   var live := AnimForgeLive.new(); live.data_file = "res://chars/baker.af.json"; skeleton.add_child(live)
#   live.play("walk")
# События рецептов (hit, whoosh, window_open…) — сигнал animforge_event(name, clip) и вызов того же метода у event_target.
# Игровые связки:
#   match_speed + body (CharacterBody3D или любой Node3D) — шаг под настоящую скорость, ноги не скользят;
#   terrain — стопы на рельеф лучами вниз, тело опускается к нижней опоре;
#   look_target — взгляд (aim клипа или шея с головой) на узел; set_target(id, точка) — цель любого констрейна;
#   live_secondary — уши, хвост, колпак раскачивает настоящее движение персонажа (разворот, остановка), а не запись клипа.
@tool
class_name AnimForgeLive
extends SkeletonModifier3D

signal animforge_event(name: String, clip: String)
signal finished(clip: String)

@export_file("*.af.json") var data_file := "":
	set(v):
		data_file = v
		_load()
var clip := "":
	set(v):
		clip = v
		_rebuild()
		notify_property_list_changed()
@export var playing := true
@export_range(0.0, 4.0, 0.01) var speed_scale := 1.0
## Текущее время клипа, с.
@export var time := 0.0
## Узел, у которого вызывается animforge_event(name, clip) (как у AnimForge.attach_events).
@export var event_target: Node

@export_group("Игра")
## Шаг под скорость: клип идёт быстрее или медленнее так, чтобы опорная стопа стояла на месте.
@export var match_speed := false
## Чья скорость: velocity у CharacterBody3D, у остального — сдвиг за кадр. Без узла — move_speed из кода.
@export var body: Node3D
## Скорость персонажа, м/с (если body не задан).
@export var move_speed := 0.0
## Стопы на рельеф: лучи вниз от каждой стопы.
@export var terrain := false
@export_flags_3d_physics var terrain_mask := 1
## Насколько выше и ниже покоя искать пол, доля роста.
@export_range(0.05, 2.0, 0.05) var terrain_reach := 0.5
## Куда смотреть: aim-констрейны клипа, а если их нет — шея и голова.
@export var look_target: Node3D:
	set(v):
		look_target = v
		_rebuild()
## Вторичная динамика от настоящего движения в мире (иначе — записанная по клипу, как в glb).
@export var live_secondary := true
@export_range(0.0, 1.0, 0.05) var look_weight := 0.8:
	set(v):
		look_weight = v
		_rebuild()

var rig: AFCore.Rig
var _data := {}
var _clips := {}
var _clip_eff := {}
var _events := []
var _bones := {}  # имя кости ядра → индекс в Skeleton3D
var _knobs := {}  # рецепт → {параметр: значение}: правка поверх слоёв клипа
var _targets := {}  # id констрейна → глобальная точка
var _K := Transform3D()  # координаты модели (ядра) → локальные Skeleton3D
var _speed := -1.0  # естественная скорость клипа, ед. модели/с; −1 — не посчитана
var _last_body_pos = null
var _warned := {}
var _sec := {}  # пружины вторичной динамики по цепочкам
var _dt := 0.0
var _sec_frame := -1


func _ready() -> void:
	if rig == null:
		_load()


func _load() -> void:
	rig = null
	_clips = {}
	if data_file == "" or not FileAccess.file_exists(data_file):
		return
	var d = JSON.parse_string(FileAccess.get_file_as_string(data_file))
	if not (d is Dictionary):
		push_error("AnimForgeLive: не прочитан %s" % data_file)
		return
	_data = d
	rig = AFCore.build_rig(d)
	for c in d["clips"]:
		_clips[c["name"]] = c
	if clip == "" or not _clips.has(clip):
		clip = "" if _clips.is_empty() else String(d["clips"][0]["name"])
	_map_bones()
	_rebuild()
	notify_property_list_changed()


func _map_bones() -> void:
	_bones = {}
	var sk := get_skeleton()
	if sk == null or rig == null:
		return
	var anchor := -1
	for i in rig.names.size():
		if not rig.is_joint[i] and sk.find_bone(rig.names[i]) < 0:
			continue
		var b := sk.find_bone(rig.names[i])
		if b < 0:
			# импорт Godot заменяет в именах узлов символы, которые нельзя в пути
			b = sk.find_bone(rig.names[i].validate_node_name())
		if b >= 0:
			_bones[rig.names[i]] = b
			if anchor < 0:
				anchor = i
	# связь координат: кость в покое у ядра (мир модели) и у Godot (скелет) — одна и та же
	if anchor >= 0:
		var rt := Transform3D(Basis(rig.world_r[anchor]) * Basis.from_scale(rig.world_s[anchor]), rig.world_t[anchor])
		_K = sk.get_bone_global_rest(_bones[rig.names[anchor]]) * rt.affine_inverse()


func _notification(what: int) -> void:
	if what == NOTIFICATION_PARENTED:
		_map_bones()


## Клип с правками ручек: те же слои, параметры рецептов — с подставленными значениями.
func _rebuild() -> void:
	if rig == null or not _clips.has(clip):
		_clip_eff = {}
		_events = []
		return
	_clip_eff = _clips[clip].duplicate(true)
	for l in _clip_eff["layers"]:
		if l["type"] == "recipe" and _knobs.has(l["recipe"]):
			var p: Dictionary = l.get("params", {})
			for k in _knobs[l["recipe"]]:
				p[k] = _knobs[l["recipe"]][k]
			l["params"] = p
	# взгляд без aim в клипе — свой констрейн на шею и голову (цель придёт из look_target)
	if look_target != null and not _clip_eff.get("constraints", []).any(func(c): return c["type"] == "aim"):
		var bones := []
		for ch in ["neck", "head"]:
			for b in rig.chains.get(ch, []):
				if not bones.has(b):
					bones.append(b)
		if not bones.is_empty():
			var cons: Array = _clip_eff.get("constraints", []) if _clip_eff.get("constraints") != null else []
			cons.append({"id": "_look", "type": "aim", "bones": bones, "weight": look_weight, "target": {"pos": [0, 0, 0]}})
			_clip_eff["constraints"] = cons
	for c in _clip_eff.get("constraints", []) if _clip_eff.get("constraints") != null else []:
		if c["type"] == "aim" and look_target != null:
			c["weight"] = look_weight
	_events = AFCore.clip_events(rig, _clip_eff)
	_speed = -1.0


func play(name: String, from := 0.0) -> void:
	assert(_clips.has(name), "AnimForgeLive: нет клипа «%s»" % name)
	clip = name
	time = from
	playing = true


func clips() -> PackedStringArray:
	return PackedStringArray(_clips.keys())


func set_knob(recipe: String, param: String, value) -> void:
	if not _knobs.has(recipe):
		_knobs[recipe] = {}
	_knobs[recipe][param] = value
	_rebuild()


func get_knob(recipe: String, param: String):
	if _knobs.has(recipe) and _knobs[recipe].has(param):
		return _knobs[recipe][param]
	for l in _clip_eff.get("layers", []):
		if l["type"] == "recipe" and l["recipe"] == recipe:
			return AFCore.with_defaults(rig, recipe, l.get("params", {})).get(param)
	return null


## Цель констрейна id (IK руки, взгляд) — глобальная точка; null — снова цель из клипа.
func set_target(id: String, point) -> void:
	if point == null:
		_targets.erase(id)
	else:
		_targets[id] = point


## Естественная скорость клипа в мире, м/с (с какой надо идти, чтобы ноги не скользили); 0 — у клипа её нет.
func natural_speed() -> float:
	if _clip_eff.is_empty():
		return 0.0
	if _speed < 0:
		_speed = AFCore.natural_speed(rig, _clip_eff)
	return _speed * _model_scale()


## Куда идёт клип в мире (единичный, по полу): у прямой ходьбы — вперёд модели, у клипов clip.directions — под
## их углом к взгляду. Двигай персонажа по нему со скоростью natural_speed() — и ноги не скользят.
func travel_direction() -> Vector3:
	if rig == null or _clip_eff.is_empty():
		return Vector3.ZERO
	var d := _to_global().basis * AFCore.travel_dir(rig, _clip_eff)
	d.y = 0
	return d.normalized()


func _to_global() -> Transform3D:
	var sk := get_skeleton()
	return sk.global_transform * _K if sk else _K


func _model_scale() -> float:
	return (_to_global().basis * AFCore.body_frame(rig).forward).length() if rig else 1.0


func _body_speed(delta: float) -> float:
	if body == null:
		return move_speed
	if body is CharacterBody3D:
		var v: Vector3 = body.velocity
		return Vector3(v.x, 0, v.z).length()
	var p := body.global_position
	var s := 0.0
	if _last_body_pos != null and delta > 0:
		var d: Vector3 = p - _last_body_pos
		s = Vector3(d.x, 0, d.z).length() / delta
	_last_body_pos = p
	return s


func _process(delta: float) -> void:
	_dt = delta
	if not playing or _clip_eff.is_empty():
		return
	var dur: float = _clip_eff["duration"]
	var t0 := time
	var rate := speed_scale
	if match_speed and _clip_eff["loop"]:
		var nat := natural_speed()
		if nat > 0:
			rate = speed_scale * _body_speed(delta) / nat
		elif not _warned.has(clip) and _clip_eff.get("ground") != null:
			_warned[clip] = true
			push_warning("AnimForgeLive: у клипа «%s» опорная стопа не уезжает назад — подгонять шаг под скорость нечем (походку надо чинить)" % clip)
	var t1 := time + delta * rate
	_fire(t0, t1, dur)
	if _clip_eff["loop"]:
		time = fposmod(t1, dur) if dur > 0 else 0.0
	elif t1 >= dur:
		time = dur
		playing = false
		finished.emit(clip)
	else:
		time = t1


## События между t0 и t1 (у цикла — с переходом через конец).
func _fire(t0: float, t1: float, dur: float) -> void:
	if _events.is_empty() or t1 <= t0:
		return
	var loops: bool = _clip_eff["loop"] and dur > 0
	var a := t0
	while a < t1:
		var base := floorf(a / dur) * dur if loops else 0.0
		var b := minf(t1, base + dur) if loops else t1
		for e in _events:
			var et: float = base + e["t"]
			if et > a and et <= b or (a == 0.0 and et == 0.0):
				animforge_event.emit(e["name"], clip)
				if event_target and event_target.has_method("animforge_event"):
					event_target.animforge_event(e["name"], clip)
		if not loops:
			break
		a = b


func _process_modification() -> void:
	var sk := get_skeleton()
	if sk == null or rig == null or _clip_eff.is_empty():
		return
	if _bones.is_empty():
		_map_bones()
	var parts := AFCore.pose_parts_at(rig, _clip_eff, time, _live_opts())
	for name in _bones:
		var b: int = _bones[name]
		var i: int = rig.index[name]
		sk.set_bone_pose_rotation(b, parts.rot.get(name, rig.rest_r[i]))
		sk.set_bone_pose_position(b, parts.pos.get(name, rig.rest_t[i]))
		sk.set_bone_pose_scale(b, parts.scl.get(name, rig.rest_s[i]))


## Связки для ядра — в координатах модели: рельеф лучами и цели констрейнов.
func _live_opts() -> Dictionary:
	var o := {}
	var G := _to_global()
	var inv := G.affine_inverse()
	var tg := {}
	for id in _targets:
		tg[id] = inv * _targets[id]
	if look_target != null:
		var p := inv * look_target.global_position
		for c in _clip_eff.get("constraints", []) if _clip_eff.get("constraints") != null else []:
			if c["type"] == "aim":
				tg[c["id"]] = p
	if not tg.is_empty():
		o["targets"] = tg
	if live_secondary:
		# пружина шагает раз в кадр, даже если скелет обновился дважды
		var frame := Engine.get_process_frames()
		var dt := _dt if frame != _sec_frame else 0.0
		_sec_frame = frame
		o["secondary"] = func(acc, r, c): AFCore.live_secondary(acc, r, c, G, dt, _sec)
	if terrain and is_inside_tree():
		var space := get_world_3d().direct_space_state
		var f := AFCore.body_frame(rig)
		var reach: float = terrain_reach * rig.heights[AFCore.SIZE]
		o["floor"] = func(_bone: String, F: Vector3, rest: float) -> float:
			# луч вниз через стопу: от покоя + reach до покоя − reach (в мире)
			var flat := F - f.up * (F.dot(f.up) - rest)
			var q := PhysicsRayQueryParameters3D.create(G * (flat + f.up * reach), G * (flat - f.up * reach), terrain_mask)
			var hit := space.intersect_ray(q)
			return (inv * hit["position"]).dot(f.up) if not hit.is_empty() else rest
	return o


# ── ручки в инспекторе: main-параметры рецептов клипа ─────────────────────────────────────────────────────────
func _knob_specs() -> Array:
	var out := []
	var seen := {}
	if rig == null:
		return out
	for l in _clip_eff.get("layers", []):
		if l["type"] != "recipe" or seen.has(l["recipe"]) or not rig.recipes.has(l["recipe"]):
			continue
		seen[l["recipe"]] = true
		var def: Dictionary = rig.recipes[l["recipe"]]
		for k in def.get("main", []):
			var s = def["params"].get(k)
			if s != null and s["type"] == "number":
				out.append({"recipe": l["recipe"], "param": k, "spec": s})
	return out


func _get_property_list() -> Array:
	var props := []
	props.append({"name": "clip", "type": TYPE_STRING, "hint": PROPERTY_HINT_ENUM, "hint_string": ",".join(clips()), "usage": PROPERTY_USAGE_DEFAULT})
	if rig == null:
		return props
	props.append({"name": "Ручки", "type": TYPE_NIL, "usage": PROPERTY_USAGE_GROUP, "hint_string": "knob/"})
	for k in _knob_specs():
		var s: Dictionary = k["spec"]
		var step: float = (float(s["max"]) - float(s["min"])) / 200.0
		props.append({"name": "knob/%s/%s" % [k["recipe"], k["param"]], "type": TYPE_FLOAT, "hint": PROPERTY_HINT_RANGE, "hint_string": "%s,%s,%s" % [s["min"], s["max"], step], "usage": PROPERTY_USAGE_DEFAULT})
	return props


func _get(property: StringName):
	var s := String(property)
	if s.begins_with("knob/"):
		var p := s.split("/")
		return get_knob(p[1], p[2])
	return null


func _set(property: StringName, value) -> bool:
	var s := String(property)
	if s.begins_with("knob/"):
		var p := s.split("/")
		set_knob(p[1], p[2], value)
		return true
	return false
