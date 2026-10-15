# Живое вычисление позы в Godot: точная копия packages/core/src/evaluate.ts и limits.ts (рецепты — в af_recipes.gd).
# Вход — файл <имя>.af.json, который пишет `af publish`: скелет в позе покоя, цепочки, пределы, клипы со слоями.
# Совпадение с ядром проверяет `pnpm af live.verify`: те же позы в те же моменты, кость в кость.
# Кватернионы — Quaternion Godot (x, y, z, w, умножение — как qmul ядра); норму и поворот вектора считаем сами,
# чтобы ненормированные промежуточные значения вели себя как в TS (Godot на них ругается).
class_name AFCore
extends RefCounted

const DEG := PI / 180.0
const QI := Quaternion(0, 0, 0, 1)
const SIZE := "__af_size__"


# ── математика (math.ts) ──────────────────────────────────────────────────────────────────────────────────────
static func qnorm(q: Quaternion) -> Quaternion:
	var l := sqrt(q.x * q.x + q.y * q.y + q.z * q.z + q.w * q.w)
	if l == 0.0:
		l = 1.0
	return Quaternion(q.x / l, q.y / l, q.z / l, q.w / l)


static func qinv(q: Quaternion) -> Quaternion:
	return Quaternion(-q.x, -q.y, -q.z, q.w)


static func vnorm(v: Vector3) -> Vector3:
	var l := v.length()
	if l == 0.0:
		l = 1.0
	return v / l


static func qaxis(axis: Vector3, angle: float) -> Quaternion:
	var a := vnorm(axis)
	var s := sin(angle / 2.0)
	return Quaternion(a.x * s, a.y * s, a.z * s, cos(angle / 2.0))


static func qrot(q: Quaternion, v: Vector3) -> Vector3:
	var r := q * Quaternion(v.x, v.y, v.z, 0) * qinv(q)
	return Vector3(r.x, r.y, r.z)


static func qscale(q: Quaternion, k: float) -> Quaternion:
	var d := q
	if d.w < 0:
		d = Quaternion(-d.x, -d.y, -d.z, -d.w)
	var s := sqrt(d.x * d.x + d.y * d.y + d.z * d.z)
	if s < 1e-12:
		return QI
	return qaxis(Vector3(d.x / s, d.y / s, d.z / s), 2.0 * atan2(s, d.w) * k)


static func ang_vel(q0: Quaternion, q1: Quaternion, h: float) -> Vector3:
	var d := q1 * qinv(q0)
	if d.w < 0:
		d = Quaternion(-d.x, -d.y, -d.z, -d.w)
	var s := sqrt(d.x * d.x + d.y * d.y + d.z * d.z)
	if s < 1e-12:
		return Vector3.ZERO
	var ang := 2.0 * atan2(s, d.w)
	return Vector3(d.x / s, d.y / s, d.z / s) * (ang / h)


static func qbetween(a: Vector3, b: Vector3) -> Quaternion:
	var u := vnorm(a)
	var v := vnorm(b)
	var c := u.dot(v)
	if c > 1.0 - 1e-12:
		return QI
	if c < -1.0 + 1e-12:
		var ax := vnorm(u.cross(Vector3(1, 0, 0))) if absf(u.x) < 0.9 else vnorm(u.cross(Vector3(0, 1, 0)))
		return Quaternion(ax.x, ax.y, ax.z, 0)
	var x := u.cross(v)
	return qnorm(Quaternion(x.x, x.y, x.z, 1.0 + c))


static func sgn1(x: float) -> float:
	# Math.sign(x) || 1
	return 1.0 if x >= 0.0 and not (x == 0.0) else (-1.0 if x < 0.0 else 1.0)


static func v3(a) -> Vector3:
	return Vector3(a[0], a[1], a[2])


static func q4(a) -> Quaternion:
	return Quaternion(a[0], a[1], a[2], a[3])


# ── кривые (curves.ts) ─────────────────────────────────────────────────────────────────────────────────────────
static func _sorted_keys(keys: Array) -> Array:
	var ks := keys.duplicate()
	ks.sort_custom(func(a, b): return a["t"] < b["t"])
	return ks


static func eval_keys(keys: Array, t: float, loop: bool, duration: float, ks: Array = []) -> float:
	if keys.is_empty():
		return 0.0
	if ks.is_empty():
		ks = _sorted_keys(keys)
	if loop and duration > 0:
		t = fposmod(t, duration)
	if t <= ks[0]["t"]:
		return ks[0]["v"]
	var last = ks[ks.size() - 1]
	if t >= last["t"]:
		return last["v"]
	var i := 0
	while ks[i + 1]["t"] < t:
		i += 1
	var a = ks[i]
	var b = ks[i + 1]
	var mode: String = a.get("interp", "smooth")
	if mode == "step":
		return a["v"]
	var u: float = (t - a["t"]) / (b["t"] - a["t"])
	if mode == "linear":
		return a["v"] + (b["v"] - a["v"]) * u
	var slope := func(j: int) -> float:
		if j <= 0 or j >= ks.size() - 1:
			return 0.0
		var d0: float = (ks[j]["v"] - ks[j - 1]["v"]) / (ks[j]["t"] - ks[j - 1]["t"])
		var d1: float = (ks[j + 1]["v"] - ks[j]["v"]) / (ks[j + 1]["t"] - ks[j]["t"])
		if d0 * d1 <= 0:
			return 0.0
		var m: float = (ks[j + 1]["v"] - ks[j - 1]["v"]) / (ks[j + 1]["t"] - ks[j - 1]["t"])
		var lim := 3.0 * minf(absf(d0), absf(d1))
		return signf(m) * minf(absf(m), lim)
	var h: float = b["t"] - a["t"]
	var m0: float = slope.call(i) * h
	var m1: float = slope.call(i + 1) * h
	var u2 := u * u
	var u3 := u2 * u
	return (2 * u3 - 3 * u2 + 1) * a["v"] + (u3 - 2 * u2 + u) * m0 + (-2 * u3 + 3 * u2) * b["v"] + (u3 - u2) * m1


# ── проект и скелет ────────────────────────────────────────────────────────────────────────────────────────────
class Rig:
	var names: PackedStringArray = []
	var index := {}
	var parent: PackedInt32Array = []
	var is_joint: Array[bool] = []
	var rest_r: Array[Quaternion] = []
	var rest_t: Array[Vector3] = []
	var rest_s: Array[Vector3] = []
	var world_r: Array[Quaternion] = []
	var world_t: Array[Vector3] = []
	var world_s: Array[Vector3] = []
	# проект: up, forward, chains (имя → [кости]), align, limits; рецепты: имя → {params: спецификации}
	var up := Vector3.UP
	var forward = null
	var chains := {}
	var align := {}
	var limits := {}
	var recipes := {}
	var heights := {}
	var sec_cache := {}
	var lock_cache := {}

	func node(i: int) -> String:
		return names[i]


static func build_rig(data: Dictionary) -> Rig:
	var rig := Rig.new()
	var nodes: Array = data["skeleton"]["nodes"]
	for i in nodes.size():
		rig.index[nodes[i]["name"]] = i
	for i in nodes.size():
		var n = nodes[i]
		rig.names.append(n["name"])
		var p: int = -1 if n["parent"] == null else int(rig.index[n["parent"]])
		rig.parent.append(p)
		rig.is_joint.append(bool(n.get("isJoint", false)))
		var r := q4(n["restR"])
		var t := v3(n["restT"])
		var s := v3(n["restS"])
		rig.rest_r.append(r)
		rig.rest_t.append(t)
		rig.rest_s.append(s)
		if p < 0:
			rig.world_r.append(r)
			rig.world_t.append(t)
			rig.world_s.append(s)
		else:
			rig.world_r.append(qnorm(rig.world_r[p] * r))
			rig.world_t.append(rig.world_t[p] + qrot(rig.world_r[p], rig.world_s[p] * t))
			rig.world_s.append(rig.world_s[p] * s)
	var pr: Dictionary = data["project"]
	rig.up = v3(pr["up"])
	rig.forward = v3(pr["forward"]) if pr.get("forward") != null else null
	rig.chains = pr.get("chains", {})
	rig.align = pr.get("align", {}) if pr.get("align") != null else {}
	rig.limits = pr.get("limits", {}) if pr.get("limits") != null else {}
	rig.recipes = data.get("recipes", {})
	rig.heights = rest_heights(rig)
	return rig


