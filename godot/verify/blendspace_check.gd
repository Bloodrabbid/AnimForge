# Проверка BlendSpace2D из export.directions: в вершинах пространства поза — ровно клип этого направления, между ними —
# смесь (ни один из соседей). Клипы — из общего glb, дерево — из .tres, как у пользователя.
# godot --headless --path godot/verify --script blendspace_check.gd -- <all.glb> <blendspace.tres> <fwd> <left>
extends SceneTree

func _scene(path: String) -> Node:
	var doc := GLTFDocument.new()
	var state := GLTFState.new()
	if doc.append_from_file(path, state) != OK:
		return null
	var s := doc.generate_scene(state)
	root.add_child(s)
	return s

func _pose(skel: Skeleton3D) -> Array:
	var out := []
	for i in skel.get_bone_count():
		out.append(skel.get_bone_global_pose(i).origin)
	return out

func _diff(a: Array, b: Array) -> float:
	var m := 0.0
	for i in a.size():
		m = maxf(m, (a[i] - b[i]).length())
	return m

func _init() -> void:
	# узлы входят в дерево сцены только с первым кадром — проверка после него
	process_frame.connect(_run, CONNECT_ONE_SHOT)

func _run() -> void:
	var args := OS.get_cmdline_user_args()
	var tree_root = ResourceLoader.load(args[1])
	if tree_root == null or not (tree_root is AnimationNodeBlendSpace2D):
		print("BLEND_FAIL .tres не читается как BlendSpace2D")
		quit(1)
		return
	var bs: AnimationNodeBlendSpace2D = tree_root
	print("BLEND точек %d, sync %s" % [bs.get_blend_point_count(), bs.sync])
	var a := _scene(args[0])
	var b := _scene(args[0])
	var pa: AnimationPlayer = a.find_children("*", "AnimationPlayer", true, false)[0]
	var pb: AnimationPlayer = b.find_children("*", "AnimationPlayer", true, false)[0]
	var sa: Skeleton3D = a.find_children("*", "Skeleton3D", true, false)[0]
	var sb: Skeleton3D = b.find_children("*", "Skeleton3D", true, false)[0]
	var len := pb.get_animation(args[2]).length
	var t := 0.37 * len
	# дерево — новое на каждый замер: время в нём с нуля
	var blended := func(pos: Vector2) -> Array:
		var tree := AnimationTree.new()
		a.add_child(tree)
		tree.anim_player = tree.get_path_to(pa)
		tree.tree_root = bs
		tree.callback_mode_process = AnimationMixer.ANIMATION_CALLBACK_MODE_PROCESS_MANUAL
		tree.active = true
		tree.set("parameters/blend_position", pos)
		sa.reset_bone_poses()
		# первый шаг дерева только запускает узлы (время 0), дальше — на t
		tree.advance(0.0)
		tree.advance(t)
		var out := _pose(sa)
		tree.active = false
		tree.queue_free()
		return out
	var clip := func(name: String) -> Array:
		pb.play(name)
		sb.reset_bone_poses()
		pb.seek(t, true)
		return _pose(sb)
	var bad := false
	for c in [[Vector2(0, 1), args[2]], [Vector2(-1, 0), args[3]]]:
		var d := _diff(blended.call(c[0]), clip.call(c[1]))
		print("BLEND %s → %s: расхождение %.5f" % [c[0], c[1], d])
		if d > 1e-3:
			bad = true
	var mid: Array = blended.call(Vector2(-0.7071, 0.7071))
	var df := _diff(mid, clip.call(args[2]))
	var dl := _diff(mid, clip.call(args[3]))
	print("BLEND между: от вперёд %.4f, от влево %.4f" % [df, dl])
	if df < 1e-3 or dl < 1e-3:
		bad = true
	print("BLEND_FAIL" if bad else "BLEND_OK")
	quit(1 if bad else 0)
