# Рецепты анимации — точная копия packages/core/src/recipes.ts: каналы кости chain[i] в момент t.
# Углы в градусах, сдвиги в метрах, масштаб — множитель. Совпадение с ядром проверяет `pnpm af recipes.verify`.
# p — уже со всеми параметрами (значения по умолчанию подставляет вызывающий); info = {"height": float, "size": float}.
class_name AFRecipes
extends RefCounted

const RAD := PI / 180.0
const SECONDARY := ["jiggle"]
const RECIPES := ["wave", "curl", "compass-step", "waddle-walk", "blink", "jiggle", "melee-strike", "charge-release", "quadruped-gait", "multileg-gait", "wing-flap", "hover", "tentacle-strike", "emerge", "body-ram", "tremble", "hit-react", "idle-glance", "startle", "scare-pose", "zero-g-float", "power-down", "head-look-peck"]


static func is_secondary(recipe: String) -> bool:
	return recipe in SECONDARY


static func evaluate(recipe: String, p: Dictionary, i: int, n: int, t: float, info: Dictionary) -> Dictionary:
	match recipe:
		"wave": return _wave(p, i, n, t)
		"curl": return _curl(p, i, n, t)
		"compass-step": return _compass_step(p, i, n, t)
		"waddle-walk": return _waddle_walk(p, i, n, t, info)
		"blink": return _blink(p, t)
		"jiggle": return {}  # вторичная динамика — симуляция по остальным слоям, не формула
		"melee-strike": return _melee_strike(p, i, t, info)
		"charge-release": return _charge_release(p, i, t, info)
		"quadruped-gait": return _quadruped_gait(p, i, n, t, info)
		"multileg-gait": return _multileg_gait(p, i, n, t, info)
		"wing-flap": return _wing_flap(p, i, n, t, info)
		"hover": return _hover(p, i, t, info)
		"tentacle-strike": return _tentacle_strike(p, i, n, t)
		"emerge": return _emerge(p, i, t, info)
		"body-ram": return _body_ram(p, i, t, info)
		"tremble": return _tremble(p, i, n, t)
		"hit-react": return _hit_react(p, i, t, info)
		"idle-glance": return _idle_glance(p, n, t)
		"startle": return _startle(p, i, t, info)
		"scare-pose": return _scare_pose(p, i, t, info)
		"zero-g-float": return _zero_g(p, i, t, info)
		"power-down": return _power_down(p, i, n, t, info)
		"head-look-peck": return _head_look_peck(p, i, n, t)
	push_error("AFRecipes: нет рецепта «%s»" % recipe)
	return {}


static func events(recipe: String, p: Dictionary) -> Array:
	match recipe:
		"melee-strike": return _melee_events(p)
		"charge-release": return _charge_events(p)
		"tentacle-strike":
			# удар основания; при delay > 0 конец бьёт позже на delay·(n − 1) — число костей здесь неизвестно
			return [{"t": to_fixed(p["windupT"] + p["strikeT"], 4), "name": "hit"}]
		"body-ram": return _ram_events(p)
		"hit-react": return _react_events(p)
		"power-down": return _power_events(p)
		"zero-g-float": return [{"t": to_fixed(0.45 * p["period"], 4), "name": "breath"}]
		"scare-pose": return [{"t": to_fixed(_scare_keys(p)[2], 4), "name": "manifest"}]
		"startle":
			var sev := []
			for e in STARTLE[p["kind"]]["ev"]:
				sev.append({"t": to_fixed(e[0] / p["speed"], 4), "name": e[1]})
			return sev
		"idle-glance":
			var ev := []
			for s0 in _glance_plan(p)["starts"]:
				ev.append({"t": to_fixed(s0, 4), "name": "glance"})
			return ev
	return []


static func length(recipe: String, p: Dictionary) -> float:
	match recipe:
		"melee-strike":
			# клип — до закрытия окна ввода, но не короче 0,3 с после его открытия (рука уже вернулась)
			var ev := _melee_events(p)
			var open := 1.3
			var close := 0.0
			for e in ev:
				if e["name"] == "window_open":
					open = e["t"]
					break
			for e in ev:
				if e["name"] == "window_close":
					close = e["t"]
					break
			return to_fixed(maxf(open + 0.3, close), 3)
		"charge-release": return to_fixed(p["windup"] + p["hold"] + p["release"] + 0.3, 3)
		"tentacle-strike": return to_fixed(p["windupT"] + p["strikeT"] + p["hold"] + p["returnT"] + 0.3, 3)
		"body-ram": return to_fixed(_ram_keys(p)["ev"]["f"] + p["tail"], 3)
		"hit-react": return p["duration"]
		"scare-pose": return to_fixed(_scare_keys(p)[4], 3)
		"power-down":
			match p["mode"]:
				"in": return to_fixed(p["inT"], 3)
				"out": return to_fixed(p["outT"], 3)
				"hang": return to_fixed(p["bobPeriod"], 3)
			return to_fixed(p["inT"] + p["hang"] + p["outT"], 3)
		"startle":
			var st: Array = STARTLE[p["kind"]]["t"]
			return to_fixed(st[st.size() - 1] / p["speed"], 3)
	return -1.0


# ── вспомогательное ─────────────────────────────────────────────────────────────────────────────────────────────

## Как +x.toFixed(d) в JS: ближайшее десятичное с d знаками, ровно посередине — от нуля (printf берёт чётное).
static func to_fixed(x: float, d: int) -> float:
	if is_nan(x) or is_inf(x):
		return x
	var ax := absf(x)
	var scale := pow(10.0, d)
	var s: String = ("%." + str(d) + "f") % ax
	var k := int(s.replace(".", ""))
	if _is_tie(ax, d):
		k = int(ceil(ax * scale))  # ax·10^d = k + 0.5 точно, умножение без погрешности
	var r := k / scale
	return -r if x < 0 else r


## 2·x·10^d — нечётное целое? Тогда x ровно посередине между соседями. По битам double.
static func _is_tie(x: float, d: int) -> bool:
	if x == 0.0:
		return false
	var b := PackedByteArray()
	b.resize(8)
	b.encode_double(0, x)
	var bits := b.decode_s64(0)
	var e := (bits >> 52) & 0x7FF
	var m := bits & 0xFFFFFFFFFFFFF
	if e == 0:
		e = 1
	else:
		m |= 1 << 52
	var q: int = e - 1075 + 1 + d  # 2·x·10^d = m·5^d·2^q
	if q > 0:
		return false
	var v2 := 0
	while m & 1 == 0:
		m >>= 1
		v2 += 1
	return v2 == -q


static func _smooth(x: float) -> float:
	x = minf(1.0, maxf(0.0, x))
	return x * x * (3.0 - 2.0 * x)


static func _fmod1(u: float) -> float:
	return fmod(fmod(u, 1.0) + 1.0, 1.0)


# ── wave, curl ──────────────────────────────────────────────────────────────────────────────────────────────────

static func _wave(p: Dictionary, i: int, n: int, t: float) -> Dictionary:
	var w: float = 2.0 * PI * (t / p["period"])
	if p["headAmp"] > 0:
		if i == 0:
			return {p["plane"]: p["headAmp"] * sin(w + p["headLead"] * RAD)}
		i -= 1
		n -= 1
	var amp: float = p["tipAmp"] * pow(float(i + 1) / n, p["growth"])
	var dphi: float = (p["bodyDelay"] / (n - 1)) * RAD if n > 1 else 0.0
	return {p["plane"]: amp * sin(w - i * dphi)}


static func _curl(p: Dictionary, i: int, n: int, t: float) -> Dictionary:
	# веса костей ∝ ((i+1)/n)^growth, нормированы так, что сумма углов = angle
	var sum := 0.0
	for j in n:
		sum += pow(float(j + 1) / n, p["growth"])
	var share: float = pow(float(i + 1) / n, p["growth"]) / sum
	var k: float = 1 + p["pulse"] * sin(2.0 * PI * (t / p["period"]) + (p["phase"] * PI) / 180.0)
	return {p["plane"]: p["angle"] * share * k}


