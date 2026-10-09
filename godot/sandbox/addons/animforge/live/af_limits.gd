# Ограничения суставов: точная копия packages/core/src/limits.ts (swing-twist по осям тела или цепочки).
class_name AFLimits
extends RefCounted

const BODY := ["pitch", "yaw", "bank"]


static func limit_frame(rig: AFCore.Rig, bone: String, body: bool) -> Dictionary:
	var i: int = rig.index[bone]
	var names: Array
	var world: Array
	if body:
		var f := AFCore.body_frame(rig)
		names = ["yaw", "pitch", "bank"]
		world = [f.up, f.side, f.forward]
	else:
		var chain = AFCore.chain_of(rig, bone)
		if chain == null:
			chain = [bone]
		var ax := AFCore.chain_axes(rig, chain)
		var roll := AFCore.vnorm(ax["roll"])
		var lat: Vector3 = ax["lateral"] - roll * ax["lateral"].dot(roll)
		lat = AFCore.vnorm(lat) if lat.length() > 1e-6 else AFCore.vnorm(ax["vertical"])
		names = ["roll", "lateral", "vertical"]
		world = [roll, lat, AFCore.vnorm(roll.cross(lat))]
	var inv := AFCore.qinv(rig.world_r[i])
	return {"names": names, "axes": world.map(func(v): return AFCore.qrot(inv, v))}


static func decompose(d: Quaternion, axes: Array) -> Array:
	var t: Vector3 = axes[0]
	var a: Vector3 = axes[1]
	var b: Vector3 = axes[2]
	var p := d.x * t.x + d.y * t.y + d.z * t.z
	var twist := Quaternion(t.x * p, t.y * p, t.z * p, d.w)
	var n := sqrt(twist.x * twist.x + twist.y * twist.y + twist.z * twist.z + twist.w * twist.w)
	twist = AFCore.QI if n < 1e-9 else Quaternion(twist.x / n, twist.y / n, twist.z / n, twist.w / n)
	if twist.w < 0:
		twist = Quaternion(-twist.x, -twist.y, -twist.z, -twist.w)
	var tw := 2.0 * atan2(twist.x * t.x + twist.y * t.y + twist.z * t.z, twist.w)
	var sw := d * AFCore.qinv(twist)
	if sw.w < 0:
		sw = Quaternion(-sw.x, -sw.y, -sw.z, -sw.w)
	var s := sqrt(sw.x * sw.x + sw.y * sw.y + sw.z * sw.z)
	var ang := 2.0 * atan2(s, sw.w)
	var rv := Vector3.ZERO if s < 1e-9 else Vector3(sw.x / s, sw.y / s, sw.z / s) * ang
	return [tw / AFCore.DEG, rv.dot(a) / AFCore.DEG, rv.dot(b) / AFCore.DEG]


static func compose(angles: Array, axes: Array) -> Quaternion:
	var t: Vector3 = axes[0]
	var rv: Vector3 = (axes[1] * angles[1] + axes[2] * angles[2]) * AFCore.DEG
	var ang := rv.length()
	var swing := AFCore.QI if ang < 1e-12 else AFCore.qaxis(rv / ang, ang)
	return AFCore.qnorm(swing * AFCore.qaxis(t, angles[0] * AFCore.DEG))


static func clamp_rotation(rig: AFCore.Rig, bone: String, lim: Dictionary, d: Quaternion, base: Quaternion = AFCore.QI) -> Dictionary:
	if lim.is_empty():
		return {"d": d, "hit": false}
	var body: bool = lim.keys().any(func(k): return k in BODY)
	var fr := limit_frame(rig, bone, body)
	var motion := d * AFCore.qinv(base)
	var ang := decompose(motion, fr["axes"])
	var hit := false
	var out := []
	for k in 3:
		var v: float = ang[k]
		var r = lim.get(fr["names"][k])
		if r == null:
			out.append(v)
			continue
		var c := clampf(v, minf(r[0], r[1]), maxf(r[0], r[1]))
		if absf(c - v) > 1e-6:
			hit = true
		out.append(c)
	if not hit:
		return {"d": d, "hit": false}
	return {"d": AFCore.qnorm(compose(out, fr["axes"]) * base), "hit": true}
