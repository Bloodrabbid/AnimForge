# Проверка пропов в glb: узел prop_<id> под костью — в Godot это BoneAttachment3D с мешем.
# godot --headless --path godot/verify --script props_check.gd -- <file.glb>
extends SceneTree

func _init() -> void:
	var doc := GLTFDocument.new()
	var state := GLTFState.new()
	if doc.append_from_file(OS.get_cmdline_user_args()[0], state) != OK:
		print("PROPS_FAIL glb не прочитан")
		quit(1)
		return
	var scene := doc.generate_scene(state)
	for n in scene.find_children("prop_*", "", true, false):
		var p := n.get_parent()
		var meshes := n.find_children("*", "MeshInstance3D", true, false)
		print("PROP %s под %s (%s), мешей %d" % [n.name, p.name, p.get_class(), meshes.size()])
	quit(0)