# ── compass-step: пружина по периодической цели ─────────────────────────────────────────────────────────────────
# Пружина второго порядка x'' = ω²(цель − x) − 2ζωx'. Возвращает установившийся цикл — зависит только от фазы.
static var _spring_cache := {}


## Цель — поза циркуля _compass_target(p, τ) (в ядре — функция-аргумент; здесь единственный потребитель).
static func _spring_cycle(key: Array, period: float, hz: float, zeta: float, p: Dictionary) -> PackedFloat64Array:
	if _spring_cache.has(key):
		return _spring_cache[key]
	var steps: int = maxi(8, int(ceil(period * 480)))
	var dt := period / steps
	var w := 2.0 * PI * hz
	var x: float = _compass_target(p, 0.0)
	var v := 0.0
	var out := PackedFloat64Array()
	out.resize(steps + 1)
	for cycle in 6:
		for k in steps:
			if cycle == 5:
				out[k] = x
			# полунеявный Эйлер: устойчив при ω·dt ≪ 1
			v += (w * w * (_compass_target(p, k * dt) - x) - 2.0 * zeta * w * v) * dt
			x += v * dt
	out[steps] = out[0]
	if _spring_cache.size() > 256:
		_spring_cache.clear()
	_spring_cache[key] = out
	return out


static func _compass_ramp(p: Dictionary, tau: float) -> float:
	return minf(1.0, tau / p["openTime"])


static func _compass_leg_l(p: Dictionary, tau: float) -> float:
	var half: float = p["period"] / 2.0
	return p["gain"] * (p["reach"] * _compass_ramp(p, tau) if tau < half else -p["support"] * _compass_ramp(p, tau - half))


static func _compass_target(p: Dictionary, tau: float) -> float:
	var half: float = p["period"] / 2.0
	if p["role"] == "leg_left":
		return _compass_leg_l(p, tau)
	if p["role"] == "leg_right":
		return _compass_leg_l(p, fmod(tau + half, p["period"]))
	return p["gain"] * (-p["coreRoll"] * _compass_ramp(p, tau) if tau < half else p["coreRoll"] * _compass_ramp(p, tau - half))


static func _compass_step(p: Dictionary, i: int, _n: int, t: float) -> Dictionary:
	if i > 0:
		return {}  # нога циркуля жёсткая, корпус кренится целиком
	var key := [p["role"], p["gain"], p["period"], p["reach"], p["support"], p["coreRoll"], p["openTime"], p["springHz"], p["damping"]]
	var cyc := _spring_cycle(key, p["period"], p["springHz"], p["damping"], p)
	var steps := cyc.size() - 1
	var P: float = p["period"]
	var f := (fmod(fmod(t, P) + P, P) / P) * steps
	var k := mini(steps - 1, int(floor(f)))
	return {p["plane"]: cyc[k] + (cyc[k + 1] - cyc[k]) * (f - k)}


# ── waddle-walk ─────────────────────────────────────────────────────────────────────────────────────────────────
# Подскок таза Tools Up!: высоты по 14 кадрам шага, нормированы к [−1, 0]; между кадрами — замкнутый Catmull-Rom.
const BOB_H := [0.490, 0.452, 0.416, 0.398, 0.409, 0.438, 0.469, 0.491, 0.505, 0.512, 0.515, 0.515, 0.514, 0.507]
static var _bob := []


static func _bob_at(s: float) -> float:
	if _bob.is_empty():
		var hi: float = BOB_H.max()
		var lo: float = BOB_H.min()
		for h in BOB_H:
			_bob.append((h - hi) / (hi - lo))
	return periodic(_bob, s)


static func _waddle_walk(p: Dictionary, i: int, _n: int, t: float, info: Dictionary) -> Dictionary:
	var w: float = (2.0 * PI * t) / p["period"]
	var sw := sin(w)
	# углы замерены в осях персонажа; слой отдаёт разницу «своё − родителя»
	var pelvis := {"yaw": p["pelvisYaw"] * sw, "bank": p["pelvisRoll"] * sin(w + p["rollPhase"] * RAD)}
	var chest := {"yaw": p["chestCounter"] * p["pelvisYaw"] * sin(w + p["chestPhase"] * RAD), "bank": p["chestRoll"] * sin(w + (p["rollPhase"] - 2) * RAD)}
	var head := {"yaw": p["headYaw"] * sin(w + PI), "bank": p["headRoll"] * sin(w + (p["rollPhase"] + p["headLag"]) * RAD)}
	match p["role"]:
		"pelvis":
			if i > 0:
				return {}
			# 2 шага за цикл → подскок вдвое чаще; низ шага — когда нога впереди принимает вес
			return {"yaw": pelvis["yaw"], "bank": pelvis["bank"], "move_up": p["bob"] * info.get("height", 0.0) * _bob_at((2.0 * t) / p["period"] - 0.5 + 3.0 / 14.0)}
		"chest":
			if i > 0:
				return {}
			var r := {"yaw": chest["yaw"] - pelvis["yaw"], "bank": chest["bank"] - pelvis["bank"]}
			if p["chestBow"] != 0:
				r["pitch"] = p["chestBow"] * cos(2.0 * w)  # поклон дважды за цикл
			return r
		"head":
			if i > 0:
				return {}
			var hr := {"yaw": head["yaw"] - chest["yaw"], "bank": head["bank"] - chest["bank"]}
			if p.get("headNod", 0.0) != 0:  # в файлах до headNod его нет в схеме
				# кивок в мире минус поклон груди, на которой сидит голова
				hr["pitch"] = p["headNod"] * cos(2.0 * w + p.get("nodPhase", 0.0) * RAD) - p["chestBow"] * cos(2.0 * w)
			return hr
		"arm_l", "arm_r":
			if i > 0:
				return {}
			var s := 1.0 if p["role"] == "arm_l" else -1.0
			return {"pitch": -s * p["armSwing"] * sin(w - p.get("armLag", 0.0) * RAD)}  # − : свисающая рука вперёд
	# нога: бедро — маятник в противофазе своей руке; колено гнётся в переносе
	var s := -1.0 if p["role"] == "leg_l" else 1.0
	var wl: float = w + p.get("legPhase", 0.0) * RAD
	if i == 0:
		return {"pitch": -s * p["legSwing"] * sin(wl)}
	if i == 1:
		return {"pitch": p["knee"] * maxf(0.0, s * cos(wl))}
	return {}


# ── blink ───────────────────────────────────────────────────────────────────────────────────────────────────────

static func _blink(p: Dictionary, t: float) -> Dictionary:
	var I: float = p["interval"]
	var tt := fmod(fmod(t, I) + I, I)
	var c: float = p["close"]
	var h: float = c + p["hold"]
	var o: float = h + p["open"]
	var e: float = o + p["settle"]
	var y: float
	var x: float
	if tt < c:
		var k := _smooth(tt / c)
		y = 1 + (p["minY"] - 1) * k
		x = 1 + (p["widenX"] - 1) * k
	elif tt < h:
		y = p["minY"]
		x = p["widenX"]
	elif tt < o:
		var k := _smooth((tt - h) / p["open"])
		y = p["minY"] + (p["overshoot"] - p["minY"]) * k
		x = p["widenX"] + (1 - p["widenX"]) * k
	elif tt < e:
		y = p["overshoot"] + (1 - p["overshoot"]) * _smooth((tt - o) / p["settle"])
		x = 1
	else:
		y = 1
		x = 1
	return {"scale_up": y, "scale_side": x}


# ── удары ───────────────────────────────────────────────────────────────────────────────────────────────────────
# Взмах — ease с треугольной скоростью: разгон до пика в доле a, затем торможение. Пик скорости — момент контакта.
static func swing_ease(u: float, a: float) -> float:
	u = minf(1.0, maxf(0.0, u))
	return (u * u) / a if u <= a else 1 - ((1 - u) * (1 - u)) / (1 - a)