class Frame:
	var up: Vector3
	var forward: Vector3
	var side: Vector3


static func body_frame(rig: Rig) -> Frame:
	var f := Frame.new()
	f.up = vnorm(rig.up)
	var f0: Vector3 = rig.forward if rig.forward != null else Vector3(0, 0, 1)
	f.forward = vnorm(f0 - f.up * f0.dot(f.up))
	f.side = f.up.cross(f.forward)
	return f


static func bone_dir(rig: Rig, i: int) -> Vector3:
	var p := rig.parent[i]
	if p >= 0 and rig.is_joint[p]:
		var d := rig.world_t[i] - rig.world_t[p]
		if d.length() > 1e-6:
			return vnorm(d)
	return vnorm(qrot(rig.world_r[i], Vector3(0, 1, 0)))


## Мировые оси цепочки: lateral, vertical, roll — как chainAxes.
static func chain_axes(rig: Rig, chain: Array) -> Dictionary:
	var i0: int = rig.index[chain[0]]
	var a := rig.world_t[i0]
	var b := rig.world_t[rig.index[chain[chain.size() - 1]]]
	var along := vnorm(b - a) if (b - a).length() > 1e-6 else bone_dir(rig, i0)
	var body := body_frame(rig)
	var upv := body.up
	if along.cross(upv).length() < 1e-3:
		upv = body.forward
	var side := vnorm(along.cross(upv))
	return {"lateral": upv, "vertical": side, "roll": along}


static func local_delta(rig: Rig, bone: int, world_axis: Vector3, angle: float) -> Quaternion:
	var w := rig.world_r[bone]
	return qinv(w) * qaxis(world_axis, angle) * w


static func chain_of(rig: Rig, bone: String):
	for c in rig.chains.values():
		if c.has(bone):
			return c
	return null


static func rest_heights(rig: Rig) -> Dictionary:
	var upv := body_frame(rig).up
	var hs := []
	var floor_h := INF
	for i in rig.names.size():
		var h: float = rig.world_t[i].dot(upv) if rig.is_joint[i] else INF
		hs.append(h)
		floor_h = minf(floor_h, h)
	var m := {}
	var top := 0.0
	for i in rig.names.size():
		var v: float = hs[i] - floor_h if is_finite(hs[i]) else 0.0
		m[rig.names[i]] = v
		top = maxf(top, v)
	m[SIZE] = top
	return m


# ── накопитель слоёв (Acc) ─────────────────────────────────────────────────────────────────────────────────────
class Parts:
	var rot := {}  # кость → локальный поворот
	var pos := {}  # кость → локальный сдвиг
	var scl := {}  # кость → локальный масштаб
	var limited := {}


class Acc:
	var rig: Rig
	var rot := {}
	var move := {}
	var scale := {}
	var base := {}
	var limited := {}

	func _init(r: Rig) -> void:
		rig = r

	func apply_limits(only = null) -> void:
		for bone in rig.limits:
			if only != null and not only.has(bone):
				continue
			if not rot.has(bone) or not rig.index.has(bone):
				continue
			var r := AFLimits.clamp_rotation(rig, bone, rig.limits[bone], rot[bone], base.get(bone, QI))
			if r["hit"]:
				rot[bone] = r["d"]
				limited[bone] = true

	func add(bone: String, ch: String, v: float, axes: Callable) -> void:
		if not rig.index.has(bone):
			return
		var i: int = rig.index[bone]
		if v == (1.0 if ch.begins_with("scale_") else 0.0):
			return
		if ch in ["lateral", "vertical", "roll", "pitch", "yaw", "bank"]:
			var f := AFCore.body_frame(rig)
			var axis: Vector3
			match ch:
				"pitch": axis = f.side
				"yaw": axis = f.up
				"bank": axis = f.forward
				_: axis = axes.call()[ch]
			turn(bone, AFCore.local_delta(rig, i, axis, v * AFCore.DEG))
		elif ch.begins_with("move_"):
			var f := AFCore.body_frame(rig)
			var dir := f.up if ch == "move_up" else (f.forward if ch == "move_forward" else f.side)
			move[bone] = move.get(bone, Vector3.ZERO) + dir * v
		else:
			var s: Vector3 = scale.get(bone, Vector3.ONE)
			var k := 0 if ch == "scale_up" else (1 if ch == "scale_forward" else 2)
			s[k] *= v
			scale[bone] = s

	func turn(bone: String, d: Quaternion) -> void:
		rot[bone] = AFCore.qnorm(d * rot.get(bone, AFCore.QI))

	func set_local(bone: String, q: Quaternion) -> void:
		var rest := rig.rest_r[rig.index[bone]]
		rot[bone] = AFCore.qnorm(AFCore.qinv(rest) * q)

	func parts() -> Parts:
		var out := Parts.new()
		for bone in rot:
			out.rot[bone] = AFCore.qnorm(rig.rest_r[rig.index[bone]] * rot[bone])
		for bone in move:
			var i: int = rig.index[bone]
			var p := rig.parent[i]
			var m: Vector3 = move[bone]
			var local := m if p < 0 else AFCore.qrot(AFCore.qinv(rig.world_r[p]), m) / rig.world_s[p]
			out.pos[bone] = rig.rest_t[i] + local
		var f := AFCore.body_frame(rig)
		for bone in scale:
			var i: int = rig.index[bone]
			var s: Vector3 = scale[bone]
			var r := rig.rest_s[i]
			var dirs := [f.up, f.forward, f.side]
			for k in 3:
				if s[k] == 1.0:
					continue
				var local := AFCore.qrot(AFCore.qinv(rig.world_r[i]), dirs[k])
				var ax := 0
				for j in 3:
					if absf(local[j]) > absf(local[ax]):
						ax = j
				r[ax] *= s[k]
			out.scl[bone] = r
		return out


class World:
	var T: Array[Vector3] = []
	var R: Array[Quaternion] = []


static func world_pose(rig: Rig, parts: Parts) -> World:
	var w := World.new()
	var S: Array[Vector3] = []
	for i in rig.names.size():
		var n := rig.names[i]
		var lt: Vector3 = parts.pos.get(n, rig.rest_t[i])
		var lr: Quaternion = parts.rot.get(n, rig.rest_r[i])
		var ls: Vector3 = parts.scl.get(n, rig.rest_s[i])
		var p := rig.parent[i]
		if p < 0:
			w.T.append(lt)
			w.R.append(lr)
			S.append(ls)
		else:
			w.T.append(w.T[p] + qrot(w.R[p], S[p] * lt))
			w.R.append(qnorm(w.R[p] * lr))
			S.append(S[p] * ls)
	return w


static func skeleton_root(rig: Rig, i: int) -> int:
	var r := i
	var p := rig.parent[i]
	while p >= 0:
		if rig.is_joint[p]:
			r = p
		p = rig.parent[p]
	return r


static func is_secondary(layer: Dictionary) -> bool:
	return layer["type"] == "recipe" and AFRecipes.is_secondary(layer["recipe"])


## Параметры слоя с подставленными значениями по умолчанию (withDefaults): только те, что есть в схеме рецепта.
static func with_defaults(rig: Rig, recipe: String, params: Dictionary) -> Dictionary:
	var out := {}
	var spec: Dictionary = rig.recipes.get(recipe, {}).get("params", {})
	for k in spec:
		var v = params.get(k)
		out[k] = v if v != null else spec[k]["default"]
	return out


# ── ход под углом (applyTravel ядра) ───────────────────────────────────────────────────────────────────────────
## Куда идёт клип: вперёд тела, повёрнутое на travel.angle вокруг up (travelDir ядра).
static func travel_dir(rig: Rig, clip: Dictionary) -> Vector3:
	var f := body_frame(rig)
	var tr = clip.get("travel")
	if tr == null or float(tr.get("angle", 0.0)) == 0.0:
		return f.forward
	return vnorm(qrot(qaxis(f.up, float(tr["angle"]) * DEG), f.forward))


