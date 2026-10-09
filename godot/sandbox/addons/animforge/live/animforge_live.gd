# Живые рецепты: поза скелета считается в игре каждый кадр из <имя>.af.json (его пишет `af publish` рядом с glb).
# Узел — ребёнок Skeleton3D (модификатор скелета). Главные ручки рецептов клипа видны в инспекторе в группе «Ручки»
# и крутятся прямо в запущенной игре; из кода — set_knob("waddle-walk", "period", 0.6).
#   var live := AnimForgeLive.new(); live.data_file = "res://chars/baker.af.json"; skeleton.add_child(live)
#   live.play("walk")
# События рецептов (hit, whoosh, window_open…) — сигнал animforge_event(name, clip) и вызов того же метода у event_target.
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

var rig: AFCore.Rig
var _data := {}
var _clips := {}
var _clip_eff := {}
var _events := []
var _bones := {}  # имя кости ядра → индекс в Skeleton3D
var _knobs := {}  # рецепт → {параметр: значение}: правка поверх слоёв клипа
var _opts := {}


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
	for i in rig.names.size():
		if not rig.is_joint[i] and sk.find_bone(rig.names[i]) < 0:
			continue
		var b := sk.find_bone(rig.names[i])
		if b < 0:
			# импорт Godot заменяет в именах узлов символы, которые нельзя в пути
			b = sk.find_bone(rig.names[i].validate_node_name())
		if b >= 0:
			_bones[rig.names[i]] = b


func _notification(what: int) -> void:
	if what == NOTIFICATION_PARENTED:
		_map_bones()


## Клип с правками ручек: те же слои, параметры рецептов — с подставленными значениями.
func _rebuild() -> void:
	if not _clips.has(clip):
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
	_events = AFCore.clip_events(rig, _clip_eff)


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


func _process(delta: float) -> void:
	if not playing or _clip_eff.is_empty():
		return
	var dur: float = _clip_eff["duration"]
	var t0 := time
	var t1 := time + delta * speed_scale
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
	var parts := AFCore.pose_parts_at(rig, _clip_eff, time, _opts)
	for name in _bones:
		var b: int = _bones[name]
		var i: int = rig.index[name]
		sk.set_bone_pose_rotation(b, parts.rot.get(name, rig.rest_r[i]))
		sk.set_bone_pose_position(b, parts.pos.get(name, rig.rest_t[i]))
		sk.set_bone_pose_scale(b, parts.scl.get(name, rig.rest_s[i]))


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
