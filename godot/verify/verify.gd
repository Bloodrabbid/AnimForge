# Проверка glb из AnimForge в Godot: анимация есть, длина верная, повороты костей совпадают с эталоном ядра.
# godot --headless --path godot/verify --script verify.gd -- <file.glb> <file.samples.json>
extends SceneTree

const TOL := 0.02  # допуск по |q_godot - q_core| (с учётом q ≡ -q); между ключами LINEAR против точного значения

func _init() -> void:
	var args := OS.get_cmdline_user_args()
	var doc := GLTFDocument.new()
	var state := GLTFState.new()
	if doc.append_from_file(args[0], state) != OK:
		_fail("glb не прочитан")
		return
	var scene := doc.generate_scene(state)
	root.add_child(scene)
	var player: AnimationPlayer = scene.find_children("*", "AnimationPlayer", true, false)[0]
	var skel: Skeleton3D = scene.find_children("*", "Skeleton3D", true, false)[0]
	var samples = JSON.parse_string(FileAccess.get_file_as_string(args[1]))
	var worst := 0.0
	var checked := 0
	for clip in samples:
		if not player.has_animation(clip.clip):
			_fail("нет анимации %s, есть %s" % [clip.clip, player.get_animation_list()])
			return
		var anim := player.get_animation(clip.clip)
		print("CLIP %s длина %.3f (ожидалось %.3f), дорожек %d" % [clip.clip, anim.length, clip.duration, anim.get_track_count()])
		if absf(anim.length - clip.duration) > 0.001:
			_fail("длина не совпала")
			return
		player.play(clip.clip)
		for c in clip.checks:
			player.seek(c.t, true)
			for bone in c.rotations:
				var q: Array = c.rotations[bone]
				var want := Quaternion(q[0], q[1], q[2], q[3])
				var got := skel.get_bone_pose_rotation(skel.find_bone(bone))
				var d := minf((got - want).length(), (got + want).length())
				worst = maxf(worst, d)
				checked += 1
	print("VERIFY проверено поворотов: %d, худшее расхождение: %.4f (допуск %.2f)" % [checked, worst, TOL])
	print("VERIFY_OK" if worst <= TOL else "VERIFY_FAIL")
	quit(0 if worst <= TOL else 1)

func _fail(msg: String) -> void:
	print("VERIFY_FAIL ", msg)
	quit(1)