static func is_ancestor(rig: Rig, a: int, i: int) -> bool:
	var p := rig.parent[i]
	while p >= 0:
		if p == a:
			return true
		p = rig.parent[p]
	return false


static func _num(d: Dictionary, k: String, dflt: float) -> float:
	var v = d.get(k)
	return dflt if v == null else float(v)


static func apply_travel(acc: Acc, rig: Rig, tr: Dictionary) -> void:
	var f := body_frame(rig)
	var hips := _num(tr, "hips", 0.0)
	var feet := _num(tr, "feet", 0.0)
	var pi := -1
	var ci := -1
	var hi := -1
	for pair in [["pelvis", 0], ["chest", 1], ["head", 2]]:
		var ch = rig.chains.get(pair[0])
		if ch != null and not ch.is_empty() and rig.index.has(ch[0]):
			match pair[1]:
				0: pi = rig.index[ch[0]]
				1: ci = rig.index[ch[0]]
				2: hi = rig.index[ch[0]]
	var under := func(i: int) -> float: return 1.0 if pi >= 0 and i >= 0 and is_ancestor(rig, pi, i) else 0.0
	if pi >= 0 and hips != 0.0:
		acc.turn(rig.names[pi], local_delta(rig, pi, f.up, hips * DEG))
	var chest_back: float = _num(tr, "chest", 0.0) * hips * under.call(ci)
	if ci >= 0 and chest_back != 0.0:
		acc.turn(rig.names[ci], local_delta(rig, ci, f.up, -chest_back * DEG))
	var rest: float = hips * under.call(hi) - (chest_back if ci >= 0 and hi >= 0 and is_ancestor(rig, ci, hi) else 0.0)
	var look := _num(tr, "look", 0.0)
	if hi >= 0 and look != 0.0 and rest != 0.0:
		acc.turn(rig.names[hi], local_delta(rig, hi, f.up, -look * rest * DEG))
	var swing := _num(tr, "swing", _num(tr, "angle", 0.0))
	for name in rig.chains:
		var chain: Array = rig.chains[name]
		if not String(name).begins_with("leg_") or chain.is_empty() or not rig.index.has(chain[0]):
			continue
		var bone: String = chain[0]
		var i: int = rig.index[bone]
		var base: Quaternion = acc.base.get(bone, QI)
		var m := qscale(qnorm(acc.rot.get(bone, QI) * qinv(base)), _num(tr, "stride", 1.0))
		var A := local_delta(rig, i, f.up, (swing - feet) * DEG)
		acc.rot[bone] = qnorm(A * m * qinv(A) * base)
		var twist: float = feet - hips * under.call(i)
		if twist != 0.0:
			acc.turn(bone, local_delta(rig, i, f.up, twist * DEG))
		var width := _num(tr, "width", 0.0)
		if width != 0.0:
			var origin: Vector3 = rig.world_t[pi] if pi >= 0 else Vector3.ZERO
			var side := signf((rig.world_t[i] - origin).dot(f.side))
			if side == 0.0:
				side = 1.0
			var k := signf(f.forward.cross(-f.up).dot(f.side))
			if k == 0.0:
				k = 1.0
			acc.turn(bone, local_delta(rig, i, f.forward, width * side * k * DEG))


# ── фиксация опорной стопы (footLock ядра) ──────────────────────────────────────────────────────────────────────
const LOCK_N := 96


static func _flat(x: Vector3, up: Vector3) -> Vector3:
	return x - up * x.dot(up)


static func lock_plan(rig: Rig, clip: Dictionary) -> Dictionary:
	var key := JSON.stringify(clip)
	if rig.lock_cache.has(key):
		return rig.lock_cache[key]
	var g: Dictionary = clip["ground"]
	var base := clip.duplicate()
	var g0 := g.duplicate()
	g0["lock"] = false
	base["ground"] = g0
	var f := body_frame(rig)
	var N := LOCK_N
	var dt: float = float(clip["duration"]) / N
	var idx := []
	for b in g["bones"]:
		if rig.index.has(b):
			idx.append(rig.index[b])
	var size: float = rig.heights.get(SIZE, 1.0)
	var W := []
	var P := []
	var hmin := INF
	for k in N:
		var w := world_pose(rig, pose_parts_at(rig, base, k * dt))
		W.append(w)
		var row := []
		for i in idx:
			row.append(w.T[i])
			hmin = minf(hmin, w.T[i].dot(f.up))
		P.append(row)
	var d := travel_dir(rig, base)
	var low := []
	for k in N:
		var lo := INF
		for p in P[k]:
			lo = minf(lo, p.dot(f.up))
		var row := []
		for p in P[k]:
			var h: float = p.dot(f.up)
			row.append(h - hmin <= 0.02 * size and h - lo <= 0.005 * size)
		low.append(row)
	var vs := 0.0
	var vn := 0
	for k in N:
		for j in idx.size():
			var dv: float = (P[(k + 1) % N][j] - P[(k - 1 + N) % N][j]).dot(d)
			if low[k][j] and dv < 0.0:
				vs -= dv / (2.0 * dt)
				vn += 1
	var v: float = vs / vn if vn > 0 else 0.0
	var clear := 0.012 * size
	var T := []
	for k in N:
		T.append(P[k].duplicate())
	var drop := []
	drop.resize(N)
	drop.fill(0.0)
	for j in idx.size():
		var fi: int = idx[j]
		var on := []
		for k in N:
			var back: bool = (P[(k + 1) % N][j] - P[(k - 1 + N) % N][j]).dot(d) < 0.0
			on.append(v > 0 and low[k][j] and back)
		var c := []
		c.resize(N)
		var any_on: bool = on.has(true)
		var all_on: bool = not on.has(false)
		if any_on and not all_on:
			var start := -1
			for k in N:
				if on[k] and not on[(k - 1 + N) % N]:
					start = k
					break
			var k := start
			while true:
				var seg := []
				while on[k % N] and seg.size() < N:
					seg.append(k)
					k += 1
				var A := Vector3.ZERO
				for s in seg:
					A += _flat(P[s % N][j], f.up) + d * (v * s * dt)
				A /= seg.size()
				for s in seg:
					c[s % N] = A - d * (v * s * dt) - _flat(P[s % N][j], f.up)
				while not on[k % N]:
					k += 1
				if k % N == start:
					break
			var floor_h := rig.world_t[fi].dot(f.up)
			for k0 in N:
				if on[k0] or not on[(k0 - 1 + N) % N]:
					continue
				var k1 := k0
				while not on[k1 % N]:
					k1 += 1
				var a: Vector3 = c[(k0 - 1 + N) % N]
				var b: Vector3 = c[k1 % N]
				var n := k1 - k0 + 1
				for k2 in range(k0, k1):
					var u := float(k2 - k0 + 1) / n
					var sm := u * u * (3.0 - 2.0 * u)
					var lift := maxf(0.0, floor_h + clear * pow(sin(PI * u), 0.25) - P[k2 % N][j].dot(f.up))
					c[k2 % N] = a * (1.0 - sm) + b * sm + f.up * lift
		var si := rig.parent[fi]
		var hi := rig.parent[si] if si >= 0 else -1
		for k in N:
			if c[k] != null:
				T[k][j] = P[k][j] + c[k]
			if hi < 0:
				continue
			var L := (rig.world_t[si] - rig.world_t[hi]).length() + (rig.world_t[fi] - rig.world_t[si]).length()
			var D: Vector3 = W[k].T[hi] - T[k][j]
			var vd := D.dot(f.up)
			var hd := _flat(D, f.up).length()
			var R := 0.97 * L
			if Vector2(vd, hd).length() > R:
				drop[k] = maxf(drop[k], vd - sqrt(R * R - hd * hd) if hd < R else vd)
	var w := maxi(1, roundi(0.06 * N))
	var mx := []
	for k in N:
		var m := 0.0
		for q in 2 * w + 1:
			m = maxf(m, drop[(k + q - w + N) % N])
		mx.append(m)
	var smd := []
	for k in N:
		var acc_s := 0.0
		for q in 2 * w + 1:
			acc_s += mx[(k + q - w + N) % N]
		smd.append(minf(0.01 * size, acc_s / (2 * w + 1)))
	var plan := {"T": T, "drop": smd}
	if rig.lock_cache.size() > 64:
		rig.lock_cache.clear()
	rig.lock_cache[key] = plan
	return plan


