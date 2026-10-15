# Проверка FBX из AnimForge в Godot (ufbx): тейки на месте, длина верная, суставы в мире там же, где у ядра.
# Сверяем положения суставов, а не повороты: Blender при записи FBX меняет оси костей (rest), повороты относительно
# них другие числа, а движение — то же. Godot сам переводит единицы и оси файла в метры и Y вверх — значит, совпадение
# в метрах проверяет и пресет единиц (unreal — сантиметры и Z вверх, unity — масштаб, вшитый в файл).
# godot --headless --path godot/verify --script verify_fbx.gd -- <file.fbx> <file.samples.json>
extends SceneTree

const TOL_REL := 0.005  # доля роста скелета: 0.5 % (между ключами — запекание Blender по кадрам)

func _init() -> void:
	var args := OS.get_cmdline_user_args()
	# glb — тем же путём (проверка самой сверки)
	var glb := args[0].to_lower().ends_with(".glb")
	var doc: GLTFDocument = GLTFDocument.new() if glb else FBXDocument.new()
	var state: GLTFState = GLTFState.new() if glb else FBXState.new()
	if doc.append_from_file(args[0], state) != OK:
		_fail("FBX не прочитан")
		return
	var scene := doc.generate_scene(state)
	root.add_child(scene)
	var players := scene.find_children("*", "AnimationPlayer", true, false)
	var skels := scene.find_children("*", "Skeleton3D", true, false)
	if players.is_empty() or skels.is_empty():
		_fail("в FBX нет %s" % ("анимаций" if players.is_empty() else "скелета"))
		return
	var player: AnimationPlayer = players[0]
	var skel: Skeleton3D = skels[0]
	var samples = JSON.parse_string(FileAccess.get_file_as_string(args[1]))
	var lo := Vector3.INF
	var hi := -Vector3.INF
	for b in samples[0].checks[0].world:
		var v: Array = samples[0].checks[0].world[b]
		lo = lo.min(Vector3(v[0], v[1], v[2])); hi = hi.max(Vector3(v[0], v[1], v[2]))
	var size := maxf((hi - lo).length(), 1e-6)
	var worst := 0.0
	var where := ""
	var checked := 0
	var missing := {}
	var anims := player.get_animation_list()
	for clip in samples:
		var name := _anim(player, clip.clip)
		if name == "":
			_fail("нет тейка %s, есть %s" % [clip.clip, anims])
			return
		var anim := player.get_animation(name)
		print("CLIP %s длина %.3f (ожидалось %.3f)" % [clip.clip, anim.length, clip.duration])
		if absf(anim.length - clip.duration) > 1.5 / 30.0:
			_fail("длина не совпала")
			return
		player.play(name)
		for c in clip.checks:
			# кости без дорожек в этом клипе иначе остаются в позе прошлого клипа (у glb дорожки только у движущихся)
			skel.reset_bone_poses()
			player.seek(c.t, true)
			for bone in c.world:
				var bi := skel.find_bone(String(bone).replace(":", "_").replace("/", "_"))
				if bi < 0:
					missing[bone] = true
					continue
				var v: Array = c.world[bone]
				var got: Vector3 = (_world(skel) * _bone_global(skel, bi)).origin
				var d := (got - Vector3(v[0], v[1], v[2])).length() / size
				if d > worst: where = "%s t=%.3f godot %s, ядро %s" % [bone, c.t, got, v]
				worst = maxf(worst, d)
				checked += 1
	print("VERIFY проверено суставов: %d, худшее расхождение: %.3f %% роста (допуск %.1f %%) %s" % [checked, worst * 100, TOL_REL * 100, where])
	if missing:
		print("VERIFY нет костей в Skeleton3D: %s" % [missing.keys()])
	var ok := checked > 0 and worst <= TOL_REL and not missing
	print("VERIFY_OK" if ok else "VERIFY_FAIL")
	quit(0 if ok else 1)

# Blender пишет тейк как «Armature|clip» или просто clip; Godot может добавить префикс
func _anim(player: AnimationPlayer, clip: String) -> String:
	for a in player.get_animation_list():
		if a == clip or a.ends_with("|" + clip) or a.ends_with("/" + clip): return a
	return ""

# глобальная поза кости из локальных: кеш get_bone_global_pose вне дерева после seek не обновляется
func _bone_global(skel: Skeleton3D, bi: int) -> Transform3D:
	var t := Transform3D.IDENTITY
	while bi >= 0:
		t = skel.get_bone_pose(bi) * t
		bi = skel.get_bone_parent(bi)
	return t

# мировое положение скелета без дерева сцены (в _init дерево ещё не работает — global_transform пуст)
func _world(n: Node) -> Transform3D:
	var t := Transform3D.IDENTITY
	while n != null:
		if n is Node3D: t = (n as Node3D).transform * t
		n = n.get_parent()
	return t

func _fail(msg: String) -> void:
	print("VERIFY_FAIL ", msg)
	quit(1)