## Угол руки по фазе и доля «к замаху» w — для сгиба локтя.
static func _arm_path(pos: float, phase: String, up: float, follow: float) -> Dictionary:
	if phase == "swing" or phase == "hold":
		var w := (pos + 1) / 2.0
		return {"angle": follow + (up - follow) * w, "w": w}
	if pos >= 0:
		return {"angle": up * pos, "w": pos}  # замах или возврат со стороны замаха
	return {"angle": follow * -pos, "w": 0.0}  # возврат из доводки


## Траектория серии ударов в долях: начало первого взмаха s0, длина взмаха, моменты попаданий, конец.
static func strike_plan(p: Dictionary) -> Dictionary:
	var k: float = 1.0 / p["tempo"]
	var strike: float = p["strike"] * k
	var follow: float = p["follow"] * k
	var hit_lag: float = p["hitLag"] * k
	var recover: float = p["recover"] * k
	var tail: float = p["tail"] * k
	var swing: float = p["interval"] * k if p["hits"] > 1 else strike + follow  # в серии каждый взмах длится interval
	var a := strike / (strike + follow)
	var first_hit := maxf(p["firstHit"] * k, hit_lag + a * swing + 0.05)
	var s0 := first_hit - hit_lag - a * swing
	var hits := []
	for i in _js_len(p["hits"]):
		hits.append(first_hit + i * swing)
	var end: float = s0 + p["hits"] * swing
	return {"s0": s0, "swing": swing, "a": a, "hits": hits, "end": end, "recover": recover, "tail": tail, "total": end + recover + tail}


## Array.from({length: x}) — длина как ToLength в JS.
static func _js_len(x: float) -> int:
	return 0 if is_nan(x) or x <= 0 else int(floor(x))


static func strike_pos(p: Dictionary, t: float) -> Dictionary:
	var pl := strike_plan(p)
	if t < 0:
		return {"pos": 0.0, "phase": "ready", "i": 0}
	if t < pl["s0"]:
		return {"pos": _smooth(t / pl["s0"]), "phase": "windup", "i": 0}  # замах inOut до +1
	if t < pl["end"]:
		var i := int(floor((t - pl["s0"]) / pl["swing"]))
		var from := 1.0 if i % 2 == 0 else -1.0  # взмахи чередуются: замах → доводка → обратно
		return {"pos": from - 2 * from * swing_ease((t - pl["s0"] - i * pl["swing"]) / pl["swing"], pl["a"]), "phase": "swing", "i": i}
	var last := -1.0 if fmod(p["hits"], 2.0) == 1.0 else 1.0
	if t < pl["end"] + pl["recover"]:
		return {"pos": last * (1 - _smooth((t - pl["end"]) / pl["recover"])), "phase": "recover", "i": p["hits"] - 1}
	return {"pos": 0.0, "phase": "rest", "i": p["hits"] - 1}


static func _melee_strike(p: Dictionary, i: int, t: float, info: Dictionary) -> Dictionary:
	if i > 1 or (p["role"] != "arm" and i > 0):
		return {}
	var tt: float = t - p["start"]
	var sp := strike_pos(p, tt)
	var pos: float = sp["pos"]
	var phase: String = sp["phase"]
	match p["role"]:
		"arm":
			# pitch < 0 — свисающая рука вперёд-вверх; локоть сгибается тоже «вперёд»
			var a := _arm_path(pos, phase, p["windupAngle"], p["followAngle"])
			var ch := "bank" if p["plane"] == "lateral" else "pitch"
			var sgn := (-1.0 if p["side"] == "l" else 1.0) if p["plane"] == "lateral" else -1.0
			return {ch: sgn * a["angle"]} if i == 0 else {"pitch": -p["elbow"] * a["w"]}
		"core":
			return {"yaw": pos * p["coreTwist"] * (-1.0 if p["side"] == "l" else 1.0), "pitch": -pos * p["coreLean"]}
	var h: float = info.get("height", 0.0)
	var pl := strike_plan(p)
	var dip := 0.0
	if phase == "windup" or phase == "swing":
		dip -= p["crouch"] * h * maxf(0.0, pos) * (1.0 if phase == "windup" else 1 - swing_ease((tt - pl["s0"]) / pl["swing"], pl["a"]))
	# оседание после последнего удара: опускание за доводку, возврат за recover
	var tl: float = pl["hits"][pl["hits"].size() - 1]
	var fall: float = (pl["end"] - tl) + pl["recover"] * 0.5
	if tt > tl:
		dip -= p["settle"] * h * sin(PI * minf(1.0, (tt - tl) / (fall + pl["recover"] * 0.5)))
	return {"move_up": dip}


static func _melee_events(p: Dictionary) -> Array:
	var pl := strike_plan(p)
	var ev := []
	for h in pl["hits"]:
		ev.append_array([{"t": h - p["effortLead"] / p["tempo"], "name": "effort"}, {"t": h - p["whooshLead"] / p["tempo"], "name": "whoosh"}])
		ev.append_array([{"t": h - p["trailLead"] / p["tempo"], "name": "trail_on"}, {"t": h, "name": "hit"}, {"t": h + p["trailLag"] / p["tempo"], "name": "trail_off"}])
	ev.append_array([{"t": pl["end"] + pl["recover"], "name": "window_open"}, {"t": pl["total"], "name": "window_close"}])
	for k in ev.size():
		ev[k] = {"t": to_fixed(ev[k]["t"] + p["start"], 4), "name": ev[k]["name"], "_k": k}
	# сортировка в JS устойчивая — при равном t порядок сохраняется
	ev.sort_custom(func(a, b): return a["t"] < b["t"] or (a["t"] == b["t"] and a["_k"] < b["_k"]))
	for e in ev:
		e.erase("_k")
	return ev


static func _charge_release(p: Dictionary, i: int, t: float, info: Dictionary) -> Dictionary:
	if i > 1 or (p["role"] != "arm" and i > 0):
		return {}
	var lag := 0.053  # контакт после пика скорости запястья (Witcher, медиана 245 ударов)
	var A: float = p["windup"]
	var B: float = A + p["hold"]
	var h1: float = B + p["hit1"] - lag
	var h2: float = B + p["hit2"] - lag
	var E: float = B + p["release"]
	# pos: 0 → +1 замах; держим; к h1 — взмах в −1; к h2 — обратно в +0.6; к E — в 0
	var pos: float
	var phase: String
	var m1 := h1 + (h2 - h1) / 2.0
	var m2 := h2 + (E - h2) / 2.0
	if t < A:
		pos = _smooth(t / A)
		phase = "windup"
	elif t < B:
		pos = 1
		phase = "hold"
	elif t < m1:
		pos = 1 - 2 * swing_ease((t - B) / (m1 - B), (h1 - B) / (m1 - B))
		phase = "swing"
	elif t < m2:
		pos = -1 + 1.6 * swing_ease((t - m1) / (m2 - m1), (h2 - m1) / (m2 - m1))
		phase = "swing"
	else:
		pos = 0.6 * (1 - _smooth((t - m2) / (E - m2)))
		phase = "recover"
	if p["role"] == "arm":
		# в возврате рука идёт из точки второго взмаха (0.6 пути к замаху) в покой
		var a: Dictionary
		if phase == "recover":
			a = {"angle": (p["followAngle"] + (p["windupAngle"] - p["followAngle"]) * 0.8) * (pos / 0.6), "w": 0.8 * (pos / 0.6)}
		else:
			a = _arm_path(pos, phase, p["windupAngle"], p["followAngle"])
		return {"pitch": -a["angle"]} if i == 0 else {"pitch": -p["elbow"] * a["w"]}
	if p["role"] == "core":
		return {"yaw": pos * p["coreTwist"]}
	var hgt: float = info.get("height", 0.0)
	var charge: float
	if t < A:
		charge = _smooth(t / A)
	elif t < B:
		charge = 1
	else:
		charge = 1 - _smooth((t - B) / maxf(1e-6, p["hit1"]))
	var bob: float = p["holdBob"] * hgt * 0.5 * (1 - cos((2.0 * PI * (t - A)) / p["holdPeriod"])) if t >= A and t < B else 0.0
	return {"move_up": -p["crouch"] * hgt * charge - bob}