static func foot_lock(acc: Acc, rig: Rig, clip: Dictionary, t: float, off) -> void:
	var g: Dictionary = clip["ground"]
	var plan := lock_plan(rig, clip)
	var N := LOCK_N
	var x := fposmod(t / float(clip["duration"]), 1.0) * N
	var k0 := int(floor(x)) % N
	var k1 := (k0 + 1) % N
	var u: float = x - floor(x)
	var upv := body_frame(rig).up
	var drop: float = plan["drop"][k0] * (1.0 - u) + plan["drop"][k1] * u
	var bones := []
	for b in g["bones"]:
		if rig.index.has(b):
			bones.append(b)
	if drop > 1e-9 and not bones.is_empty():
		acc.add(rig.names[skeleton_root(rig, rig.index[bones[0]])], "move_up", -drop, func(): return {"lateral": upv, "vertical": upv, "roll": upv})
	for j in bones.size():
		var b: String = bones[j]
		var P: Vector3 = plan["T"][k0][j] * (1.0 - u) + plan["T"][k1][j] * u + upv * (off.get(b, 0.0) if off != null else 0.0)
		two_bone_ik(acc, rig, b, P, null, 1.0)
	if g.get("flat", false):
		for b in g["bones"]:
			flat_foot(acc, rig, b, off.get(b, 0.0) if off != null else 0.0)


# ── основные слои и пол (primary) ──────────────────────────────────────────────────────────────────────────────
## opts: { "floor": Callable(bone: String, F: Vector3, rest: float) -> float — высота пола под стопой (рельеф в игре),
##         "targets": { id констрейна: Vector3 } — живые цели } — всё в координатах модели, как LiveOpts ядра.
static func primary(rig: Rig, clip: Dictionary, t: float, opts := {}) -> Acc:
	var t_clip := t  # фиксация стопы — по времени клипа, как её план
	var trv = clip.get("travel")
	if trv != null and trv.get("reverse", false):
		t = float(clip["duration"]) - t
	var acc := Acc.new(rig)
	if not rig.align.is_empty():
		align_rest(acc, rig)
	for b in acc.rot:
		acc.base[b] = acc.rot[b]
	for layer in clip["layers"]:
		if is_secondary(layer):
			continue
		match layer["type"]:
			"recipe":
				var chain = rig.chains.get(layer["target"]["chain"])
				if chain == null or not rig.recipes.has(layer["recipe"]):
					continue
				var p := with_defaults(rig, layer["recipe"], layer.get("params", {}))
				var cache := {}
				var get_axes := func():
					if not cache.has("a"):
						cache["a"] = chain_axes(rig, chain)
					return cache["a"]
				var w: float = layer.get("weight", 1.0) if layer.get("weight") != null else 1.0
				var n: int = chain.size()
				for i in n:
					var bone: String = chain[i]
					var out := AFRecipes.evaluate(layer["recipe"], p, i, n, t, {"height": rig.heights.get(bone, 0.0), "size": rig.heights.get(SIZE, 0.0)})
					for ch in out:
						var v: float = out[ch]
						var val := 1.0 + (v - 1.0) * w if ch.begins_with("scale_") else v * w
						acc.add(bone, ch, val, get_axes)
			"pose":
				apply_pose(acc, layer, t, clip)
			_:
				for tr in layer["tracks"]:
					var bone: String = tr["bone"]
					var chain = chain_of(rig, bone)
					if chain == null:
						chain = [bone]
					var v := eval_keys(tr["keys"], t, clip["loop"], clip["duration"])
					var ax_chain: Array = chain if chain.size() > 1 else [bone]
					var axis: String = tr["axis"]
					acc.add(bone, axis, 1.0 + v if axis.begins_with("scale_") else v, func(): return chain_axes(rig, ax_chain))
	if trv != null:
		apply_travel(acc, rig, trv)
	if not rig.limits.is_empty():
		acc.apply_limits()
	var g = clip.get("ground")
	if g != null and not g["bones"].is_empty():
		# рельеф: пол под каждой стопой выше или ниже покоя на off; тело опускается к самой низкой опоре
		var off = terrain(acc, rig, g, opts["floor"]) if opts.has("floor") else null
		if g["mode"] == "contact":
			ground(acc, rig, g, off)
		if g.get("ik", false):
			for b in g["bones"]:
				foot_ik(acc, rig, b, off.get(b, 0.0) if off != null else 0.0)
		if g["mode"] == "floor":
			ground(acc, rig, g, off)
		if g.get("flat", false):
			for b in g["bones"]:
				flat_foot(acc, rig, b, off.get(b, 0.0) if off != null else 0.0)
		if g.get("lock", false) and clip["loop"]:
			foot_lock(acc, rig, clip, t_clip, off)
	var cons = clip.get("constraints")
	if cons != null and cons.any(func(c): return not c.get("muted", false)):
		for c in cons:
			if not c.get("muted", false):
				solve_constraint(acc, rig, clip, c, t, opts)
		if not rig.limits.is_empty():
			acc.apply_limits()
	return acc


static func sample_pose(layer: Dictionary, t: float, clip: Dictionary) -> Dictionary:
	var out := {"rot": {}, "move": {}}
	var ks: Array = layer["keys"].duplicate()
	ks.sort_custom(func(a, b): return a["t"] < b["t"])
	if ks.is_empty():
		return out
	if clip["loop"] and clip["duration"] > 0:
		t = fposmod(t, clip["duration"])
	var a = ks[0]
	var b = ks[0]
	var u := 0.0
	if t >= ks[ks.size() - 1]["t"]:
		a = ks[ks.size() - 1]
		b = a
	elif t > ks[0]["t"]:
		var i := 0
		while ks[i + 1]["t"] < t:
			i += 1
		a = ks[i]
		b = ks[i + 1]
		u = (t - a["t"]) / (b["t"] - a["t"])
		var mode: String = a.get("interp", "smooth")
		u = 0.0 if mode == "step" else (u if mode == "linear" else u * u * (3 - 2 * u))
	var ar: Dictionary = a.get("rot", {})
	var br: Dictionary = b.get("rot", {})
	var bones := ar.keys()
	for k in br:
		if not bones.has(k):
			bones.append(k)
	for bone in bones:
		var qa: Quaternion = q4(ar[bone]) if ar.has(bone) else QI
		var qb: Quaternion = q4(br[bone]) if br.has(bone) else QI
		out["rot"][bone] = qnorm(qscale(qb * qinv(qa), u) * qa)
	var am: Dictionary = a.get("move", {})
	var bm: Dictionary = b.get("move", {})
	var mv := am.keys()
	for k in bm:
		if not mv.has(k):
			mv.append(k)
	for bone in mv:
		var va: Vector3 = v3(am[bone]) if am.has(bone) else Vector3.ZERO
		var vb: Vector3 = v3(bm[bone]) if bm.has(bone) else Vector3.ZERO
		out["move"][bone] = va + (vb - va) * u
	return out


static func apply_pose(acc: Acc, layer: Dictionary, t: float, clip: Dictionary) -> void:
	var p := sample_pose(layer, t, clip)
	for bone in p["rot"]:
		if acc.rig.index.has(bone):
			acc.turn(bone, p["rot"][bone])
	for bone in p["move"]:
		if acc.rig.index.has(bone):
			acc.move[bone] = acc.move.get(bone, Vector3.ZERO) + p["move"][bone]


