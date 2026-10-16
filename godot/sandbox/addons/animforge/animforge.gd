# AnimForge: проигрывание пресетов твинов UI и камеры из presets/*.json.
# Формулы easing, тряски и выборки — точная копия packages/core/src/tweens.ts; совпадение проверяет `pnpm af tweens.verify`.
#   AnimForge.play($Panel, "window_in")
#   AnimForge.play($Camera3D, "shake_explosion")
#   AnimForge.play(button, "button_cascade_item", {"delay": 0.1 * i})
class_name AnimForge
extends RefCounted

const PRESET_DIR := "res://addons/animforge/presets"
static var _presets := {}


static func presets() -> Dictionary:
	if _presets.is_empty():
		for f in DirAccess.get_files_at(PRESET_DIR):
			if not f.ends_with(".json"):
				continue
			var data = JSON.parse_string(FileAccess.get_file_as_string(PRESET_DIR + "/" + f))
			for p in data["presets"]:
				_presets[p["name"]] = p
	return _presets


static func preset(name: String) -> Dictionary:
	var p = presets().get(name)
	assert(p != null, "AnimForge: нет пресета «%s»" % name)
	return p


static func ease_value(spec, s: float) -> float:
	s = clampf(s, 0.0, 1.0)
	if spec is Dictionary:
		var a: float = spec["hermite"][0]
		var b: float = spec["hermite"][1]
		return (s ** 3 - 2 * s ** 2 + s) * a + (-2 * s ** 3 + 3 * s ** 2) + (s ** 3 - s ** 2) * b
	match spec if spec != null else "linear":
		"linear": return s
		"inQuad": return s * s
		"outQuad": return 1 - (1 - s) * (1 - s)
		"inOutSine": return -(cos(PI * s) - 1) / 2
		"outExpo": return 1.0 if s >= 1 else 1 - pow(2, -10 * s)
		"outBack":
			var c1 := 1.70158
			return 1 + (c1 + 1) * (s - 1) ** 3 + c1 * (s - 1) ** 2
		"outBounce":
			var n := 7.5625
			var d := 2.75
			if s < 1 / d: return n * s * s
			if s < 2 / d:
				s -= 1.5 / d
				return n * s * s + 0.75
			if s < 2.5 / d:
				s -= 2.25 / d
				return n * s * s + 0.9375
			s -= 2.625 / d
			return n * s * s + 0.984375
		"smoothstep": return s * s * (3 - 2 * s)
		"step": return 1.0 if s >= 1 else 0.0
	push_error("AnimForge: неизвестный ease «%s»" % [spec])
	return s


static func _seg_value(segs: Array, t: float) -> float:
	var ss := segs.duplicate()
	ss.sort_custom(func(a, b): return a["t0"] < b["t0"])
	if t <= ss[0]["t0"]:
		return ss[0]["from"]
	var v: float = ss[0]["from"]
	for s in ss:
		if t < s["t0"]:
			return v  # пауза между сегментами — держим конец предыдущего
		if t <= s["t1"]:
			var k: float = 1.0 if s["t1"] <= s["t0"] else (t - s["t0"]) / (s["t1"] - s["t0"])
			return s["from"] + (s["to"] - s["from"]) * ease_value(s.get("ease"), k)
		v = s["to"]
	return v


## Тряска: x, y — смещение, z — крен в градусах.
static func shake_at(sh: Dictionary, t: float) -> Vector3:
	var at: float = sh["attack"]
	var su: float = sh["sustain"]
	var de: float = sh["decay"]
	var env := 0.0
	if t < at: env = ease_value("smoothstep", t / at)
	elif t < at + su: env = 1.0
	elif t < at + su + de: env = (1 - (t - at - su) / de) ** 2
	var s: float = sh.get("seed", 1)
	var w := TAU * float(sh["freq"]) * t
	var n := func(k: float) -> float:
		return 0.5 * sin(w + s * k) + 0.3 * sin(2.17 * w + s * k * 1.7) + 0.2 * sin(3.71 * w + s * k * 2.3)
	var amp: float = sh["amp"]
	return Vector3(amp * env * n.call(1), amp * env * n.call(2), float(sh.get("roll", 0)) * amp * env * n.call(3))


