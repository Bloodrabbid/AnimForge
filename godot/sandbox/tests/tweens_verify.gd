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
