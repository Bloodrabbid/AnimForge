# Узел AnimForgeLive в сцене (без окна): стопа встаёт на ступеньку лучом, шаг ускоряется под скорость, голова — на цель.
# Godot --headless --path godot/sandbox --script res://tests/live_node_verify.gd
extends SceneTree

var bad := []


func _initialize() -> void:
	_run.call_deferred()


func _make(terrain: bool) -> Array:
	var model: Node3D = load("res://demo/worker.glb").instantiate()
	root.add_child(model)
	var sk: Skeleton3D = model.find_children("*", "Skeleton3D", true, false)[0]
	var live := AnimForgeLive.new()
	sk.add_child(live)
	live.data_file = "res://demo/worker.af.json"
	live.play("walk")
	live.playing = false
	live.terrain = terrain
	_watch(sk)
	return [model, sk, live]


## Поза после модификаторов живёт только внутри обновления скелета — снимаем её в сигнале skeleton_updated.
var snap := {}


func _watch(sk: Skeleton3D) -> void:
	snap[sk] = {}
	sk.skeleton_updated.connect(func():
		for n in ["foot_l", "foot_r", "head"]:
			snap[sk][n] = sk.global_transform * sk.get_bone_global_pose(sk.find_bone(n)))


func _foot_y(sk: Skeleton3D, name: String) -> float:
	return snap[sk][name].origin.y


func _run() -> void:
	# ступенька под левой стопой: верх на 6 % роста выше пола
	var a := _make(false)
	var sk: Skeleton3D = a[1]
	var live: AnimForgeLive = a[2]
	await process_frame
	await process_frame
	var h: float = live.rig.heights[AFCore.SIZE]
	var flat_l := _foot_y(sk, "foot_l")
	var flat_r := _foot_y(sk, "foot_r")
	var foot: Vector3 = snap[sk]["foot_l"].origin
	var rest_y: float = (sk.global_transform * sk.get_bone_global_rest(sk.find_bone("foot_l")).origin).y
	var step := StaticBody3D.new()
	var cs := CollisionShape3D.new()
	var box := BoxShape3D.new()
	box.size = Vector3(h * 0.3, h * 0.2, h * 0.3)
	cs.shape = box
	step.add_child(cs)
	root.add_child(step)
	var top := rest_y + h * 0.06
	step.global_position = Vector3(foot.x, top - h * 0.1, foot.z)
	a[0].queue_free()
	var b := _make(true)
	await physics_frame
	await process_frame
	await process_frame
	var sk2: Skeleton3D = b[1]
	var yl := _foot_y(sk2, "foot_l")
	var dr := _foot_y(sk2, "foot_r") - flat_r
	# левая стопа (она в шаге и была приподнята) — ровно на верху ступеньки: высота покоя + 6 %;
	# правая остаётся у пола (тело не задрано)
	_check("стопа на ступеньке: %.3f над покоем из %.3f (без ступеньки %.3f)" % [yl - rest_y, h * 0.06, flat_l - rest_y], absf(yl - top) < h * 0.005 and flat_l < top - h * 0.01)
	_check("вторая стопа у пола: %.3f" % dr, absf(dr) < h * 0.01)

	# шаг под скорость: вдвое быстрее естественной — клип идёт вдвое быстрее
	var live2: AnimForgeLive = b[2]
	var nat := live2.natural_speed()
	live2.match_speed = true
	live2.move_speed = nat * 2.0
	live2.playing = true
	live2.time = 0.0
	live2._process(0.1)
	_check("темп ×2: время %.3f из 0.200 (естественная %.3f м/с)" % [live2.time, nat], nat > 0 and absf(live2.time - 0.2) < 1e-6)

	# взгляд: голова поворачивается к цели сбоку
	var target := Node3D.new()
	root.add_child(target)
	var head_i := sk2.find_bone("head")
	var hp: Vector3 = snap[sk2]["head"].origin
	var fwd := (sk2.global_transform.basis * (live2._K.basis * AFCore.body_frame(live2.rig).forward)).normalized()
	var side := fwd.cross(Vector3.UP).normalized()
	target.global_position = hp + fwd * h + side * h
	live2.playing = false
	# «вперёд» головы: направление тела в покое, повёрнутое тем, насколько голова ушла от покоя
	var rest_b := sk2.global_transform.basis * sk2.get_bone_global_rest(head_i).basis
	var f_rest := fwd
	var before: Vector3 = (snap[sk2]["head"].basis * rest_b.inverse() * f_rest).normalized()
	live2.look_target = target
	await process_frame
	await process_frame
	var after: Vector3 = (snap[sk2]["head"].basis * rest_b.inverse() * f_rest).normalized()
	var want := (target.global_position - hp).normalized()
	_check("взгляд: до цели %.0f°, было %.0f°" % [rad_to_deg(after.angle_to(want)), rad_to_deg(before.angle_to(want))], after.angle_to(want) < before.angle_to(want) - deg_to_rad(10))
	print("LIVE_NODE_OK" if bad.is_empty() else "LIVE_NODE_FAIL " + ", ".join(bad))
	quit()


func _check(what: String, ok: bool) -> void:
	print("NODE %s %s" % ["ok" if ok else "BAD", what])
	if not ok:
		bad.append(what)