static func _charge_events(p: Dictionary) -> Array:
	var B: float = p["windup"] + p["hold"]
	var ev := [{"t": 0.0, "name": "charge_start"}, {"t": p["windup"], "name": "charge_full"}, {"t": B + p["hit1"], "name": "hit"}, {"t": B + p["hit2"], "name": "hit"}, {"t": B + p["release"], "name": "window_open"}]
	for e in ev:
		e["t"] = to_fixed(e["t"], 4)
	return ev


# ── четвероногие: собака Witcher ────────────────────────────────────────────────────────────────────────────────
# Кривые суставов лап за цикл, 20 отсчётов: + — конец кости вперёд; j0 — плечо/бедро от вертикали мира, j1…j3 — сустав
# относительно родителя. Фаза 0 — лапа дальше всего впереди. body — гармоники [амплитуда, пик в долях цикла].
const QUAD := {
	"walk": {
		"fore": [[36.8, 34.9, 26.0, 18.9, 12.7, 7.9, 4.0, 0.5, -2.7, -5.5, -8.1, -12.1, -19.1, -25.0, -29.8, -32.2, -24.3, -9.9, 4.7, 22.6], [-18.6, -23.9, -16.5, -12.0, -7.3, -4.2, -2.8, -2.7, -3.7, -5.8, -8.6, -9.3, -6.6, -5.5, -1.2, 16.7, 32.5, 39.1, 32.7, 7.8], [10.1, 5.8, 0.3, 2.3, 4.9, 7.1, 10.2, 13.9, 18.1, 22.5, 26.7, 27.9, 23.9, 19.2, 9.7, -17.8, -52.2, -69.6, -51.7, -12.1], [-28.3, -16.8, -9.8, -9.2, -10.2, -10.9, -11.4, -11.7, -11.6, -11.1, -10.0, -6.4, 1.8, 11.3, 21.2, 33.3, 44.0, 40.3, 14.3, -18.4]],
		"hind": [[17.1, 18.3, 18.2, 14.3, 7.8, 0.2, -7.9, -15.6, -21.1, -23.5, -24.2, -23.3, -23.1, -24.5, -13.8, -0.1, 16.7, 28.7, 30.2, 24.6], [25.0, 15.0, 4.7, -0.8, -1.9, 0.0, 4.5, 9.6, 12.1, 10.2, 6.5, 2.0, -0.2, 1.1, -10.8, -23.2, -28.4, -21.8, -10.0, 8.6], [-30.3, -18.6, -7.5, 1.2, 8.0, 12.0, 13.1, 12.2, 10.6, 8.9, 6.3, 2.7, -1.9, -4.6, 4.7, 12.3, 9.0, -3.4, -13.0, -23.2], [29.3, 7.9, -1.9, -1.3, -0.3, 1.4, 3.9, 6.6, 9.0, 10.8, 11.8, 8.9, 3.6, -2.8, -16.0, -26.4, -26.7, -19.9, -7.5, 12.8]],
		"body": {"spine_pitch": [[0.078, 0.94], [1.087, 0.047]], "spine_yaw": [[3.54, 0.156], [0.103, 0.126]], "neck_pitch": [[0.499, 0.056], [3.008, 0.033]], "neck_yaw": [[2.539, 0.712], [0.549, 0.43]], "pelvis_bob_m": [[0.004, 0.314], [0.007, 0.288]]},
		"pelvisH": 0.531,
	},
	"run": {
		"fore": [[60.5, 42.7, 24.8, 8.5, -4.1, -10.7, -16.1, -22.3, -31.0, -30.6, -26.7, -25.7, -33.6, -31.6, -20.4, -5.2, 9.1, 23.2, 38.1, 51.4], [-39.6, -23.8, -9.3, 2.2, 8.6, 5.3, 1.7, -1.4, -3.4, -14.1, -26.3, -26.0, 0.7, 21.5, 33.6, 37.5, 34.6, 22.3, -0.1, -23.8], [29.5, 28.0, 25.4, 23.0, 22.2, 24.3, 24.3, 22.2, 17.8, 10.3, 4.3, -4.0, -19.0, -32.6, -44.7, -51.3, -49.3, -36.8, -10.4, 16.8], [-50.3, -46.9, -40.9, -33.7, -26.7, -18.9, -9.9, 1.4, 16.6, 34.3, 48.7, 55.7, 51.9, 42.7, 31.5, 19.0, 5.6, -8.7, -27.6, -44.4]],
		"hind": [[25.3, 22.1, 17.7, 12.0, 5.1, -5.3, -15.6, -23.2, -25.5, -25.7, -21.2, -14.4, -7.4, -3.4, -1.3, 0.7, 4.3, 12.3, 19.5, 24.4], [23.8, 17.2, 6.6, -4.2, -11.2, -7.8, 0.7, 9.3, 13.2, 14.7, 6.1, -7.7, -22.0, -26.4, -21.8, -12.8, -4.0, 1.3, 8.5, 16.5], [-22.2, -16.1, -7.7, 0.1, 4.5, 1.6, -6.7, -17.5, -28.0, -31.7, -22.9, -6.5, 12.9, 27.3, 35.4, 37.5, 33.3, 18.7, 1.6, -13.5], [11.1, 13.0, 18.3, 22.4, 20.8, 18.1, 14.3, 7.7, -2.9, -11.8, -16.5, -18.6, -20.1, -20.3, -19.5, -17.0, -12.2, -3.8, 5.1, 11.1]],
		"body": {"spine_pitch": [[11.266, 0.004], [1.248, 0.344]], "spine_yaw": [[2.074, 0.87], [0.503, 0.365]], "neck_pitch": [[8.489, 0.805], [1.223, 0.027]], "neck_yaw": [[1.762, 0.449], [0.649, 0.109]], "pelvis_bob_m": [[0.038, 0.528], [0.004, 0.051]]},
		"pelvisH": 0.517,
	},
}
const QUAD_ROLES := {"pelvis": "pelvis", "spine": "spine", "neck": "neck", "leg_fl": "arm_l", "leg_fr": "arm_r", "leg_hl": "leg_l", "leg_hr": "leg_r"}


## Периодическая таблица → значение в доле цикла s (Катмулл-Ром, без излома на стыке цикла).
static func periodic(tab: Array, s: float) -> float:
	var n := tab.size()
	var f := _fmod1(s) * n
	var k := int(floor(f))
	var u := f - k
	var p0: float = tab[(k - 1 + n) % n]
	var p1: float = tab[k]
	var p2: float = tab[(k + 1) % n]
	var p3: float = tab[(k + 2) % n]
	return 0.5 * (2 * p1 + (p2 - p0) * u + (2 * p0 - 5 * p1 + 4 * p2 - p3) * u * u + (3 * p1 - p0 - 3 * p2 + p3) * u * u * u)


static func _harm_at(h: Array, s: float) -> float:
	var a := 0.0
	for k in h.size():
		a = a + h[k][0] * cos(2.0 * PI * (k + 1) * (s - h[k][1]))
	return a


