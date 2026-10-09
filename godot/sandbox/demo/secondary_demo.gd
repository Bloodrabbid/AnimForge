# Вторичная динамика вживую: два рабочих рывками разворачиваются на месте и отскакивают. Слева уши — по записи
# клипа (как в glb), справа — от настоящего движения (live_secondary). Godot --path godot/sandbox res://demo/secondary_demo.tscn
extends Node3D

var rigs := []
var t := 0.0
var h := 1.0


func _ready() -> void:
	for k in 2:
		var holder := Node3D.new()
		add_child(holder)
		var model: Node3D = load("res://demo/worker.glb").instantiate()
		holder.add_child(model)
		var sk: Skeleton3D = model.find_children("*", "Skeleton3D", true, false)[0]
		var live := AnimForgeLive.new()
		sk.add_child(live)
		live.data_file = "res://demo/worker.af.json"
		live.play("walk")
		live.playing = false
		live.time = 0.0
		live.live_secondary = k == 1
		if k == 0:
			var lo := INF
			var hi := -INF
			for i in sk.get_bone_count():
				var y := (sk.global_transform * sk.get_bone_global_rest(i).origin).y
				lo = minf(lo, y)
				hi = maxf(hi, y)
			h = hi - lo
		rigs.append(holder)
	rigs[0].position = Vector3(-h * 0.75, 0, 0)
	rigs[1].position = Vector3(h * 0.75, 0, 0)
	var cam := Camera3D.new()
	cam.fov = 40
	add_child(cam)
	cam.look_at_from_position(Vector3(0, h * 0.9, h * 3.4), Vector3(0, h * 0.55, 0))
	var sun := DirectionalLight3D.new()
	sun.rotation_degrees = Vector3(-50, 25, 0)
	sun.shadow_enabled = true
	add_child(sun)
	var env := WorldEnvironment.new()
	env.environment = Environment.new()
	env.environment.background_mode = Environment.BG_COLOR
	env.environment.background_color = Color(0.8, 0.82, 0.85)
	env.environment.ambient_light_source = Environment.AMBIENT_SOURCE_COLOR
	env.environment.ambient_light_color = Color(0.55, 0.55, 0.6)
	add_child(env)
	var floor := MeshInstance3D.new()
	var pm := PlaneMesh.new()
	pm.size = Vector2(h * 10, h * 10)
	floor.mesh = pm
	var fm := StandardMaterial3D.new()
	fm.albedo_color = Color(0.62, 0.62, 0.6)
	floor.material_override = fm
	add_child(floor)
	var ui := CanvasLayer.new()
	add_child(ui)
	for k in 2:
		var l := Label.new()
		l.text = ["уши — запись клипа (как в glb)", "уши — живые: от разворота и прыжка"][k]
		l.position = Vector2(60 + k * 600, 20)
		l.add_theme_font_size_override("font_size", 22)
		l.add_theme_color_override("font_color", Color(0.08, 0.08, 0.1))
		ui.add_child(l)


func _process(delta: float) -> void:
	t += delta
	# каждые 1.6 с: резкий разворот на 120° за 0.18 с (туда, потом обратно), затем подскок на 0.3 роста
	var c := fmod(t, 1.6)
	var u := clampf(c / 0.18, 0.0, 1.0)
	u = u * u * (3.0 - 2.0 * u)
	var yaw := deg_to_rad(120.0) * (u if int(t / 1.6) % 2 == 0 else 1.0 - u)
	var hop := 0.0
	if c > 0.8 and c < 1.2:
		var j := (c - 0.8) / 0.4
		hop = h * 0.3 * 4.0 * j * (1.0 - j)
	for r in rigs:
		r.rotation.y = yaw
		r.position.y = hop
