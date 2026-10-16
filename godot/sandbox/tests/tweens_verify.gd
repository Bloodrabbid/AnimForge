# Сверка аддона с ядром: выборки пресетов из TS (samples.json) против AnimForge.sample, плюс живой твин на Control.
# godot --headless --path godot/sandbox --script res://tests/tweens_verify.gd -- <samples.json>
extends SceneTree

const AF = preload("res://addons/animforge/animforge.gd")
const TOL := 1e-4


func _initialize() -> void:
	var path: String = OS.get_cmdline_user_args()[0]
	var data: Dictionary = JSON.parse_string(FileAccess.get_file_as_string(path))
	var worst := 0.0
	var where := ""
	var n := 0
	for name in data:
		var p := AF.preset(name)
		for row in data[name]:
			var got := AF.sample(p, row["t"])
			for k in row["v"]:
				var err := absf(float(got.get(k, INF)) - float(row["v"][k]))
				n += 1
				if err > worst:
					worst = err
					where = "%s t=%.3f %s: godot %s, ядро %s" % [name, row["t"], k, got.get(k), row["v"][k]]
	print("SAMPLES %d, худшее расхождение %.7f %s" % [n, worst, where])
	await process_frame  # до первого кадра корень ещё не в дереве и твины узлов не шагают
	var live := _live_check()
	if live.begins_with("LIVE_OK"):
		live = _live_camera()
	if live.begins_with("LIVE_OK"):
		print(live)
		live = _live_node()
	if live.begins_with("LIVE_OK"):
		print(live)
		live = await _events_check()
	if live.begins_with("LIVE_OK"):
		print(live)
		live = _idle_check()
	print(live)
	print("TWEENS_OK" if worst <= TOL and live.begins_with("LIVE_OK") else "TWEENS_FAIL")
	quit()


# Настоящий Tween на Control: шагаем вручную и сверяем свойства узла с формулой.
func _live_check() -> String:
	var c := Control.new()
	c.size = Vector2(200, 100)
	c.position = Vector2(50, 60)
	root.add_child(c)
	var p := AF.preset("jump_spin")
	var tw: Tween = AF.play(c, "jump_spin")
	tw.pause()
	var t := 0.0
	for dt in [0.1, 0.2, 0.15, 0.13]:
		tw.custom_step(dt)
		t += dt
		var s := AF.sample(p, t)
		var exp_y: float = 60 + s["y"]
		var exp_scale: float = s["scale"]
		if absf(c.position.y - exp_y) > 1e-3 or absf(c.scale.x - exp_scale) > 1e-4 or absf(c.rotation_degrees - s["rotation"]) > 1e-3:
			return "LIVE_FAIL t=%.2f y=%s (ждали %s) scale=%s (ждали %s)" % [t, c.position.y, exp_y, c.scale.x, exp_scale]
	tw.custom_step(1.0)
	if not tw.is_valid() or not tw.is_running():
		if absf(c.position.y - 60) < 1e-3 and absf(c.scale.x) < 1e-4:
			return "LIVE_OK pivot=%s" % [c.pivot_offset]
	return "LIVE_FAIL в конце y=%s scale=%s" % [c.position.y, c.scale.x]


# Камера: наклон и наезд (pitch, dolly) от исходного положения.
func _live_camera() -> String:
	var cam := Camera3D.new()
	cam.position = Vector3(0, 2, 5)
	cam.rotation_degrees = Vector3(-10, 0, 0)
	root.add_child(cam)
	var p := AF.preset("biped_level_intro")
	var fwd := -cam.transform.basis.z
	var tw: Tween = AF.play(cam, "biped_level_intro")
	tw.pause()
	tw.custom_step(3.0)
	var s := AF.sample(p, 3.0)
	var exp_pos := Vector3(0, 2, 5) + fwd * float(s["dolly"])
	if absf(cam.rotation_degrees.x - (-10 + float(s["pitch"]))) > 1e-3 or cam.position.distance_to(exp_pos) > 1e-3:
		return "LIVE_FAIL камера pitch=%s pos=%s (ждали %s, %s)" % [cam.rotation_degrees.x, cam.position, -10 + float(s["pitch"]), exp_pos]
	return "LIVE_OK камера: pitch %.2f°, наезд %.2f м" % [cam.rotation_degrees.x, s["dolly"]]