static func _quadruped_gait(p: Dictionary, i: int, n: int, t: float, info: Dictionary) -> Dictionary:
	var g: Dictionary = QUAD.get(p["gait"], QUAD["walk"])
	var s: float = t / p["period"]
	# корпус носом вверх (+): поворачиваем таз — всё тело качается вокруг бёдер
	var nose: float = p["body"] * _harm_at(g["body"]["spine_pitch"], s)
	var bend: float = p["body"] * _harm_at(g["body"]["spine_yaw"], s)  # + — грудь влево
	match p["role"]:
		"pelvis":
			if i > 0:
				return {}
			return {"pitch": -nose, "move_up": p["bob"] * info.get("height", 0.0) * _harm_at(g["body"]["pelvis_bob_m"], s) / g["pelvisH"]}
		"spine":
			return {"yaw": bend / n}
		"neck":
			# шея замерена в мире: отдаём разницу с корпусом, делим на кости шеи
			return {"pitch": -(p["body"] * _harm_at(g["body"]["neck_pitch"], s) - nose) / n, "yaw": (p["body"] * _harm_at(g["body"]["neck_yaw"], s) - bend) / n}
	var fore: bool = p["role"] == "leg_fl" or p["role"] == "leg_fr"
	var off: float = {"leg_fl": 0.0, "leg_fr": p["offsetFR"], "leg_hl": p["offsetHL"], "leg_hr": p["offsetHR"]}.get(p["role"], NAN)
	# у длинной цепочки (лопатка/таз + 4 кости) первую кость не трогаем
	var j := i - (1 if n >= 5 else 0)
	if j < 0 or j > 3:
		return {}
	var a: float = p["legs"] * periodic((g["fore"] if fore else g["hind"])[j], s - off)
	if j == 0:
		a -= nose  # плечо и бедро замерены от вертикали мира, а корпус уже качнули
	return {"pitch": -a}  # + угла — конец кости вперёд, а pitch + уводит висящую кость назад


# ── многоногие: волна шагов по ногам ────────────────────────────────────────────────────────────────────────────
## Фаза ноги k (0 — передняя пара): −k·lag — задние шагают раньше; правая сторона + side.
static func multileg_phase(p: Dictionary, side: String, k: int, t: float) -> float:
	var u: float = t / p["period"] - (-k * p["lag"] + (p["side"] if side == "r" else 0.0))
	return _fmod1(u)


## Профиль ноги: protract — вынос вперёд (+1 впереди, −1 сзади), lift — подъём 0…1 (только в переносе).
static func leg_profile(ph: float, duty: float) -> Dictionary:
	if ph < duty:
		return {"protract": 1 - (2 * ph) / duty, "lift": 0.0}
	var w := (ph - duty) / (1 - duty)
	return {"protract": -cos(PI * w), "lift": sin(PI * w)}


static var _leg_re: RegEx


static func _multileg_gait(p: Dictionary, i: int, _n: int, t: float, info: Dictionary) -> Dictionary:
	var cyc: float = 2.0 * PI * (t / p["period"])
	if p["role"] == "pelvis":
		return {} if i > 0 else {"yaw": p["pelvisYaw"] * cos(cyc - 2.0 * PI * 0.07), "move_up": p["bob"] * info.get("height", 0.0) * cos(2.0 * cyc)}
	if p["role"] == "chest":
		return {} if i > 0 else {"bank": p["chestRoll"] * cos(cyc - 2.0 * PI * 0.57), "yaw": -0.67 * p["pelvisYaw"] * cos(cyc - 2.0 * PI * 0.07)}
	if p["role"] == "spine":
		if p["bodyWave"] == 0:
			return {}
		return {"yaw": p["bodyWave"] * sin(2.0 * PI * (t / p["period"] + i * p["waveLag"]))}
	if _leg_re == null:
		_leg_re = RegEx.create_from_string("^leg_([lr])(\\d+)$")
	var m := _leg_re.search(p["role"])
	if m == null:
		return {}
	var s := m.get_string(1)
	var k := int(m.get_string(2))
	var lp := leg_profile(multileg_phase(p, s, k, t), p["duty"])
	var sgn := 1.0 if s == "l" else -1.0
	# вокруг вертикали: + уводит левую ногу назад, правую — вперёд; vertical + поднимает
	if i == 0:
		return {"yaw": -sgn * p["swing"] * lp["protract"], "vertical": p["lift"] * lp["lift"]}
	if i == 1:
		return {"vertical": -p["fold"] * lp["lift"]}
	return {}


# ── крылья: машущий полёт ───────────────────────────────────────────────────────────────────────────────────────
## Профиль взмаха: +1 — крыло вверху (u = 0), −1 — внизу (u = down). Вниз — рабочий ход, вверх — возврат.
static func flap_profile(u: float, down: float) -> float:
	u = _fmod1(u)
	return cos((PI * u) / down) if u < down else -cos((PI * (u - down)) / (1 - down))


static func _wing_flap(p: Dictionary, i: int, n: int, t: float, info: Dictionary) -> Dictionary:
	var u: float = t / p["period"]
	match p["role"]:
		"body":
			if i > 0:
				return {}
			# корпус поднимается на рабочем ходе
			return {"move_up": p["bob"] * info.get("height", 0.0) * -flap_profile(u - 0.1, p["down"]) * 0.5}
		"tail":
			return {"pitch": (p["tailPitch"] / n) * flap_profile(u - 0.2, p["down"])}
		"leg_l", "leg_r":
			return {"pitch": p["tuck"]} if i == 0 else ({"pitch": -p["tuck"] * 0.8} if i == 1 else {})
	var s := 1.0 if p["role"] == "wing_l" else -1.0
	var f := flap_profile(u - i * p["lag"], p["down"])
	# складывание — на подъёме (вторая часть цикла), плавный горб
	var uu := _fmod1(u - i * p["lag"])
	var up: float = 0.0 if uu < p["down"] else sin((PI * (uu - p["down"])) / (1 - p["down"]))
	if i == 0:
		return {"vertical": p["mean"] + p["amp"] * f}
	if i == 1:
		return {"vertical": 0.3 * p["amp"] * (f - flap_profile(u, p["down"])), "yaw": s * p["fold"] * up}
	return {"yaw": -s * 0.5 * p["fold"] * up}


# ── парение (призрак Witcher) ───────────────────────────────────────────────────────────────────────────────────

static func _hover(p: Dictionary, i: int, t: float, info: Dictionary) -> Dictionary:
	if i > 0:
		return {}
	var s: float = t / p["period"]
	var c := func(peak: float, k: float = 1.0) -> float: return cos(2.0 * PI * k * (s - peak))
	# пики гармоник — из M_walk: подъём 0.75, тангаж 0.93, крен 0.18, рыскание груди 0.78
	if p["role"] == "pelvis":
		return {"move_up": p["bob"] * info.get("height", 0.0) * c.call(0.75), "pitch": p["lean"] + p["pitch"] * c.call(0.93), "bank": p["roll"] * c.call(0.18)}
	# кивки груди и головы — в мире; слой отдаёт разницу с родителем
	if p["role"] == "chest":
		var r := {"yaw": p["chestYaw"] * c.call(0.78)}
		if p["chestPitch"] != 0:
			r["pitch"] = p["chestPitch"] * c.call(0.82) - p["pitch"] * c.call(0.93)
		return r
	var r := {}
	if p["look"] != 0:
		r["yaw"] = p["look"] * c.call(0.3) + 1.2 * p["look"] * c.call(0.1, 2.0)
	if p["headPitch"] != 0:
		r["pitch"] = p["headPitch"] * c.call(0.67) - (p["chestPitch"] * c.call(0.82) if p["chestPitch"] != 0 else p["pitch"] * c.call(0.93))
	return r


# ── удар щупальцем или стеблем ──────────────────────────────────────────────────────────────────────────────────
## Профиль удара в момент t (без задержки по костям): замах −windup, удар +1, удержание, плавный возврат.
static func strike_curve(p: Dictionary, t: float) -> float:
	var t1: float = p["windupT"]
	var t2: float = t1 + p["strikeT"]
	var t3: float = t2 + p["hold"]
	var t4: float = t3 + p["returnT"]
	if t <= 0:
		return 0.0
	if t < t1:
		return -p["windup"] * _smooth(t / t1)
	if t < t2:
		var u: float = (t - t1) / p["strikeT"]
		return -p["windup"] + (1 + p["windup"]) * u * u * (3 - 2 * u)
	if t < t3:
		return 1.0
	if t < t4:
		return 1 - _smooth((t - t3) / p["returnT"])
	return 0.0


static func _tentacle_strike(p: Dictionary, i: int, n: int, t: float) -> Dictionary:
	var a: float = p["amp"] * (0.4 + 0.6 * pow(float(i + 1) / n, p["growth"]))
	return {p["plane"]: a * strike_curve(p, t - i * p["delay"])}


