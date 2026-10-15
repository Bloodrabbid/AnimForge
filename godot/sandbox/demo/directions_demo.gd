# 8 направлений из одной прямой ходьбы (clip.directions): рабочие идут звездой, все смотрят вперёд (на камеру сбоку) —
# стрейф, назад, диагонали. Скорость — естественная для клипа, направление — travel_direction(): ноги не скользят.
# Запуск: Godot --path godot/sandbox res://demo/directions_demo.tscn  (WALK=walk1 — мультяшная вразвалку)
extends Node3D

const DIRS := ["fwd", "fwd_l", "left", "back_l", "back", "back_r", "right", "fwd_r"]
var walkers := []
var span := 1.0


func _ready() -> void:
	var walk := OS.get_environment("WALK") if OS.get_environment("WALK") != "" else "walk_april"
	var h := 1.0
	for k in DIRS.size():
		var mover := Node3D.new()
		add_child(mover)
		var model: Node3D = load("res://demo/worker.glb").instantiate()
		mover.add_child(model)
		var sk: Skeleton3D = model.find_children("*", "Skeleton3D", true, false)[0]
		var live := AnimForgeLive.new()
		sk.add_child(live)
		live.data_file = "res://demo/worker.af.json"
		live.play("%s_%s" % [walk, DIRS[k]])
		if k == 0:
			var lo := INF
			var hi := -INF
			for i in sk.get_bone_count():
				var y := (sk.global_transform * sk.get_bone_global_rest(i).origin).y
				lo = minf(lo, y)
				hi = maxf(hi, y)
			h = hi - lo
		walkers.append({"mover": mover, "live": live, "name": DIRS[k]})
	span = h * 2.2
	var floor_mesh := MeshInstance3D.new()
	var pm := PlaneMesh.new()
	pm.size = Vector2(span * 3, span * 3)
	floor_mesh.mesh = pm
	var fm := StandardMaterial3D.new()
	fm.albedo_color = Color(0.82, 0.84, 0.86)
	floor_mesh.material_override = fm
	add_child(floor_mesh)
	# лучи-направления на полу
	for w in walkers:
		var d: Vector3 = w["live"].travel_direction()
		var line := MeshInstance3D.new()
		var bm := BoxMesh.new()
		bm.size = Vector3(h * 0.02, 0.002, span)
		line.mesh = bm
		var lm := StandardMaterial3D.new()
		lm.albedo_color = Color(0.55, 0.6, 0.68)
		line.material_override = lm
		add_child(line)
		line.global_position = d * span * 0.5 + Vector3(0, 0.001, 0)
		line.look_at(line.global_position + d, Vector3.UP)
	var cam := Camera3D.new()
	cam.fov = 45
	add_child(cam)
	cam.global_position = Vector3(span * 1.1, span * 2.1, span * 1.4)
	cam.look_at(Vector3.ZERO, Vector3.UP)
	var sun := DirectionalLight3D.new()
	sun.rotation_degrees = Vector3(-60, 35, 0)
	sun.shadow_enabled = true
	add_child(sun)
	var env := WorldEnvironment.new()
	env.environment = Environment.new()
	env.environment.background_mode = Environment.BG_COLOR
	env.environment.background_color = Color(0.93, 0.94, 0.95)
	env.environment.ambient_light_color = Color(0.7, 0.7, 0.72)
	env.environment.ambient_light_source = Environment.AMBIENT_SOURCE_COLOR
	add_child(env)


func _process(delta: float) -> void:
	for w in walkers:
		var live: AnimForgeLive = w["live"]
		var mover: Node3D = w["mover"]
		var d := live.travel_direction()
		# старт не из центра — чтобы не толпились; дошёл до края — обратно
		if mover.global_position.length() < 1e-6 or mover.global_position.length() > span:
			mover.global_position = d * span * 0.3
		mover.global_position += d * live.natural_speed() * delta