# Узел (target «node»): стая — выскок вверх, разворот на 90°, рывок вперёд по новому взгляду.
func _live_node() -> String:
	var n := Node3D.new()
	n.position = Vector3(1, 0, 2)
	root.add_child(n)
	var tw: Tween = AF.play(n, "breathedge-swarm-launch")
	tw.pause()
	tw.custom_step(4.0)
	# повернулся на 90° влево (вокруг +Y): взгляд −Z стал −X, рывок 735 м туда; выскок 7 м
	var exp := Vector3(1 - 735, 7, 2)
	if absf(n.rotation_degrees.y - 90) > 1e-3 or n.position.distance_to(exp) > 1e-2:
		return "LIVE_FAIL узел yaw=%s pos=%s (ждали 90, %s)" % [n.rotation_degrees.y, n.position, exp]
	var msg := "узел: yaw %.1f°, путь %.1f м" % [n.rotation_degrees.y, n.position.distance_to(Vector3(1, 7, 2))]
	# дуга: курс исходно 30°, за 15 с повернул ещё на 90° и прошёл 732 м по дуге — смещение из выборки, повёрнутое на 30°
	var m := Node3D.new()
	m.position = Vector3(1, 0, 2)
	m.rotation_degrees.y = 30
	root.add_child(m)
	var tw2: Tween = AF.play(m, "breathedge-swarm-cruise")
	tw2.pause()
	tw2.custom_step(15.0)
	var s := AF.sample(AF.preset("breathedge-swarm-cruise"), 15.0)
	var b := deg_to_rad(30.0)
	var exp2 := Vector3(1 + s["travel_x"] * cos(b) + s["travel_z"] * sin(b), 0, 2 - s["travel_x"] * sin(b) + s["travel_z"] * cos(b))
	if absf(m.rotation_degrees.y - 120) > 1e-3 or m.position.distance_to(exp2) > 1e-2 or absf(s["travel_x"]) < 300 or absf(s["travel_z"]) < 300:
		return "LIVE_FAIL дуга yaw=%s pos=%s (ждали 120, %s)" % [m.rotation_degrees.y, m.position, exp2]
	return "LIVE_OK %s; дуга: смещение %.1f м по прямой" % [msg, m.position.distance_to(Vector3(1, 0, 2))]


class Catcher extends Node:
	var got: Array = []
	func animforge_event(name: String, clip: String) -> void:
		got.append([snappedf(owner_time.call(), 0.001), name, clip])
	var owner_time: Callable


# События: JSON → дорожка методов; проигрываем вручную и ловим вызовы в нужные моменты.
func _events_check() -> String:
	var player := AnimationPlayer.new()
	var lib := AnimationLibrary.new()
	var anim := Animation.new()
	anim.length = 1.0
	lib.add_animation("strike", anim)
	player.add_animation_library("", lib)
	player.callback_mode_method = AnimationMixer.ANIMATION_CALLBACK_MODE_METHOD_IMMEDIATE  # в тесте кадры не идут
	root.add_child(player)
	var c := Catcher.new()
	player.add_child(c)
	c.owner_time = func(): return player.current_animation_position
	var path := "user://events_test.json"
	var f := FileAccess.open(path, FileAccess.WRITE)
	f.store_string(JSON.stringify({"strike": [{"t": 0.25, "name": "whoosh"}, {"t": 0.4, "name": "hit"}], "other": [{"t": 0.1, "name": "x"}]}))
	f.close()
	var n := AF.attach_events(player, path, c)
	player.play("strike")
	for i in 60:
		player.advance(1.0 / 60.0)
	var want := [[0.25, "whoosh", "strike"], [0.4, "hit", "strike"]]
	if n != 2 or c.got.size() != 2 or c.got[0][1] != "whoosh" or c.got[1][1] != "hit" or absf(c.got[1][0] - 0.4) > 1.0 / 60.0 + 1e-3:
		return "LIVE_FAIL события: вставлено %d, поймано %s (ждали %s)" % [n, c.got, want]
	return "LIVE_OK события: %s" % [c.got]


# Вставки в idle: детерминированный прогон 3000 с; кулдауны соблюдены, частота частой вставки ≈ её шансу.
func _idle_check() -> String:
	var player := AnimationPlayer.new()
	var lib := AnimationLibrary.new()
	var cfg := AF.idle_preset("witcher-geralt")
	for name in ["idle"] + cfg["inserts"].map(func(i): return i["clip"]):
		var a := Animation.new()
		a.length = 1.0 if name == "idle" else 2.0
		lib.add_animation(name, a)
	player.add_animation_library("", lib)
	root.add_child(player)
	player.play("idle")
	var node = AF.idle_variety(player, cfg, 7)
	node.manual = true
	for i in 30000:
		node.step(0.1)
	var last := {}
	var prev_end := -1e9
	var count := {}
	for e in node.log:
		var ins = cfg["inserts"].filter(func(x): return x["clip"] == e["clip"])[0]
		if last.has(e["clip"]) and e["t"] - last[e["clip"]] < float(ins.get("cooldown", 0.0)) - 1e-6:
			return "LIVE_FAIL кулдаун %s: %.1f → %.1f" % [e["clip"], last[e["clip"]], e["t"]]
		if e["t"] - prev_end < float(cfg["global_cooldown"]) - 1e-6:
			return "LIVE_FAIL общий кулдаун: вставка в %.1f через %.1f с после конца прошлой" % [e["t"], e["t"] - prev_end]
		last[e["clip"]] = e["t"]
		prev_end = e["t"] + 2.0
		count[e["clip"]] = count.get(e["clip"], 0) + 1
	# проверок за прогон: ~ 3000 / (вставка 2 с + общий кулдаун 2 с + проверка 1 с) в худшем случае; частая вставка — ≈ 10 % проверок
	var total: int = node.log.size()
	var p1: int = count.get("pose_pause1", 0)
	if total < 100 or p1 < total * 0.35:
		return "LIVE_FAIL частоты: всего %d, pose_pause1 %d — %s" % [total, p1, count]
	return "LIVE_OK idle: %d вставок за 3000 с, %s" % [total, count]