# ── появление и уход ────────────────────────────────────────────────────────────────────────────────────────────
## 0 → 1 (появление) или 1 → 0 (уход) с предварительным ходом и перелётом; доля пути от времени u ∈ [0, 1].
static func emerge_curve(p: Dictionary, u: float) -> float:
	u = minf(1.0, maxf(0.0, u))
	var pre: float = p["preT"] if p["anticipation"] > 0 else 0.0
	if p["mode"] == "submerge":
		# замах вверх, потом уход с ускорением
		if u < pre:
			return 1 + p["anticipation"] * sin((PI / 2.0) * (u / pre))
		var v := (u - pre) / (1 - pre)
		return (1 + p["anticipation"]) * (1 - pow(v, p["easeIn"]))
	if u < pre:
		return -p["anticipation"] * sin(PI * (u / pre))
	var v := (u - pre) / (1 - pre)
	# быстрый подъём до 1 + overshoot к доле rise, затем оседание
	if v < p["rise"]:
		var w: float = v / p["rise"]
		return (1 + p["overshoot"]) * (1 - pow(1 - w, 3))
	var w: float = (v - p["rise"]) / (1 - p["rise"])
	return 1 + p["overshoot"] * (1 - _smooth(w))


static func _emerge(p: Dictionary, i: int, t: float, info: Dictionary) -> Dictionary:
	if i > 0:
		return {}
	var h: float = info.get("size", info.get("height", 1.0)) * p["depth"]
	return {"move_up": -h * (1 - emerge_curve(p, t / p["duration"]))}


# ── таран корпусом ──────────────────────────────────────────────────────────────────────────────────────────────
## Ключи по времени: e — откат за нейтраль, g — затухающий отскок, f — стойка.
static func _ram_keys(p: Dictionary) -> Dictionary:
	var a: float = p["windupT"]
	var b: float = a + p["hold"]
	var c: float = b + p["strikeT"]
	var d: float = c + p["contact"]
	var e: float = d + p["recover"]
	var g: float = e + p["settle"] * 0.45
	var f: float = e + p["settle"]
	return {"t": [0.0, a, b, c, d, e, g, f], "ev": {"a": a, "b": b, "c": c, "d": d, "e": e, "f": f}}


static func _ram_curve(T: Array, v: Array, t: float) -> float:
	if t <= 0:
		return v[0]
	for k in range(1, T.size()):
		if t < T[k]:
			var u: float = (t - T[k - 1]) / (T[k] - T[k - 1])
			return v[k - 1] + (v[k] - v[k - 1]) * u * u * (3 - 2 * u)
	return v[v.size() - 1]


static func _body_ram(p: Dictionary, i: int, t: float, info: Dictionary) -> Dictionary:
	if i > 0:
		return {}
	var T: Array = _ram_keys(p)["t"]
	var H: float = info.get("height", 1.0)
	var PITCH := [0.0, -p["back"], -p["back"] * 1.05, p["forward"], p["forward"] * 0.95, -p["overshoot"], p["overshoot"] * 0.3, 0.0]
	# голова в мире = (1 − hold) · наклон корпуса с запаздыванием; слой отдаёт разницу с корпусом
	if p["role"] == "head":
		return {"pitch": (1 - p["headHold"]) * _ram_curve(T, PITCH, t - p["headLag"]) - _ram_curve(T, PITCH, t)}
	return {
		"pitch": _ram_curve(T, PITCH, t),
		"bank": _ram_curve(T, [0.0, -p["bank"], -p["bank"] * 1.1, 0.0, 0.0, p["bank"] * 0.1, 0.0, 0.0], t),
		"move_forward": _ram_curve(T, [0.0, -p["push"] * 0.45, -p["push"] * 0.5, p["push"], p["push"], -p["push"] * 0.15, p["push"] * 0.04, 0.0], t) * H,
		"move_up": _ram_curve(T, [0.0, p["lift"] * 0.6, p["lift"] * 0.6, p["lift"], p["lift"], 0.0, 0.0, 0.0], t) * H,
	}


static func _ram_events(p: Dictionary) -> Array:
	var ev: Dictionary = _ram_keys(p)["ev"]
	return [{"t": ev["a"] * 0.5, "name": "effort"}, {"t": ev["b"] + (ev["c"] - ev["b"]) * 0.3, "name": "whoosh"}, {"t": ev["c"], "name": "hit"}, {"t": ev["d"], "name": "trail_off"}, {"t": ev["f"], "name": "window_open"}, {"t": ev["f"] + p["tail"], "name": "window_close"}]


# ── tremble ─────────────────────────────────────────────────────────────────────────────────────────────────────

static func _tremble(p: Dictionary, i: int, n: int, t: float) -> Dictionary:
	var role: String = p["role"]
	var amp: float = p["headAmp"] if role == "head" else (p["tailAmp"] if role == "tail" else p["chestAmp"])
	var lag: float = 0.0 if role == "chest" else p["lag"] * RAD
	var hz: float = maxf(1.0, round(p["hz"] * p["period"])) / p["period"]
	var env: float = 1.0 + p["irregular"] * sin(2.0 * PI * (t / p["period"]))
	var v: float = (amp / maxi(1, n)) * env * sin(2.0 * PI * hz * t - lag)
	var axis: String = "yaw" if role == "tail" and p["plane"] == "pitch" else p["plane"]
	return {axis: v}


# ── hit-react ───────────────────────────────────────────────────────────────────────────────────────────────────

const REACT_DIR := {"back": [-1, 0], "forward": [1, 0], "left": [0, -1], "right": [0, 1]}


static func _react_curve(p: Dictionary, t: float) -> float:
	var w0: float = p["windupT"] if p["windup"] > 0 else 0.0
	if t <= 0:
		return 0.0
	if t < w0:
		return -p["windup"] * _smooth(t / w0)
	if t < p["peakT"]:
		var a := minf(0.95, maxf(0.02, (p["peakVelT"] - w0) / (p["peakT"] - w0)))
		return -p["windup"] + (1 + p["windup"]) * swing_ease((t - w0) / (p["peakT"] - w0), a)
	if t < p["settleT"]:
		return 1 + (p["keep"] - 1) * _smooth((t - p["peakT"]) / (p["settleT"] - p["peakT"]))
	return p["keep"]


static func _hit_react(p: Dictionary, i: int, t: float, info: Dictionary) -> Dictionary:
	if i > 0:
		return {}
	var d: Array = REACT_DIR.get(p["dir"], REACT_DIR["back"])
	var f: float = d[0]
	var s: float = d[1]
	if p["role"] == "head":
		var ch: float = p["headPitch"] * _react_curve(p, t - p["headLag"])
		return {"pitch": f * ch} if f != 0 else {"bank": s * ch}
	var c := _react_curve(p, t)
	var H: float = info.get("height", 1.0)
	var out := {}
	if f != 0:
		out["pitch"] = f * p["pitch"] * c
		out["move_forward"] = f * p["push"] * H * c
	else:
		out["bank"] = s * p["pitch"] * c
		out["move_side"] = s * p["push"] * H * c
	if p["drop"] != 0:
		out["move_up"] = -p["drop"] * H * c
	return out


static func _react_events(p: Dictionary) -> Array:
	var impact := {"t": p["windupT"] if p["windup"] > 0 else 0.0, "name": "impact"}
	if p["keep"] >= 1:
		return [impact, {"t": p["peakT"], "name": "thud"}]
	return [impact, {"t": p["peakT"], "name": "peak"}, {"t": p["settleT"], "name": "recovered"}]


# ── idle-glance ─────────────────────────────────────────────────────────────────────────────────────────────────

static func _glance_ease(u: float) -> float:
	u = minf(1.0, maxf(0.0, u))
	return u + u * u - u * u * u