static func align_rest(acc: Acc, rig: Rig) -> void:
	var f := body_frame(rig)
	for chain_name in rig.align:
		var a: Dictionary = rig.align[chain_name]
		var chain = rig.chains.get(chain_name)
		if chain == null or chain.is_empty() or not rig.index.has(chain[0]):
			continue
		var i0: int = rig.index[chain[0]]
		var along: Vector3 = chain_axes(rig, chain)["roll"]
		var s := signf(along.dot(f.side))
		if s == 0.0:
			s = 1.0
		var ab: float = (a.get("abduct", 0.0) if a.get("abduct") != null else 0.0) * DEG
		var target := vnorm(f.up * -cos(ab) + f.side * (s * sin(ab)))
		var q := qbetween(along, target)
		var w := rig.world_r[i0]
		acc.turn(chain[0], qinv(w) * q * w)


static func ground(acc: Acc, rig: Rig, g: Dictionary, off = null) -> void:
	var idx := []
	for b in g["bones"]:
		if rig.index.has(b):
			idx.append(rig.index[b])
	if idx.is_empty():
		return
	var upv := body_frame(rig).up
	var w := world_pose(rig, acc.parts())
	var rest := INF
	var now := INF
	for i in idx:
		rest = minf(rest, rig.world_t[i].dot(upv))
		now = minf(now, w.T[i].dot(upv) - (off.get(rig.names[i], 0.0) if off != null else 0.0))
	var d := rest - now
	if g["mode"] == "floor":
		d = maxf(0.0, d)
	if absf(d) < 1e-9:
		return
	var root := rig.names[skeleton_root(rig, idx[0])]
	acc.add(root, "move_up", d, func(): return {"lateral": upv, "vertical": upv, "roll": upv})


static func _angle(x: Vector3, y: Vector3) -> float:
	return acos(clampf(vnorm(x).dot(vnorm(y)), -1.0, 1.0))


## Ступня не уходит под пол; off — насколько пол под ней выше покоя (рельеф).
static func foot_ik(acc: Acc, rig: Rig, foot: String, off := 0.0) -> void:
	if not rig.index.has(foot):
		return
	var fi: int = rig.index[foot]
	var si := rig.parent[fi]
	var ti := rig.parent[si] if si >= 0 else -1
	if si < 0 or ti < 0:
		return
	var f := body_frame(rig)
	var w := world_pose(rig, acc.parts())
	var H := w.T[ti]
	var K := w.T[si]
	var F := w.T[fi]
	var floor_h := rig.world_t[fi].dot(f.up) + off
	var h := F.dot(f.up)
	if h >= floor_h - 1e-9:
		return
	var P := F + f.up * (floor_h - h)
	var a := (K - H).length()
	var b := (F - K).length()
	var d := minf(a + b - 1e-6, maxf(absf(a - b) + 1e-6, (P - H).length()))
	var cur := _angle(H - K, F - K)
	var want := acos(clampf((a * a + b * b - d * d) / (2 * a * b), -1.0, 1.0))
	var n := (H - K).cross(F - K)
	if n.length() < 1e-6 * a * b:
		n = f.forward.cross(H - K)
	n = vnorm(n)
	var q1 := qaxis(n, want - cur)
	var F1 := K + qrot(q1, F - K)
	var q2 := qbetween(F1 - H, P - H)
	var pt := rig.parent[ti]
	var Rp := w.R[pt] if pt >= 0 else QI
	acc.set_local(rig.names[ti], qnorm(qinv(Rp) * (q2 * w.R[ti])))
	acc.set_local(rig.names[si], qnorm(qinv(w.R[ti]) * (q1 * w.R[si])))


static func flat_foot(acc: Acc, rig: Rig, foot: String, off := 0.0) -> void:
	if not rig.index.has(foot):
		return
	var fi: int = rig.index[foot]
	var upv := body_frame(rig).up
	var w := world_pose(rig, acc.parts())
	var pf := rig.parent[fi]
	var hip := rig.parent[pf] if pf >= 0 else -1
	var leg := maxf(1e-6, rig.world_t[hip].dot(upv) - rig.world_t[fi].dot(upv)) if hip >= 0 else 1.0
	var lift := (w.T[fi].dot(upv) - rig.world_t[fi].dot(upv) - off) / leg
	var k := 1.0 if lift <= 0.02 else (0.5 if lift >= 0.06 else 1.0 - (0.5 * (lift - 0.02)) / 0.04)
	var local_up := qrot(qinv(rig.world_r[fi]), upv)
	var now_up := qrot(w.R[fi], local_up)
	var fix_q := qscale(qbetween(now_up, upv), k)
	var Rp := w.R[pf] if pf >= 0 else QI
	acc.set_local(rig.names[fi], qnorm(qinv(Rp) * (fix_q * w.R[fi])))


## Рельеф: насколько пол под каждой стопой выше покоя; тело сразу сдвигается к самой низкой опоре.
static func terrain(acc: Acc, rig: Rig, g: Dictionary, floor_fn: Callable) -> Dictionary:
	var upv := body_frame(rig).up
	var w := world_pose(rig, acc.parts())
	var off := {}
	var first := -1
	for b in g["bones"]:
		if not rig.index.has(b):
			continue
		var i: int = rig.index[b]
		if first < 0:
			first = i
		var rest := rig.world_t[i].dot(upv)
		off[b] = float(floor_fn.call(b, w.T[i], rest)) - rest
	if off.is_empty():
		return off
	var d: float = off.values().min()
	if absf(d) > 1e-9:
		acc.add(rig.names[skeleton_root(rig, first)], "move_up", d, func(): return {"lateral": upv, "vertical": upv, "roll": upv})
	return off


## Естественная скорость походки (naturalSpeed ядра), единиц модели в секунду; 0 — подгонять нечего.
static func natural_speed(rig: Rig, clip: Dictionary, steps := 96) -> float:
	var g = clip.get("ground")
	if not clip["loop"] or g == null or g["bones"].is_empty() or clip["duration"] <= 0:
		return 0.0
	var f := body_frame(rig)
	var idx := []
	for b in g["bones"]:
		if rig.index.has(b):
			idx.append(rig.index[b])
	if idx.is_empty():
		return 0.0
	var size: float = rig.heights.get(SIZE, 1.0)
	var dt: float = clip["duration"] / steps
	var dir := travel_dir(rig, clip)
	var P := []
	var hmin := INF
	for k in steps + 1:
		var w := world_pose(rig, pose_parts_at(rig, clip, k * dt))
		var row := []
		for i in idx:
			row.append(w.T[i])
			hmin = minf(hmin, w.T[i].dot(f.up))
		P.append(row)
	var v := []
	for k in steps:
		var j := 0
		for jj in idx.size():
			if P[k][jj].dot(f.up) < P[k][j].dot(f.up):
				j = jj
		if P[k][j].dot(f.up) - hmin > 0.02 * size:
			continue
		v.append(-(P[k + 1][j] - P[k][j]).dot(dir) / dt)
	if v.is_empty():
		return 0.0
	v.sort()
	return maxf(0.0, v[v.size() / 2])


# ── констрейны: IK, взгляд, копия поворота ────────────────────────────────────────────────────────────────────
static func ik_chain(rig: Rig, tip: int, length: int, end: bool) -> Array:
	var out := []
	var i := tip if end else rig.parent[tip]
	while i >= 0 and out.size() < length and rig.is_joint[i]:
		out.push_front(i)
		i = rig.parent[i]
	return out


static func target_at(rig: Rig, parts, clip: Dictionary, tg: Dictionary, t: float):
	var p = null
	if tg.get("keys") != null and not tg["keys"].is_empty():
		var ks: Array = tg["keys"]
		var c := []
		for k in 3:
			var kk := []
			for x in ks:
				kk.append({"t": x["t"], "v": x["pos"][k], "interp": x.get("interp", "smooth")})
			c.append(eval_keys(kk, t, clip["loop"], clip["duration"]))
		p = Vector3(c[0], c[1], c[2])
	elif tg.get("bone") != null:
		if not rig.index.has(tg["bone"]):
			return null
		var i: int = rig.index[tg["bone"]]
		p = world_pose(rig, parts).T[i] if parts != null else rig.world_t[i]
	elif tg.get("pos") != null:
		p = v3(tg["pos"])
	if p == null:
		return null
	return p + v3(tg["offset"]) if tg.get("offset") != null else p