## Значения всех свойств пресета в момент t (смысл задаёт mode трека).
static func sample(p: Dictionary, t: float) -> Dictionary:
	var dur: float = p["duration"]
	if p.get("loop", false) and dur > 0:
		t = fposmod(t, dur)
	var out := {}
	for tr in p["tracks"]:
		if tr.has("shake"):
			var v := shake_at(tr["shake"], t)
			out["shake_x"] = v.x
			out["shake_y"] = v.y
			out["shake_roll"] = v.z
		elif tr.get("segments", []).size() > 0:
			out[tr["prop"]] = _seg_value(tr["segments"], t)
	return out


## Запускает пресет на Control, Camera3D, Camera2D или Node3D. opts: delay (с), loops (для циклов, 0 = бесконечно), speed.
static func play(node: Node, name: String, opts := {}) -> Tween:
	var p := preset(name)
	var base := _capture(node)
	var modes := {}
	for tr in p["tracks"]:
		modes[tr["prop"]] = tr.get("mode", "abs")
	if node is Control:
		node.pivot_offset = node.size / 2
	var tw := node.create_tween()
	if p.get("loop", false):
		tw.set_loops(opts.get("loops", 0))
	tw.set_speed_scale(opts.get("speed", 1.0))
	apply(node, base, modes, sample(p, 0))
	if opts.get("delay", 0.0) > 0:
		tw.tween_interval(opts["delay"])
	tw.tween_method(func(t: float): apply(node, base, modes, sample(p, t)), 0.0, float(p["duration"]), float(p["duration"]))
	return tw


static func _capture(node: Node) -> Dictionary:
	if node is Control:
		return {"x": node.position.x, "y": node.position.y, "scale_x": node.scale.x, "scale_y": node.scale.y,
			"rotation": node.rotation_degrees, "alpha": node.modulate.a}
	if node is Camera3D:
		return {"fov": node.fov, "yaw": node.rotation_degrees.y, "pitch": node.rotation_degrees.x,
			"roll": node.rotation_degrees.z, "h": node.h_offset, "v": node.v_offset, "pos": node.position, "fwd": -node.transform.basis.z}
	if node is Camera2D:
		return {"x": node.offset.x, "y": node.offset.y, "rotation": node.rotation_degrees, "zoom": node.zoom.x}
	if node is Node3D:
		return {"x": node.position.x, "y": node.position.y, "z": node.position.z, "yaw": node.rotation_degrees.y}
	push_error("AnimForge: пресеты умеют Control, Camera3D, Camera2D и Node3D, а не %s" % node.get_class())
	return {}


static func _mix(base: float, v: float, mode: String) -> float:
	match mode:
		"add": return base + v
		"mul": return base * v
	return v