static func _glance_target(p: Dictionary, k: int, j: int, side: float) -> Array:
	var seed := int(p["seed"])
	var yaw: float = p["yawMin"] + (p["yawMax"] - p["yawMin"]) * AFCore.rand01(seed, k, j, 7)
	var down: float = p["downMin"] + (p["downMax"] - p["downMin"]) * AFCore.rand01(seed, k, j + 1, 7)
	return [maxf(-p["limitYaw"], minf(p["limitYaw"], side * yaw)), minf(p["limitDown"], down)]


## Расписание взглядов на петле — как glancePlan в recipes.ts.
static func _glance_plan(p: Dictionary) -> Dictionary:
	var seed := int(p["seed"])
	var T: float = p["transition"]
	var starts: Array = []
	var segs: Array = []
	var cur := 0.0
	for k in 64:
		var r := func(j: int) -> float: return AFCore.rand01(seed, k, j, 7)
		var s0: float = cur + (p["intervalMin"] + (p["intervalMax"] - p["intervalMin"]) * r.call(0)) * (0.5 if k == 0 else 1.0)
		var side := -1.0 if r.call(1) < 0.5 else 1.0
		var g1 := _glance_target(p, k, 2, side)
		var h1: float = p["holdMin"] + (p["holdMax"] - p["holdMin"]) * r.call(4)
		var two: bool = r.call(5) < p["double"]
		var g2: Array = _glance_target(p, k, 6, -side if r.call(8) < p["opposite"] else side) if two else g1
		var h2: float = p["holdMin"] + (p["holdMax"] - p["holdMin"]) * r.call(9) if two else 0.0
		var end: float = s0 + T + h1 + ((T + h2) if two else 0.0) + T
		if end > p["period"] - 1e-6:
			break
		starts.append(s0)
		var t := s0
		var parts: Array = [[T, [0.0, 0.0], g1], [h1, g1, g1]]
		if two:
			parts.append([T, g1, g2])
			parts.append([h2, g2, g2])
		parts.append([T, g2, [0.0, 0.0]])
		for q in parts:
			segs.append({"a": t, "b": t + q[0], "from": q[1], "to": q[2]})
			t += q[0]
		cur = end
	return {"starts": starts, "segs": segs}


static func _idle_glance(p: Dictionary, n: int, t: float) -> Dictionary:
	var per: float = p["period"]
	var tt := fmod(fmod(t, per) + per, per)
	for g in _glance_plan(p)["segs"]:
		if tt < g["a"] or tt >= g["b"]:
			continue
		var u := _glance_ease((tt - g["a"]) / (g["b"] - g["a"])) if g["b"] > g["a"] else 1.0
		var k := 1.0 / maxi(1, n)
		return {"yaw": (g["from"][0] + (g["to"][0] - g["from"][0]) * u) * k, "pitch": (g["from"][1] + (g["to"][1] - g["from"][1]) * u) * k}
	return {}


# ── startle ─────────────────────────────────────────────────────────────────────────────────────────────────────
# Позы испуга Ghost Master — та же таблица, что STARTLE в recipes.ts.
const STARTLE := {"flinch": {"t": [0, 0.1, 0.27, 0.53, 1.13], "ev": [[0.13, "surprise"]], "pelvis": {"move_up": [0, -0.05, -0.1, -0.1, 0], "move_forward": [0, -0.02, -0.05, -0.05, 0], "pitch": [0, 2, 6, 6, 0]}, "chest": {"pitch": [0, 4, 10, 10, 0]}, "head": {"pitch": [0, 4, 8, 8, 0]}, "arm0": {"pitch": [0, -10, -35, -35, 0]}, "arm1": {"pitch": [0, -20, -60, -60, 0]}, "leg0": {"pitch": [0, -5, -12, -12, 0]}, "leg1": {"pitch": [0, 8, 20, 20, 0]}}, "jump": {"t": [0, 0.39, 0.55, 0.63, 0.79, 1.0, 1.25, 2.0], "ev": [[0.39, "surprise"], [1.0, "land"]], "pelvis": {"move_up": [0, -0.14, 0.1, 0.16, 0.14, -0.1, -0.05, 0], "pitch": [0, 10, -4, -6, -5, 8, 3, 0]}, "chest": {"pitch": [0, 12, -8, -12, -10, 10, 4, 0]}, "head": {"pitch": [0, 14, -12, -20, -16, 8, 3, 0]}, "arm0": {"pitch": [0, 25, -120, -165, -160, -50, -20, 0]}, "arm1": {"pitch": [0, -30, -10, 0, 0, -40, -15, 0]}, "leg0": {"pitch": [0, -30, 5, 8, 6, -25, -10, 0]}, "leg1": {"pitch": [0, 55, 0, 0, 0, 45, 20, 0]}}, "doubletake": {"t": [0, 0.3, 0.55, 0.85, 1.28, 1.43, 1.75, 2.17], "ev": [[0.55, "surprise"], [1.75, "land"]], "pelvis": {"move_up": [0, 0, 0, -0.14, 0.08, 0.12, -0.08, -0.08], "pitch": [0, 0, 0, 10, -4, -6, 8, 8]}, "chest": {"pitch": [0, 0, 0, 12, -8, -10, 10, 10], "yaw": [0, 10, 0, 0, 0, 0, 0, 0]}, "head": {"pitch": [0, 0, 0, 8, -10, -14, 4, 4], "yaw": [0, 25, 0, 0, 0, 0, 0, 0]}, "arm0": {"pitch": [0, 0, 0, 15, -110, -140, -60, -60]}, "arm1": {"pitch": [0, 0, 0, -20, -10, 0, -30, -30]}, "leg0": {"pitch": [0, 0, 0, -28, 4, 6, -18, -18]}, "leg1": {"pitch": [0, 0, 0, 50, 0, 0, 35, 35]}}, "cower": {"t": [0, 0.25, 0.7, 0.9], "ev": [], "pelvis": {"move_up": [0, -0.15, -0.5, -0.475], "pitch": [0, 5, 12, 11]}, "chest": {"pitch": [0, 5, 15, 14]}, "head": {"pitch": [0, 5, 18, 17]}, "arm0": {"pitch": [0, -60, -165, -160]}, "arm1": {"pitch": [0, -40, -100, -95]}, "leg0": {"pitch": [0, -25, -70, -67]}, "leg1": {"pitch": [0, 45, 120, 115]}}, "faint": {"t": [0, 0.33, 0.65, 0.93, 1.08, 1.25, 1.67], "ev": [[1.08, "thud"]], "pelvis": {"pitch": [0, -5, -35, -82, -76, -80, -80], "move_up": [0, -0.18, -0.53, -1, -0.965, -1, -1], "move_forward": [0, -0.05, -0.35, -0.78, -0.78, -0.78, -0.78]}, "chest": {"pitch": [0, -4, -8, -13, -4, -8, -8]}, "head": {"pitch": [0, -12, -18, -2, 8, 4, 4]}, "arm0": {"pitch": [0, -20, -50, -30, -10, -20, -20]}, "arm1": {"pitch": [0, -20, -40, -20, -10, -15, -15]}, "leg0": {"pitch": [0, -20, -30, -10, -25, -5, -5]}, "leg1": {"pitch": [0, 40, 45, 15, 25, 10, 10]}}}


static func _startle(p: Dictionary, i: int, t: float, info: Dictionary) -> Dictionary:
	var K: Dictionary = STARTLE[p["kind"]]
	var role: String = p["role"]
	var limb := role.begins_with("arm_") or role.begins_with("leg_")
	if (i > 1) if limb else (i > 0):
		return {}
	var key: String = (role.substr(0, 3) + str(i)) if limb else role
	if not K.has(key):
		return {}
	var H: float = info.get("height", 1.0)
	var out := {}
	for c in K[key]:
		# у обморока подъём таза — доля полного опускания, глубина — lie
		var drop: float = (1.0 - p["lie"]) if p["kind"] == "faint" and role == "pelvis" and c == "move_up" else 1.0
		out[c] = _ram_curve(K["t"], K[key][c], t * p["speed"]) * p["amount"] * drop * (H if c.begins_with("move_") else 1.0)
	return out