## opts.targets — живые цели из игры: id констрейна → Vector3 в координатах модели (взгляд на игрока и т.п.).
static func solve_constraint(acc: Acc, rig: Rig, clip: Dictionary, c: Dictionary, t: float, opts := {}) -> void:
	if c["type"] == "copy":
		copy_rotation(acc, rig, c["bones"], c["source"], c.get("weight", 1.0) if c.get("weight") != null else 1.0, c.get("mirror", false))
		return
	var P = opts.get("targets", {}).get(c.get("id"))
	if P == null:
		P = target_at(rig, acc.parts() if c["target"].get("bone") != null else null, clip, c["target"], t)
	if P == null:
		return
	var w := clampf(c.get("weight", 1.0) if c.get("weight") != null else 1.0, 0.0, 1.0)
	if w == 0.0:
		return
	if c["type"] == "ik":
		var len: int = int(c.get("length", 2)) if c.get("length") != null else 2
		if not rig.index.has(c["tip"]):
			return
		var fi: int = rig.index[c["tip"]]
		var end: bool = c.get("end", false)
		var chain := ik_chain(rig, fi, len, end)
		var limited := chain.any(func(i): return rig.limits.has(rig.names[i]))
		var pole = v3(c["pole"]) if c.get("pole") != null else null
		if len == 2 and not limited:
			two_bone_ik(acc, rig, c["tip"], P, pole, w, end)
			return
		var before := {}
		for i in chain:
			before[i] = acc.rot.get(rig.names[i], QI)
		solve_limited(acc, rig, chain, fi, end, P, pole)
		if w < 1:
			for i in before:
				var n := rig.names[i]
				var q0: Quaternion = before[i]
				var q1: Quaternion = acc.rot.get(n, QI)
				acc.rot[n] = qnorm(qscale(q1 * qinv(q0), w) * q0)
		return
	aim(acc, rig, c["bones"], P, w)


static func copy_rotation(acc: Acc, rig: Rig, bones: Array, source: Array, weight: float, mirror: bool) -> void:
	var side := body_frame(rig).side
	for k in bones.size():
		var bone: String = bones[k]
		var src = source[k] if k < source.size() else null
		if not rig.index.has(bone) or src == null or not rig.index.has(src):
			continue
		var i: int = rig.index[bone]
		var j: int = rig.index[src]
		var d: Quaternion = acc.rot.get(src, QI)
		var m := rig.world_r[j] * (d * qinv(acc.base.get(src, QI))) * qinv(rig.world_r[j])
		if mirror:
			var v := Vector3(m.x, m.y, m.z)
			var r := v - side * (2 * v.dot(side))
			m = Quaternion(-r.x, -r.y, -r.z, m.w)
		var add := qscale(m, weight)
		acc.turn(bone, qnorm(qinv(rig.world_r[i]) * add * rig.world_r[i]))


static func effector_of(rig: Rig, fi: int, end: bool, end_length = null) -> Callable:
	var pi := rig.parent[fi]
	var len := rig.world_t[fi] - rig.world_t[pi] if pi >= 0 else Vector3.ZERO
	if end_length != null and len.length() > 1e-12:
		len = vnorm(len) * end_length
	return func(w: World) -> Vector3:
		return w.T[fi] + qrot(w.R[fi] * qinv(rig.world_r[fi]), len) if end else w.T[fi]


static func ccd(acc: Acc, rig: Rig, chain: Array, effector: Callable, P: Vector3, iterations := 200) -> void:
	var n := chain.size()
	var w := world_pose(rig, acc.parts())
	var p0 := rig.parent[chain[0]]
	var Rbase := w.R[p0] if p0 >= 0 else QI
	var J0 := w.T[chain[0]]
	var names := []
	var rest := []
	var d := []
	for i in chain:
		names.append(rig.names[i])
		rest.append(rig.rest_r[i])
		d.append(acc.rot.get(rig.names[i], QI))
	var E0: Vector3 = effector.call(w)
	var offs := []
	for k in n:
		var i: int = chain[k]
		var nxt: Vector3 = w.T[chain[k + 1]] if k + 1 < n else E0
		offs.append(qrot(qinv(w.R[i]), nxt - w.T[i]))
	var W := []
	W.resize(n)
	var J := []
	J.resize(n + 1)
	J[0] = J0
	var fwd := func(from: int) -> void:
		for k in range(from, n):
			var par: Quaternion = W[k - 1] if k > 0 else Rbase
			W[k] = qnorm(par * rest[k] * d[k])
			J[k + 1] = (J[k] if k > 0 else J0) + qrot(W[k], offs[k])
			if k == 0:
				J[0] = J0
	fwd.call(0)
	var scale := 1e-9
	for o in offs:
		scale = maxf(scale, o.length())
	for it in iterations:
		for k in range(n - 1, -1, -1):
			var q := qbetween(J[n] - J[k], P - J[k])
			var Wp: Quaternion = W[k - 1] if k > 0 else Rbase
			var dk := qnorm(qinv(rest[k]) * (qinv(Wp) * (q * W[k])))
			if rig.limits.has(names[k]):
				dk = AFLimits.clamp_rotation(rig, names[k], rig.limits[names[k]], dk, acc.base.get(names[k], QI))["d"]
			d[k] = dk
			fwd.call(k)
		if (J[n] - P).length() < 1e-6 * scale:
			break
	for k in n:
		acc.rot[names[k]] = d[k]


static func two_bone_ik(acc: Acc, rig: Rig, tip: String, P: Vector3, pole, weight: float, end := false) -> void:
	if not rig.index.has(tip):
		return
	var fi: int = rig.index[tip]
	var si := fi if end else rig.parent[fi]
	var ti := rig.parent[si] if si >= 0 else -1
	if si < 0 or ti < 0:
		return
	var fwd := body_frame(rig).forward
	var w := world_pose(rig, acc.parts())
	var H := w.T[ti]
	var K := w.T[si]
	var F := K + qrot(w.R[si] * qinv(rig.world_r[si]), rig.world_t[si] - rig.world_t[ti]) if end else w.T[fi]
	var a := (K - H).length()
	var b := (F - K).length()
	if a < 1e-9 or b < 1e-9:
		return
	var d := minf(a + b - 1e-6, maxf(absf(a - b) + 1e-6, (P - H).length()))
	var cur := _angle(H - K, F - K)
	var want := acos(clampf((a * a + b * b - d * d) / (2 * a * b), -1.0, 1.0))
	var n := (H - K).cross(F - K)
	if n.length() < 1e-6 * a * b:
		n = fwd.cross(H - K)
	n = vnorm(n)
	var q1 := qaxis(n, want - cur)
	var F1 := K + qrot(q1, F - K)
	var q2 := qbetween(F1 - H, P - H)
	if pole != null:
		var ax := vnorm(P - H)
		var K2 := H + qrot(q2, K - H)
		var kv := K2 - H
		kv = kv - ax * kv.dot(ax)
		var pv: Vector3 = pole - H
		pv = pv - ax * pv.dot(ax)
		# колено на линии (нога вытянута) — сгиб никуда не смотрит, полюс не крутит
		if kv.length() > 1e-2 * a and pv.length() > 1e-9:
			var s := signf(kv.cross(pv).dot(ax))
			if s == 0.0:
				s = 1.0
			q2 = qaxis(ax, s * _angle(kv, pv)) * q2
	set_two(acc, rig, w, ti, si, qscale(q2, weight), qscale(q1, weight))


static func set_two(acc: Acc, rig: Rig, w: World, ti: int, si: int, q_root: Quaternion, q_mid: Quaternion) -> void:
	var pt := rig.parent[ti]
	var Rp := w.R[pt] if pt >= 0 else QI
	var Rt := q_root * w.R[ti]
	acc.set_local(rig.names[ti], qnorm(qinv(Rp) * Rt))
	acc.set_local(rig.names[si], qnorm(qinv(w.R[ti]) * (q_mid * w.R[si])))