## Применяет выборку sample() к узлу относительно исходного состояния base.
static func apply(node: Node, base: Dictionary, modes: Dictionary, s: Dictionary) -> void:
	if node is Control:
		var c := node as Control
		if s.has("x"): c.position.x = _mix(base["x"], s["x"], modes["x"])
		if s.has("y"): c.position.y = _mix(base["y"], s["y"], modes["y"])
		if s.has("scale"):
			c.scale = Vector2(_mix(base["scale_x"], s["scale"], modes["scale"]), _mix(base["scale_y"], s["scale"], modes["scale"]))
		if s.has("scale_x"): c.scale.x = _mix(base["scale_x"], s["scale_x"], modes["scale_x"])
		if s.has("scale_y"): c.scale.y = _mix(base["scale_y"], s["scale_y"], modes["scale_y"])
		if s.has("rotation"): c.rotation_degrees = _mix(base["rotation"], s["rotation"], modes["rotation"])
		if s.has("alpha"): c.modulate.a = _mix(base["alpha"], s["alpha"], modes["alpha"])
		if s.has("shake_x"):
			c.position += Vector2(s["shake_x"], s["shake_y"])
	elif node is Camera3D:
		var cam := node as Camera3D
		if s.has("fov"): cam.fov = _mix(base["fov"], s["fov"], modes["fov"])
		if s.has("yaw"): cam.rotation_degrees.y = _mix(base["yaw"], s["yaw"], modes["yaw"])
		if s.has("pitch"): cam.rotation_degrees.x = _mix(base["pitch"], s["pitch"], modes["pitch"])
		if s.has("dolly"):  # метры вперёд по исходному направлению взгляда
			cam.position = base["pos"] + base["fwd"] * float(s["dolly"])
		if s.has("shake_x"):
			cam.h_offset = base["h"] + s["shake_x"]
			cam.v_offset = base["v"] + s["shake_y"]
			cam.rotation_degrees.z = base["roll"] + s["shake_roll"]
	elif node is Camera2D:
		var c2 := node as Camera2D
		if s.has("shake_x"):
			# смещение камеры задано в единицах 3D-сцены; для 2D переводим в пиксели ×100
			c2.offset = Vector2(base["x"] + s["shake_x"] * 100, base["y"] + s["shake_y"] * 100)
			c2.rotation_degrees = base["rotation"] + s["shake_roll"]
		if s.has("fov"): c2.zoom = Vector2.ONE * base["zoom"] * 40.0 / (40.0 + s["fov"])
	elif node is Node3D:
		# target «node»: сдвиг в осях родителя, поворот вокруг вертикали и путь вперёд по взгляду после поворота
		var n3 := node as Node3D
		if s.has("yaw"): n3.rotation_degrees.y = _mix(base["yaw"], s["yaw"], modes["yaw"])
		var pos := Vector3(base["x"], base["y"], base["z"])
		for k in [["x", 0], ["y", 1], ["z", 2]]:
			if s.has(k[0]): pos[k[1]] = _mix(pos[k[1]], s[k[0]], modes[k[0]])
		if s.has("forward"): pos += -n3.transform.basis.z * float(s["forward"])
		n3.position = pos


## События клипов из <glb>.events.json (их пишет `af export`) → дорожки вызова метода в анимациях плеера.
## В нужный момент вызывается target.animforge_event(name, clip). Возвращает число вставленных событий.
static func attach_events(player: AnimationPlayer, events_path: String, target: Node) -> int:
	var data = JSON.parse_string(FileAccess.get_file_as_string(events_path))
	if data == null:
		push_error("AnimForge: не прочитан %s" % events_path)
		return 0
	var n := 0
	var path := player.get_node(player.root_node).get_path_to(target)
	for clip in data:
		if not player.has_animation(clip):
			continue
		var anim := player.get_animation(clip)
		var tr := anim.find_track(path, Animation.TYPE_METHOD)
		if tr < 0:
			tr = anim.add_track(Animation.TYPE_METHOD)
			anim.track_set_path(tr, path)
		for e in data[clip]:
			anim.track_insert_key(tr, float(e["t"]), {"method": &"animforge_event", "args": [e["name"], clip]})
			n += 1
	return n


## Вставки в idle по шансу и кулдауну (как в Witcher): пресет из presets/idle/*.json или словарь.
## Возвращает узел-планировщик (уже добавлен к плееру); его можно остановить queue_free().
static func idle_variety(player: AnimationPlayer, preset_or_config, seed := -1) -> Node:
	var cfg: Dictionary = preset_or_config if preset_or_config is Dictionary else idle_preset(preset_or_config)
	var node = load("res://addons/animforge/idle_variety.gd").new()
	node.setup(player, cfg, seed)
	player.add_child(node)
	return node


static func idle_preset(name: String) -> Dictionary:
	var dir := "res://addons/animforge/presets/idle"
	for f in DirAccess.get_files_at(dir):
		if f.ends_with(".json"):
			for p in JSON.parse_string(FileAccess.get_file_as_string(dir + "/" + f))["presets"]:
				if p["name"] == name:
					return p
	push_error("AnimForge: нет idle-пресета «%s»" % name)
	return {}
