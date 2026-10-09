# Сверка живого вычисления позы (addons/animforge/live/af_core.gd) с ядром: те же клипы, те же моменты.
# Запуск: Godot --headless --path godot/sandbox --script res://tests/live_verify.gd -- <live.json>
# Печатает по клипу наибольшие расхождения поворота (по углу, градусы), сдвига (доля роста) и масштаба; в конце LIVE_OK/LIVE_FAIL.
extends SceneTree

# Vector3 и Quaternion в Godot — float32: у почти прямой ноги и вытянутой руки угол сгиба через arccos теряет до ≈0.3°
# (ядро считает в double). Это не видно; ошибка выбора (кручение плеча на 35°, другая ветка IK) — видно и ловится.
const TOL_DEG := 0.5
const TOL_POS := 1e-4
const TOL_SCL := 1e-4


func _init() -> void:
	var args := OS.get_cmdline_user_args()
	var cases = JSON.parse_string(FileAccess.get_file_as_string(args[0]))
	var bad := []
	for c in cases:
		var rig := AFCore.build_rig(c["data"])
		var size: float = maxf(1e-6, rig.heights[AFCore.SIZE])
		var clips := {}
		for clip in c["data"]["clips"]:
			clips[clip["name"]] = clip
		var worst := {}
		var t0 := Time.get_ticks_usec()
		var n := 0
		for s in c["samples"]:
			var clip: Dictionary = clips[s["clip"]]
			var parts := AFCore.pose_parts_at(rig, clip, s["t"], _opts(rig, s))
			n += 1
			var w: Array = worst.get(s["clip"], [0.0, 0.0, 0.0, ""])
			for bone in _union(s["rot"], parts.rot):
				var i: int = rig.index[bone]
				var a: Quaternion = AFCore.q4(s["rot"][bone]) if s["rot"].has(bone) else rig.rest_r[i]
				var b: Quaternion = parts.rot.get(bone, rig.rest_r[i])
				# угол между поворотами через хорду (точнее acos у единицы): |q − ±p| = 2·sin(θ/4)
				var ch := minf(_qdist(a, b, 1.0), _qdist(a, b, -1.0))
				var e := rad_to_deg(4.0 * asin(minf(1.0, ch / 2.0)))
				if e > w[0]:
					w[0] = e
					w[3] = "%s t=%.3f" % [bone, s["t"]]
			for bone in _union(s["pos"], parts.pos):
				var i: int = rig.index[bone]
				var a: Vector3 = AFCore.v3(s["pos"][bone]) if s["pos"].has(bone) else rig.rest_t[i]
				var b: Vector3 = parts.pos.get(bone, rig.rest_t[i])
				# сдвиг — в локальных единицах кости; переводим в долю роста через масштаб родителя
				var p := rig.parent[i]
				var k: float = rig.world_s[p].x if p >= 0 else 1.0
				w[1] = maxf(w[1], (a - b).length() * k / size)
			for bone in _union(s["scl"], parts.scl):
				var i: int = rig.index[bone]
				var a: Vector3 = AFCore.v3(s["scl"][bone]) if s["scl"].has(bone) else rig.rest_s[i]
				var b: Vector3 = parts.scl.get(bone, rig.rest_s[i])
				w[2] = maxf(w[2], (a - b).length())
			worst[s["clip"]] = w
		# естественная скорость походки — как в ядре (допуск 2 %: опора выбирается по порогу высоты, float32)
		for clip in c.get("speeds", {}):
			var want: float = c["speeds"][clip]
			var got := AFCore.natural_speed(rig, clips[clip])
			var ok := absf(got - want) <= 0.02 * maxf(want, 0.01 * c["size"])
			print("CLIP %s/%s скорость %s ядро %.4f godot %.4f" % [c["name"], clip, "ok" if ok else "BAD", want, got])
			if not ok:
				bad.append("%s/%s скорость" % [c["name"], clip])
		var ms := (Time.get_ticks_usec() - t0) / 1000.0 / maxi(1, n)
		# в игре поза считается каждый кадр: время на позу после прогрева (кэши вторичной динамики уже есть)
		var t1 := Time.get_ticks_usec()
		for s in c["samples"]:
			AFCore.pose_parts_at(rig, clips[s["clip"]], s["t"] + 0.001)
		var warm := (Time.get_ticks_usec() - t1) / 1000.0 / maxi(1, n)
		for clip in worst:
			var w: Array = worst[clip]
			var ok: bool = w[0] <= TOL_DEG and w[1] <= TOL_POS and w[2] <= TOL_SCL
			print("CLIP %s/%s %s rot=%.4f° (%s) pos=%.6f scl=%.6f" % [c["name"], clip, "ok" if ok else "BAD", w[0], w[3], w[1], w[2]])
			if not ok:
				bad.append("%s/%s" % [c["name"], clip])
		print("CLIP %s: %.2f мс на позу с прогревом, %.2f мс в игре" % [c["name"], ms, warm])
	print("LIVE_OK" if bad.is_empty() else "LIVE_FAIL " + ", ".join(bad))
	quit()


## Живые связки сэмпла: рельеф (та же функция, что в live.ts) и цели констрейнов.
func _opts(rig: AFCore.Rig, s: Dictionary) -> Dictionary:
	var o := {}
	if s.has("terrain"):
		var tr: Dictionary = s["terrain"]
		var f := AFCore.body_frame(rig)
		o["floor"] = func(_b: String, F: Vector3, rest: float) -> float:
			return rest + tr["a"] * F.dot(f.side) + tr["b"] * tr["size"] * sin((3.0 * F.dot(f.forward)) / tr["size"])
	if s.has("targets"):
		var tg := {}
		for id in s["targets"]:
			tg[id] = AFCore.v3(s["targets"][id])
		o["targets"] = tg
	return o


func _qdist(a: Quaternion, b: Quaternion, k: float) -> float:
	var la := a.length()
	var lb := b.length()
	return Vector4(a.x / la - k * b.x / lb, a.y / la - k * b.y / lb, a.z / la - k * b.z / lb, a.w / la - k * b.w / lb).length()


func _union(a: Dictionary, b: Dictionary) -> Array:
	var out := a.keys()
	for k in b:
		if not out.has(k):
			out.append(k)
	return out
