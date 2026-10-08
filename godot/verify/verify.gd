# Проверка glb из AnimForge в Godot: анимация есть, длина верная, повороты костей совпадают с эталоном ядра.
# godot --headless --path godot/verify --script verify.gd -- <file.glb> <file.samples.json>
extends SceneTree

const TOL_POS := 0.0005  # м и доли масштаба; между ключами LINEAR против точного значения
const TOL := 0.002  # допуск по |q_godot - q_core| (с учётом q ≡ -q); между ключами LINEAR против точного значения

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
	var worst_pos := 0.0  # сдвиги (м) и масштабы — общий допуск TOL_POS
	var checked_pos := 0
	var where := ""
	var where_pos := ""
	var missing := {}
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
				var bi := _bone(skel, bone, missing)
				if bi < 0: continue
				var got := skel.get_bone_pose_rotation(bi)
				var d := minf((got - want).length(), (got + want).length())
				if d > worst: where = "%s t=%.3f поворот" % [bone, c.t]
				worst = maxf(worst, d)
				checked += 1
			for bone in c.get("positions", {}):
				var v: Array = c.positions[bone]
				var bi := _bone(skel, bone, missing)
				if bi < 0: continue
				var dp := (skel.get_bone_pose_position(bi) - Vector3(v[0], v[1], v[2])).length()
				if dp > worst_pos: where_pos = "%s t=%.3f сдвиг godot %s, ядро %s" % [bone, c.t, skel.get_bone_pose_position(bi), v]
				worst_pos = maxf(worst_pos, dp)
				checked_pos += 1
			for bone in c.get("scales", {}):
				var v: Array = c.scales[bone]
				var bi := _bone(skel, bone, missing)
				if bi < 0: continue
				var ds := (skel.get_bone_pose_scale(bi) - Vector3(v[0], v[1], v[2])).length()
				if ds > worst_pos: where_pos = "%s t=%.3f масштаб godot %s, ядро %s" % [bone, c.t, skel.get_bone_pose_scale(bi), v]
				worst_pos = maxf(worst_pos, ds)
				checked_pos += 1
	print("VERIFY проверено поворотов: %d, худшее расхождение: %.4f (допуск %.3f) %s" % [checked, worst, TOL, where])
	print("VERIFY проверено сдвигов и масштабов: %d, худшее расхождение: %.4f (допуск %.4f) %s" % [checked_pos, worst_pos, TOL_POS, where_pos])
	if missing:
		print("VERIFY нет костей в Skeleton3D: %s" % [missing.keys()])
	var ok := worst <= TOL and worst_pos <= TOL_POS and not missing
	print("VERIFY_OK" if ok else "VERIFY_FAIL")
	quit(0 if ok else 1)

# Godot при импорте заменяет в именах костей «:» и «/» на «_» (mixamorig:Hips → mixamorig_Hips)
func _bone(skel: Skeleton3D, name: String, missing: Dictionary) -> int:
	var i := skel.find_bone(name)
	if i < 0:
		i = skel.find_bone(name.replace(":", "_").replace("/", "_"))
	if i < 0:
		missing[name] = true
	return i

func _fail(msg: String) -> void:
	print("VERIFY_FAIL ", msg)
	quit(1)
