# Фиксация опорной стопы: два рабочих идут с естественной скоростью клипа, стопы оставляют следы на полу.
# Слева — без фиксации (следы размазаны: стопа едет по полу), справа — с ground.lock (следы — точки).
# Запуск: Godot --path godot/sandbox res://demo/lock_demo.tscn
extends Node3D

var walkers := []
var h := 1.0


func _ready() -> void:
	for k in 2:
		var mover := Node3D.new()
		add_child(mover)
		var model: Node3D = load("res://demo/worker.glb").instantiate()
		mover.add_child(model)
		var sk: Skeleton3D = model.find_children("*", "Skeleton3D", true, false)[0]
		var live := AnimForgeLive.new()
		sk.add_child(live)
		live.data_file = "res://demo/worker.af.json"
		live.play("walk_april_lock" if k == 1 else "walk_april")
		if k == 0:
			var lo := INF
			var hi := -INF
			for i in sk.get_bone_count():
				var y := (sk.global_transform * sk.get_bone_global_rest(i).origin).y
				lo = minf(lo, y)
				hi = maxf(hi, y)
			h = hi - lo
		var feet := []
		for b in ["foot_l", "foot_r"]:
			feet.append(sk.find_bone(b))
		var wd := {"mover": mover, "live": live, "sk": sk, "feet": feet, "x": (k - 0.5) * h * 0.9, "rest": 0.0}
		# позы модификатора есть только во время обновления скелета — следы читаем там
		sk.skeleton_updated.connect(_mark.bind(wd))
		walkers.append(wd)
	for w in walkers:
		w["mover"].position = Vector3(w["x"], 0, 0)
	var floor_mesh := MeshInstance3D.new()
	var pm := PlaneMesh.new()
	pm.size = Vector2(h * 6, h * 12)
	floor_mesh.mesh = pm
	var fm := StandardMaterial3D.new()
	fm.albedo_color = Color(0.86, 0.87, 0.88)
	floor_mesh.material_override = fm
	add_child(floor_mesh)
	var cam := Camera3D.new()
	cam.fov = 40
	add_child(cam)
	cam.position = Vector3(h * 2.2, h * 2.0, h * 4.6)
	cam.look_at(Vector3(0, 0, h * 2.2), Vector3.UP)
	var sun := DirectionalLight3D.new()
	sun.rotation_degrees = Vector3(-60, 35, 0)
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
		mover.global_position += live.travel_direction() * live.natural_speed() * delta
		if mover.global_position.z > h * 4.5:
			mover.global_position.z = 0.0


func _mark(w: Dictionary) -> void:
	var sk: Skeleton3D = w["sk"]
	if w["rest"] == 0.0:
		w["rest"] = (sk.global_transform * sk.get_bone_global_rest(w["feet"][0]).origin).y
	for b in w["feet"]:
		var p := sk.global_transform * sk.get_bone_global_pose(b).origin
		# стопа на полу (на высоте покоя) — точка следа
		if p.y < w["rest"] + h * 0.003:
			var dot := MeshInstance3D.new()
			var cm := CylinderMesh.new()
			cm.top_radius = h * 0.01
			cm.bottom_radius = h * 0.01
			cm.height = 0.001
			dot.mesh = cm
			var mm := StandardMaterial3D.new()
			mm.albedo_color = Color(0.85, 0.3, 0.2) if b == w["feet"][0] else Color(0.2, 0.4, 0.85)
			dot.material_override = mm
			add_child(dot)
			dot.global_position = Vector3(p.x, 0.002, p.z)