static func hinge_ik(acc: Acc, rig: Rig, chain: Array, eff: Callable, P: Vector3, h: Dictionary) -> void:
	var ti: int = chain[0]
	var si: int = chain[1]
	var w := world_pose(rig, acc.parts())
	var H := w.T[ti]
	var K := w.T[si]
	var F: Vector3 = eff.call(w)
	var d := (P - H).length()
	var name := rig.names[si]
	var now: float = AFLimits.decompose(acc.rot.get(name, QI) * qinv(acc.base.get(name, QI)), h["fr"]["axes"])[h["k"]]
	var axis: Vector3 = h["axis"]
	var cost := func(deg: float) -> float:
		var at := K + qrot(qaxis(axis, (deg - now) * DEG), F - K)
		return absf((at - H).length() - d)
	var best_deg := now
	var best_cost: float = cost.call(now)
	var lo := minf(h["range"][0], h["range"][1])
	var hi := maxf(h["range"][0], h["range"][1])
	for k in 97:
		var g := lo + ((hi - lo) * k) / 96.0
		var c: float = cost.call(g)
		if c < best_cost:
			best_cost = c
			best_deg = g
	var a := maxf(lo, best_deg - (hi - lo) / 96.0)
	var b := minf(hi, best_deg + (hi - lo) / 96.0)
	for it in 40:
		var m1 := b - (b - a) / 1.618
		var m2 := a + (b - a) / 1.618
		if cost.call(m1) < cost.call(m2):
			b = m2
		else:
			a = m1
	var deg := (a + b) / 2.0
	var q1 := qaxis(axis, (deg - now) * DEG)
	var F1 := K + qrot(q1, F - K)
	var q2 := qbetween(F1 - H, P - H)
	var ax := vnorm(P - H)
	var k_now := qrot(q2, K - H)
	k_now = k_now - ax * k_now.dot(ax)
	var k_was := K - H
	k_was = k_was - ax * k_was.dot(ax)
	# локоть почти на линии (рука вытянута к недостижимой цели) — направления у него нет, кручение не трогаем
	var off := 1e-2 * (K - H).length()
	if k_now.length() > off and k_was.length() > off:
		var ang := acos(clampf(vnorm(k_now).dot(vnorm(k_was)), -1.0, 1.0))
		var s := signf(k_now.cross(k_was).dot(ax))
		if s == 0.0:
			s = 1.0
		q2 = qaxis(ax, s * ang) * q2
	set_two(acc, rig, w, ti, si, q2, q1)


static func solve_limited(acc: Acc, rig: Rig, chain: Array, fi: int, end: bool, P: Vector3, pole = null, end_length = null) -> void:
	var names := []
	var start := []
	for i in chain:
		names.append(rig.names[i])
		start.append(acc.rot.get(rig.names[i], QI))
	var eff := effector_of(rig, fi, end, end_length)
	var tip := rig.names[fi]
	var err := func() -> float: return (eff.call(world_pose(rig, acc.parts())) - P).length()
	# сиды: "none" — без формулы (только CCD), "hinge" — шарнир, Vector3 или null — полюс формулы
	var seeds: Array = [["none"]]
	var hinge_seed = null
	if chain.size() == 2:
		var w := world_pose(rig, acc.parts())
		var K := w.T[chain[1]]
		var L := (w.T[chain[1]] - w.T[chain[0]]).length()
		var f := body_frame(rig)
		var dirs: Array = [f.forward, f.up, f.side]
		var lim = rig.limits.get(names[1])
		if lim != null:
			var body: bool = lim.keys().any(func(k): return k in ["pitch", "yaw", "bank"])
			var fr := AFLimits.limit_frame(rig, names[1], body)
			var best := -1
			var wide := -1.0
			for k in 3:
				var nm: String = fr["names"][k]
				var r = lim.get(nm)
				var width: float = -1.0 if nm == "roll" or nm == "yaw" else (r[1] - r[0] if r != null else 360.0)
				if k > 0 and width > wide:
					wide = width
					best = k
			if best > 0:
				var hinge := qrot(w.R[chain[1]], fr["axes"][best])
				var along := w.T[chain[1]] - w.T[chain[0]]
				var perp := hinge.cross(along)
				if perp.length() > 1e-9:
					dirs.push_front(vnorm(perp))
				var rng = lim.get(fr["names"][best])
				hinge_seed = {"axis": hinge, "range": rng if rng != null else [-180, 180], "k": best, "fr": fr}
		seeds = [["pole", pole]]
		for dd in dirs:
			seeds.append(["pole", K + dd * L])
			seeds.append(["pole", K + dd * -L])
		seeds.append(["none"])
		if hinge_seed != null:
			seeds.push_front(["hinge"])
	var best_q = null
	var best_err := INF
	# ничья — с допуском от длины цепочки, как в ядре: при равной ошибке остаётся первое начало
	var span := maxf(1e-9, (rig.world_t[fi] - rig.world_t[chain[0]]).length())
	for sd in seeds:
		for k in names.size():
			acc.rot[names[k]] = start[k]
		if sd[0] == "hinge":
			hinge_ik(acc, rig, chain, eff, P, hinge_seed)
		elif sd[0] == "pole":
			two_bone_ik(acc, rig, tip, P, sd[1], 1.0, end)
		ccd(acc, rig, chain, eff, P)
		var e: float = err.call()
		if e < best_err - 1e-6 * span:
			best_err = e
			best_q = names.map(func(n): return acc.rot.get(n, QI))
		if best_err < 1e-5 * span:
			break
	for k in names.size():
		acc.rot[names[k]] = best_q[k]


static func aim(acc: Acc, rig: Rig, bones: Array, P: Vector3, weight: float) -> void:
	var idx := []
	for b in bones:
		if rig.index.has(b):
			idx.append(rig.index[b])
	if idx.is_empty():
		return
	var fwd := body_frame(rig).forward
	var tip: int = idx[idx.size() - 1]
	for k in idx.size():
		var i: int = idx[k]
		var wp := world_pose(rig, acc.parts())
		var cur := qrot(wp.R[tip] * qinv(rig.world_r[tip]), fwd)
		var want := P - wp.T[tip]
		if want.length() < 1e-9:
			return
		var q := qscale(qbetween(cur, want), weight / (idx.size() - k))
		var pi := rig.parent[i]
		var Rp := wp.R[pi] if pi >= 0 else QI
		acc.set_local(rig.names[i], qnorm(qinv(Rp) * (q * wp.R[i])))


# ── вторичная динамика ─────────────────────────────────────────────────────────────────────────────────────────
const DT := 1.0 / 240.0


static func secondary_curve(rig: Rig, clip: Dictionary, layer: Dictionary, chain: Array, p: Dictionary) -> Dictionary:
	var base := clip.duplicate()
	base["layers"] = clip["layers"].filter(func(l): return not is_secondary(l))
	var key := JSON.stringify([base, chain, p])
	if rig.sec_cache.has(key):
		return rig.sec_cache[key]
	var i0: int = rig.index[chain[0]]
	var par := rig.parent[i0]
	var axes := chain_axes(rig, chain)
	var last: int = rig.index[chain[chain.size() - 1]]
	var L: float = maxf(0.03, (rig.world_t[last] - rig.world_t[i0]).length() + (0.1 if chain.size() == 1 else 0.0)) * p["length"]
	var d: Vector3 = axes["roll"]
	var rest_par := rig.world_r[par] if par >= 0 else QI
	var w0: float = 2 * PI * p["hz"]
	var dur: float = clip["duration"]
	var steps := maxi(2, roundi(dur / DT))
	var h := dur / steps
	var frames := []
	for k in steps + 3:
		var t := (k - 1) * h
		var tt := fposmod(t, dur) if clip["loop"] else clampf(t, 0.0, dur)
		var w := world_pose(rig, primary(rig, base, tt).parts())
		var R := w.R[par] * qinv(rest_par) if par >= 0 else QI
		frames.append([R, w.T[i0]])
	var g: float = (1 - p["inert"]) * p["gain"]
	var lat := PackedFloat64Array()
	var ver := PackedFloat64Array()
	lat.resize(steps + 1)
	ver.resize(steps + 1)
	var x := [0.0, 0.0]
	var v := [0.0, 0.0]
	var cycles := 5 if clip["loop"] else 1
	for c in cycles:
		for k in steps + 1:
			if c == cycles - 1:
				lat[k] = x[0]
				ver[k] = x[1]
			if k == steps:
				break
			var f0 = frames[k]
			var f1 = frames[k + 1]
			var f2 = frames[k + 2]
			var inv := qinv(f1[0])
			var om0 := qrot(inv, ang_vel(f0[0], f1[0], h))
			var om1 := qrot(inv, ang_vel(f1[0], f2[0], h))
			var alpha := (om1 - om0) * (1.0 / h)
			var A := qrot(inv, (f2[1] - f1[1] * 2 + f0[1]) * (1.0 / (h * h)))
			var torque := alpha * -1.0 + d.cross(A) * (-1.0 / L)
			var dr := [g * torque.dot(axes["lateral"]), g * torque.dot(axes["vertical"])]
			for j in 2:
				v[j] += (dr[j] - 2 * p["damping"] * w0 * v[j] - w0 * w0 * x[j]) * h
				x[j] += v[j] * h
	var res := {"lat": lat, "ver": ver, "dur": dur}
	if rig.sec_cache.size() > 64:
		rig.sec_cache.clear()
	rig.sec_cache[key] = res
	return res


