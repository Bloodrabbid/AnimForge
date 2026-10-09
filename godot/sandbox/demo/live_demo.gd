# Демо живых рецептов: рабочий идёт с меняющейся скоростью (шаг подстраивается), по склону и ступенькам
# (стопы на рельеф лучами), провожает взглядом мяч. Запуск: открыть сцену и F6, или
#   Godot --path godot/sandbox res://demo/live_demo.tscn
extends Node3D

var live: AnimForgeLive
var mover: Node3D
var ball: MeshInstance3D
var cam: Camera3D
var label: Label
var fwd := Vector3.FORWARD
var t := 0.0
var h := 1.0


func _ready() -> void:
	mover = Node3D.new()
	add_child(mover)
	var model: Node3D = load("res://demo/worker.glb").instantiate()
	mover.add_child(model)
	var sk: Skeleton3D = model.find_children("*", "Skeleton3D", true, false)[0]
	live = AnimForgeLive.new()
	sk.add_child(live)
	live.data_file = "res://demo/worker.af.json"
	live.play("walk")
	live.match_speed = true
	live.body = mover
	live.terrain = true
	# рост и направление «вперёд» модели — по костям в покое
	var lo := INF
	var hi := -INF
	for i in sk.get_bone_count():
		var y := (sk.global_transform * sk.get_bone_global_rest(i).origin).y
		lo = minf(lo, y)
		hi = maxf(hi, y)
	h = hi - lo
	fwd = (sk.global_transform.basis * (live._K.basis * AFCore.body_frame(live.rig).forward)).normalized()
	fwd.y = 0
	fwd = fwd.normalized()
	_build_world(lo)
	ball = MeshInstance3D.new()
	var sm := SphereMesh.new()
	sm.radius = h * 0.08
	sm.height = h * 0.16
	ball.mesh = sm
	var bm := StandardMaterial3D.new()
	bm.albedo_color = Color(0.85, 0.3, 0.2)
	ball.material_override = bm
	add_child(ball)
	live.look_target = ball
	cam = Camera3D.new()
	cam.fov = 40
	add_child(cam)
	var sun := DirectionalLight3D.new()
	sun.rotation_degrees = Vector3(-55, 30, 0)
	sun.shadow_enabled = true
	add_child(sun)
	var env := WorldEnvironment.new()
	env.environment = Environment.new()
	env.environment.background_mode = Environment.BG_COLOR
	env.environment.background_color = Color(0.8, 0.82, 0.85)
	env.environment.ambient_light_source = Environment.AMBIENT_SOURCE_COLOR
	env.environment.ambient_light_color = Color(0.55, 0.55, 0.6)
	add_child(env)
	var ui := CanvasLayer.new()
	add_child(ui)
	label = Label.new()
	label.position = Vector2(20, 14)
	label.add_theme_font_size_override("font_size", 20)
	label.add_theme_color_override("font_color", Color(0.08, 0.08, 0.1))
	ui.add_child(label)


## Пол, склон вверх, плато и три ступеньки вниз по ходу — статические тела, лучи стоп их видят.
func _build_world(floor_y: float) -> void:
	var up := Vector3.UP
	_box(Transform3D(Basis.looking_at(fwd, up), Vector3(0, floor_y - h * 0.1, 0)), Vector3(h * 40, h * 0.2, h * 40), Color(0.62, 0.62, 0.6))
	var stone := Color(0.56, 0.5, 0.44)
	var rise := h * 0.22
	var a := fwd * (h * 2.0)  # начало склона
	var ramp := h * 2.5
	var dir := (fwd * ramp + up * rise).normalized()
	var len := sqrt(ramp * ramp + rise * rise)
	var th := h * 0.1
	var n := dir.cross(fwd.cross(up).normalized() * -1.0).normalized()  # нормаль склона
	if n.y < 0:
		n = -n
	_box(Transform3D(Basis.looking_at(dir, up), a + Vector3(0, floor_y, 0) + dir * len / 2 - n * th / 2), Vector3(h * 1.6, th, len), stone)
	var plat := h * 1.6
	_box(Transform3D(Basis.looking_at(fwd, up), a + fwd * (ramp + plat / 2) + Vector3(0, floor_y + rise / 2, 0)), Vector3(h * 1.6, rise, plat), stone)
	for k in 2:
		var top := rise * (2 - k) / 3.0
		_box(Transform3D(Basis.looking_at(fwd, up), a + fwd * (ramp + plat + h * 0.35 * (k + 0.5)) + Vector3(0, floor_y + top / 2, 0)), Vector3(h * 1.6, top, h * 0.35), stone.darkened(0.08 * (k + 1)))


func _box(xf: Transform3D, size: Vector3, color: Color) -> void:
	var body := StaticBody3D.new()
	var shape := CollisionShape3D.new()
	var bs := BoxShape3D.new()
	bs.size = size
	shape.shape = bs
	body.add_child(shape)
	var mi := MeshInstance3D.new()
	var bm := BoxMesh.new()
	bm.size = size
	mi.mesh = bm
	var mat := StandardMaterial3D.new()
	mat.albedo_color = color
	mi.material_override = mat
	body.add_child(mi)
	add_child(body)
	body.global_transform = xf


func _process(delta: float) -> void:
	t += delta
	# скорость: разгон и торможение (доли естественной), потом ровно по рельефу
	var nat := live.natural_speed()
	var k := 0.95 + 0.45 * sin(t * 1.3) if t < 4.0 else 0.85
	mover.global_position += fwd * nat * k * delta
	var p := mover.global_position
	var side := fwd.cross(Vector3.UP).normalized()
	ball.global_position = p + fwd * h * 1.6 + side * h * 1.2 * sin(t * 0.9) + Vector3.UP * h * (0.8 + 0.35 * sin(t * 0.6))
	# камера сбоку, чуть впереди: видно ноги на склоне и голову
	cam.global_position = p - side * h * 2.8 + Vector3.UP * h * 0.8 + fwd * h * 1.3
	cam.look_at(p + Vector3.UP * h * 0.45 + fwd * h * 0.3)
	label.text = "Godot · AnimForgeLive · рабочий, живая ходьба\nскорость %.2f м/с — шаг подстроен (естественная %.2f), стопы на рельеф, взгляд на мяч" % [nat * k, nat]
