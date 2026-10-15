# Стили походки (clip.gait) на одной ходьбе: обычная, прогулка, быстрым шагом, тяжело, крадётся. Каждый идёт со
# своей естественной скоростью, стопа зафиксирована. Запуск: Godot --path godot/sandbox res://demo/gait_demo.tscn
extends Node3D

const CLIPS := [["walk_april_lock", "как есть"], ["walk_april_style_stroll", "stroll"], ["walk_april_style_brisk", "brisk"], ["walk_april_style_heavy", "heavy"], ["walk_april_style_sneak", "sneak"]]
var walkers := []
var h := 1.0


func _ready() -> void:
	for k in CLIPS.size():
		var mover := Node3D.new()
		add_child(mover)
		var model: Node3D = load("res://demo/worker.glb").instantiate()
		mover.add_child(model)
		var sk: Skeleton3D = model.find_children("*", "Skeleton3D", true, false)[0]
		var live := AnimForgeLive.new()
		sk.add_child(live)
		live.data_file = "res://demo/worker.af.json"
		live.play(CLIPS[k][0])
		if k == 0:
			var lo := INF
			var hi := -INF
			for i in sk.get_bone_count():
				var y := (sk.global_transform * sk.get_bone_global_rest(i).origin).y
				lo = minf(lo, y)
				hi = maxf(hi, y)
			h = hi - lo
		var label := Label3D.new()
		label.text = CLIPS[k][1]
		label.font_size = 48
		label.modulate = Color(0.2, 0.22, 0.25)
		label.billboard = BaseMaterial3D.BILLBOARD_ENABLED
		mover.add_child(label)
		walkers.append({"mover": mover, "live": live, "label": label, "x": (k - 2) * 1.0})
	for w in walkers:
		w["mover"].position = Vector3(w["x"] * h, 0, 0)
		w["label"].position = Vector3(0, h * 1.15, 0)
	var floor_mesh := MeshInstance3D.new()
	var pm := PlaneMesh.new()
	pm.size = Vector2(h * 8, h * 14)
	floor_mesh.mesh = pm
	var fm := StandardMaterial3D.new()
	fm.albedo_color = Color(0.86, 0.87, 0.88)
	floor_mesh.material_override = fm
	add_child(floor_mesh)
	var cam := Camera3D.new()
	cam.fov = 45
	add_child(cam)
	cam.position = Vector3(h * 1.0, h * 2.6, h * 7.5)
	cam.look_at(Vector3(0, 0, h * 2.2), Vector3.UP)
	var sun := DirectionalLight3D.new()
	sun.rotation_degrees = Vector3(-55, 35, 0)
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
		mover.global_position += live.travel_direction() * live.natural_speed() * delta
		if mover.global_position.z > h * 5.0:
			mover.global_position.z = 0.0
