# Планировщик вставок в idle (AnimForge.idle_variety). Модель — по данным Witcher (LUC/mimicrydefs.lua):
# у каждой вставки шанс (% за проверку), кулдаун и время наплыва. Проверка — раз в check секунд, пока играет base;
# вставки перебираются по убыванию шанса, срабатывает первая выпавшая и не на кулдауне. Общий кулдаун после любой
# вставки — global_cooldown. Что именно значит «шанс» в Witcher (за проверку или вес) — не проверено, см. provenance.
extends Node

var player: AnimationPlayer
var cfg: Dictionary
var rng := RandomNumberGenerator.new()
var now := 0.0
var next_check := 0.0
var busy_until := -1.0
var global_ready := 0.0
var ready_at := {}  # клип → время, с которого снова можно
var log: Array = []  # [{t, clip}] — для проверок и отладки
var manual := false  # true — время двигает step(), а не _process


func setup(p: AnimationPlayer, c: Dictionary, seed: int) -> void:
	player = p
	cfg = c
	if seed >= 0:
		rng.seed = seed
	else:
		rng.randomize()
	next_check = float(cfg.get("check", 1.0))


func _process(dt: float) -> void:
	if not manual:
		step(dt)


func step(dt: float) -> void:
	now += dt
	var base: String = cfg["base"]
	if busy_until >= 0 and now >= busy_until:
		busy_until = -1.0
		if player.has_animation(base):
			player.play(base, float(cfg.get("blend", 1.0)))
	if busy_until >= 0 or now < next_check:
		return
	next_check = now + float(cfg.get("check", 1.0))
	if now < global_ready:
		return
	var inserts: Array = cfg["inserts"].duplicate()
	inserts.sort_custom(func(a, b): return a["chance"] > b["chance"])
	for ins in inserts:
		var clip: String = ins["clip"]
		if now < float(ready_at.get(clip, 0.0)):
			continue
		if rng.randf() * 100.0 >= float(ins["chance"]):
			continue
		var blend := float(ins.get("blend", cfg.get("blend", 1.0)))
		if player.has_animation(clip):
			player.play(clip, blend)
			busy_until = now + player.get_animation(clip).length
		else:
			busy_until = now + float(ins.get("length", 2.0))
		ready_at[clip] = now + float(ins.get("cooldown", 0.0))
		global_ready = busy_until + float(cfg.get("global_cooldown", 0.0))
		log.append({"t": now, "clip": clip})
		return