# ── scare-pose ──────────────────────────────────────────────────────────────────────────────────────────────────

static func _scare_keys(p: Dictionary) -> Array:
	var pre: float = p["preT"] if p["anticipation"] > 0 else 0.0
	var a: float = pre + p["rise"]
	var b: float = a + p["settle"]
	return [0.0, pre, a, b, maxf(p["duration"], b + 0.01)]


static func _scare_pose(p: Dictionary, i: int, t: float, info: Dictionary) -> Dictionary:
	var T := _scare_keys(p)
	var ant: float = p["anticipation"]
	var main := _ram_curve(T, [0.0, -ant, 1.0, p["keep"], p["keep"]], t)
	var H: float = info.get("height", 1.0)
	match p["role"]:
		"pelvis": return {} if i > 0 else {"pitch": p["lean"] * main, "move_up": p["lift"] * H * main}
		"chest": return {} if i > 0 else {"pitch": p["chest"] * _ram_curve(T, [0.0, -ant * p["overshoot"], p["overshoot"], 1.0, 1.0], t)}
		"head": return {} if i > 0 else {"pitch": p["head"] * main}
	# руки замаха не делают — сразу в позу
	var arm := _ram_curve(T, [0.0, 0.0, 1.0, p["keep"], p["keep"]], t)
	if i == 0:
		return {"pitch": p["arms"] * arm}
	if i == 1:
		return {"pitch": p["elbow"] * arm}
	return {}


# ── zero-g-float ────────────────────────────────────────────────────────────────────────────────────────────────
const ZERO_G := {"thigh": [-1.1, -3.9, -6.6, -9.1, -10.9, -11.8, -11.4, -10.0, -7.7, -4.6, -0.9, 3.1, 7.2, 11.0, 13.8, 14.7, 12.8, 9.0, 5.0, 1.4], "calf": [8.8, 13.3, 17.3, 20.3, 22.3, 22.9, 21.6, 18.1, 12.9, 6.3, -1.3, -9.6, -17.9, -25.4, -30.9, -32.5, -27.0, -16.8, -5.9, 3.4], "foot": [4.0, -0.5, -6.8, -13.3, -18.2, -20.1, -19.0, -16.4, -12.5, -7.7, -2.3, 3.4, 9.0, 14.0, 17.7, 19.2, 17.7, 14.4, 10.6, 6.8], "paddle": [-1.6, 1.7, 4.9, 7.8, 10.0, 11.4, 11.7, 10.7, 8.8, 6.1, 2.7, -1.3, -5.5, -9.6, -12.7, -13.5, -12.0, -9.5, -6.7, -3.8], "flick": [-13.9, -11.5, -6.0, -0.4, 3.8, 5.5, 5.7, 5.9, 6.0, 6.0, 5.8, 5.4, 4.8, 4.0, 3.0, 1.8, -0.5, -4.2, -8.5, -12.3]}


static func _zero_g(p: Dictionary, i: int, t: float, info: Dictionary) -> Dictionary:
	var s: float = t / p["period"]
	var cs := func(peak: float) -> float: return cos(2.0 * PI * (s - peak))
	var role: String = p["role"]
	if role == "pelvis":
		return {} if i > 0 else {"yaw": p["body"] * 0.86 * cs.call(0.5), "move_up": p["lift"] * info.get("height", 0.0)}
	if role == "spine":
		if i == 0:
			return {"yaw": p["body"] * 1.76 * cs.call(0.0)}
		return {"yaw": p["body"] * 1.45 * cs.call(0.5)} if i == 1 else {}
	if role == "leg_l" or role == "leg_r":
		var strong: bool = (role == "leg_l") == (p["strong"] == "left")
		var k: float = p["legs"] * (1.0 if strong else p["legRatio"])
		var u: float = s if strong else s - p["legLR"] / 360.0
		# голень со знаком «−»: колено сгибается, когда бедро уходит назад
		if i == 0:
			return {"pitch": p["hip"] + k * periodic(ZERO_G["thigh"], u)}
		if i == 1:
			return {"pitch": p["knee"] - k * periodic(ZERO_G["calf"], u)}
		if i == 2:
			return {"pitch": k * periodic(ZERO_G["foot"], u)}
		return {}
	var flick: bool = (role == "arm_l") == (p["strong"] == "left")
	var fore: float = periodic(ZERO_G["flick"] if flick else ZERO_G["paddle"], s) * p["arms"]
	if flick:
		if i == 0:
			return {"pitch": fore * (3.2 / 8.6)}
		if i == 1:
			return {"pitch": p["elbow"] + fore}
		return {"pitch": fore * (6.5 / 8.6)} if i == 2 else {}
	if i == 0:
		return {"pitch": p["arms"] * 5.6 * cs.call(0.75)}
	if i == 1:
		return {"pitch": p["elbow"] + fore}
	return {"pitch": p["arms"] * 8.8 * cs.call(0.75)} if i == 2 else {}


# ── power-down ──────────────────────────────────────────────────────────────────────────────────────────────────

static func _power_level(p: Dictionary, t: float) -> float:
	match p["mode"]:
		"hang": return 1.0
		"in": return _ram_curve([0.0, p["inT"]], [0.0, 1.0], t)
		"out": return _ram_curve([0.0, p["outT"]], [1.0, 0.0], t)
	if t < p["inT"] + p["hang"]:
		return _ram_curve([0.0, p["inT"]], [0.0, 1.0], t)
	var a: float = p["inT"] + p["hang"]
	return _ram_curve([a, a + p["outT"]], [1.0, 0.0], t)


static func _power_down(p: Dictionary, i: int, n: int, t: float, info: Dictionary) -> Dictionary:
	var v := _power_level(p, t)
	if p["role"] == "limb":
		return {} if i >= n else {"pitch": p["droop"] * v * (1.0 if i == 0 else 0.5)}
	if i > 0:
		return {}
	if p["role"] == "head":
		return {"pitch": p["headDroop"] * v}
	var size: float = info.get("size", info.get("height", 1.0))
	return {"pitch": p["tilt"] * v, "move_up": size * (-p["drop"] * v + p["bob"] * v * sin((2.0 * PI * t) / p["bobPeriod"]))}


static func _power_events(p: Dictionary) -> Array:
	var ev := []
	if p["mode"] == "in" or p["mode"] == "full":
		ev.append({"t": 0.0, "name": "power_off"})
	if p["mode"] == "out":
		ev.append({"t": 0.0, "name": "power_on"})
	if p["mode"] == "full":
		ev.append({"t": to_fixed(p["inT"] + p["hang"], 4), "name": "power_on"})
	return ev


# ── head-look-peck ──────────────────────────────────────────────────────────────────────────────────────────────

static var _wing_twitch_peak := -1.0


## Пик |sin w + 0.82·sin 2w| — как WING_TWITCH_PEAK в recipes.ts.
static func _twitch_peak() -> float:
	if _wing_twitch_peak < 0:
		var m := 0.0
		for k in 20000:
			var w := (2.0 * PI * k) / 20000.0
			m = maxf(m, absf(sin(w) + 0.82 * sin(2.0 * w)))
		_wing_twitch_peak = m
	return _wing_twitch_peak


static func _head_look_peck(p: Dictionary, i: int, n: int, t: float) -> Dictionary:
	var w: float = (2.0 * PI * t) / p["period"]
	match p["role"]:
		"neck":
			if i == 0:
				return {"yaw": p["neck"] * sin(w)}
			return {"yaw": -p["neck2"] * sin(w)} if i == 1 else {}
		"head": return {} if i > 0 else {"yaw": p["head"] * sin(w + p["headPhase"] * RAD)}
		"tail": return {"yaw": (p["tail"] / maxi(1, n)) * sin(w + p["tailPhase"] * RAD)}
	return {} if i > 0 else {"pitch": (p["wing"] * (sin(w) + 0.82 * sin(2.0 * w))) / _twitch_peak()}
