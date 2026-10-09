# Сверка AFRecipes с ядром: входы и выходы evaluate, events и length из TS (recipe-vectors.ts) против af_recipes.gd.
# godot --headless --path godot/sandbox --script res://tests/recipes_verify.gd -- <vectors.json>
extends SceneTree

const R = preload("res://addons/animforge/live/af_recipes.gd")
const TOL := 1e-6


# Абсолютная разница, для больших значений — относительная. Строки — NaN/∞ из JSON: совпасть должны буквально.
func _err(got, want) -> float:
	if want is String:
		return 0.0 if str(got) == {"NaN": "nan", "Infinity": "inf", "-Infinity": "-inf"}.get(want, want) else INF
	if not (got is float or got is int):
		return INF
	var g := float(got)
	if is_nan(g) or is_inf(g):
		return INF
	return absf(g - float(want)) / maxf(1.0, absf(float(want)))


var _worst := 0.0
var _where := ""
var _count := 0


func _note(e: float, what: String) -> void:
	_count += 1
	if not (e <= _worst) and not is_nan(_worst):
		_worst = e
		_where = what


func _initialize() -> void:
	var path: String = OS.get_cmdline_user_args()[0]
	var data: Dictionary = JSON.parse_string(FileAccess.get_file_as_string(path))
	var size: float = data["size"]
	var bad := []
	var total := 0
	for name in data["recipes"]:
		var rec: Dictionary = data["recipes"][name]
		_worst = 0.0
		_where = ""
		_count = 0
		_note(0.0 if R.is_secondary(name) == bool(rec["secondary"]) else INF, "is_secondary %s" % R.is_secondary(name))
		for s in rec["sets"]:
			var p: Dictionary = s["params"]
			_note(_err(R.length(name, p), s["length"]), "length %s: godot %s, ядро %s" % [p, R.length(name, p), s["length"]])
			var ev := R.events(name, p)
			var want_ev: Array = s["events"]
			if ev.size() != want_ev.size():
				_note(INF, "events %s: godot %s, ядро %s" % [p, ev, want_ev])
			else:
				for k in ev.size():
					var e := INF if ev[k]["name"] != want_ev[k]["name"] else _err(ev[k]["t"], want_ev[k]["t"])
					_note(e, "events[%d] %s: godot %s, ядро %s" % [k, p, ev[k], want_ev[k]])
			var ts: Array = s["ts"]
			for row in s["rows"]:
				var n := int(row["n"])
				var i := int(row["i"])
				var info := {"height": float(row["height"]), "size": size}
				for k in ts.size():
					var got := R.evaluate(name, p, i, n, ts[k], info)
					var want: Dictionary = row["out"][k]
					var e := 0.0
					if got.size() != want.size():
						e = INF
					for ch in want:
						e = maxf(e, _err(got.get(ch), want[ch]) if got.has(ch) else INF)
					if not (e <= _worst):
						_note(e, "%s i=%d n=%d t=%s h=%s: godot %s, ядро %s" % [p, i, n, ts[k], row["height"], got, want])
					else:
						_count += 1
		total += _count
		print("RECIPE %s %s %d%s" % [name, String.num_scientific(_worst), _count, "" if _worst <= TOL else "  " + _where])
		if not (_worst <= TOL):
			bad.append(name)
	print("RECIPES всего проверок %d" % total)
	print("RECIPES_OK" if bad.is_empty() else "RECIPES_FAIL " + ", ".join(bad))
	quit()