static func add_secondary(acc: Acc, rig: Rig, clip: Dictionary, t: float) -> void:
	for layer in clip["layers"]:
		if not is_secondary(layer):
			continue
		var chain = rig.chains.get(layer["target"]["chain"])
		if chain == null:
			continue
		var p := with_defaults(rig, layer["recipe"], layer.get("params", {}))
		var c := secondary_curve(rig, clip, layer, chain, p)
		var n: int = c["lat"].size() - 1
		var dur: float = c["dur"]
		var tt := fposmod(t, dur) if clip["loop"] else clampf(t, 0.0, dur)
		var f := (tt / dur) * n
		var k := mini(n - 1, floori(f))
		var u := f - k
		var lat: float = (c["lat"][k] + (c["lat"][k + 1] - c["lat"][k]) * u) / DEG
		var ver: float = (c["ver"][k] + (c["ver"][k + 1] - c["ver"][k]) * u) / DEG
		var sum := 0.0
		for j in chain.size():
			sum += float(j + 1) / chain.size()
		var axes := chain_axes(rig, chain)
		var w: float = layer.get("weight", 1.0) if layer.get("weight") != null else 1.0
		for j in chain.size():
			var share: float = (float(j + 1) / chain.size() / sum) * w
			acc.add(chain[j], "lateral", lat * share, func(): return axes)
			acc.add(chain[j], "vertical", ver * share, func(): return axes)


static func secondary_bones(rig: Rig, clip: Dictionary) -> Dictionary:
	var out := {}
	for l in clip["layers"]:
		if is_secondary(l):
			for b in rig.chains.get(l["target"]["chain"], []):
				out[b] = true
	return out


## Вторичная динамика вживую: та же пружина, что в secondary_curve, но раскачивает её настоящее движение в игре —
## поворот и сдвиг персонажа в мире вместе с позой клипа. G — координаты модели → мир; dt — шаг кадра (0 — кадр
## уже посчитан, только приложить); states — состояние пружин по цепочкам (переживает смену клипа).
## Ускорения — по трём последним кадрам назад во времени (вперёд игра не знает), оси — родителя в последнем кадре.
static func live_secondary(acc: Acc, rig: Rig, clip: Dictionary, G: Transform3D, dt: float, states: Dictionary) -> void:
	var w := world_pose(rig, acc.parts())
	var s := G.basis.get_scale().x
	var Gq := G.basis.orthonormalized().get_rotation_quaternion()
	for layer in clip["layers"]:
		if not is_secondary(layer):
			continue
		var chain = rig.chains.get(layer["target"]["chain"])
		if chain == null:
			continue
		var p := with_defaults(rig, layer["recipe"], layer.get("params", {}))
		var i0: int = rig.index[chain[0]]
		var par := rig.parent[i0]
		var axes := chain_axes(rig, chain)
		var last: int = rig.index[chain[chain.size() - 1]]
		var L: float = maxf(0.03, (rig.world_t[last] - rig.world_t[i0]).length() + (0.1 if chain.size() == 1 else 0.0)) * p["length"]
		var d: Vector3 = axes["roll"]
		var w0: float = 2 * PI * p["hz"]
		var key: String = layer["target"]["chain"]
		if not states.has(key):
			states[key] = {"x": [0.0, 0.0], "v": [0.0, 0.0], "h": []}
		var st: Dictionary = states[key]
		if dt > 0:
			var Rm := w.R[par] * qinv(rig.world_r[par]) if par >= 0 else QI
			var h: Array = st["h"]
			h.append([Gq * Rm, (G * w.T[i0]) / s, dt])
			if h.size() > 3:
				h.pop_front()
			var dr := [0.0, 0.0]
			if h.size() == 3:
				var f0 = h[0]
				var f1 = h[1]
				var f2 = h[2]
				var da: float = f1[2]
				var db: float = f2[2]
				var inv := qinv(f2[0])
				var om0 := qrot(inv, ang_vel(f0[0], f1[0], da))
				var om1 := qrot(inv, ang_vel(f1[0], f2[0], db))
				var alpha := (om1 - om0) / db
				var A := qrot(inv, ((f2[1] - f1[1]) / db - (f1[1] - f0[1]) / da) / db)
				var torque := -alpha - d.cross(A) / L
				var g: float = (1 - p["inert"]) * p["gain"]
				dr = [g * torque.dot(axes["lateral"]), g * torque.dot(axes["vertical"])]
			# мелкими шагами, как в записи (1/240 с): полунеявный Эйлер устойчив и на 30 кадрах в секунду
			var n := maxi(1, ceili(dt / DT))
			var hh := dt / n
			for k in n:
				for j in 2:
					st["v"][j] += (dr[j] - 2 * p["damping"] * w0 * st["v"][j] - w0 * w0 * st["x"][j]) * hh
					st["x"][j] += st["v"][j] * hh
		var lat: float = st["x"][0] / DEG
		var ver: float = st["x"][1] / DEG
		var sum := 0.0
		for j in chain.size():
			sum += float(j + 1) / chain.size()
		var wl: float = layer.get("weight", 1.0) if layer.get("weight") != null else 1.0
		for j in chain.size():
			var share: float = (float(j + 1) / chain.size() / sum) * wl
			acc.add(chain[j], "lateral", lat * share, func(): return axes)
			acc.add(chain[j], "vertical", ver * share, func(): return axes)


## Полная поза в момент t (posePartsAt): локальные повороты, сдвиги и масштабы затронутых костей.
## opts.secondary — Callable(acc, rig, clip): вторичная динамика из игры (live_secondary) вместо записанной по клипу.
static func pose_parts_at(rig: Rig, clip: Dictionary, t: float, opts := {}) -> Parts:
	var acc := primary(rig, clip, t, opts)
	if clip["layers"].any(func(l): return is_secondary(l)):
		if opts.has("secondary"):
			opts["secondary"].call(acc, rig, clip)
		else:
			add_secondary(acc, rig, clip, t)
		if not rig.limits.is_empty():
			acc.apply_limits(secondary_bones(rig, clip))
	var parts := acc.parts()
	parts.limited = acc.limited
	return parts


## События клипа от рецептов (clipEvents): без повторов, вне клипа — отброшены, по времени.
static func clip_events(rig: Rig, clip: Dictionary) -> Array:
	var seen := {}
	var out := []
	for l in clip["layers"]:
		if l["type"] != "recipe" or not rig.recipes.has(l["recipe"]):
			continue
		for e in AFRecipes.events(l["recipe"], with_defaults(rig, l["recipe"], l.get("params", {}))):
			var key := "%.4f|%s" % [e["t"], e["name"]]
			if seen.has(key) or e["t"] < 0 or e["t"] > clip["duration"] + 1e-6:
				continue
			seen[key] = true
			out.append({"t": e["t"], "name": e["name"], "layer": l["id"]})
	out.sort_custom(func(a, b): return a["t"] < b["t"])
	return out
