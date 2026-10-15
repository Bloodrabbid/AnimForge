# Готовые клипы из FBX, BVH, DAE, glTF → glb со скелетом и всеми дублями (каждое действие — своя анимация glTF).
# blender -b --factory-startup --python import_anim.py -- <in> <out.glb>
import bpy, os, sys
a = sys.argv[sys.argv.index("--") + 1:]
src, out = a[0], a[1]
bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.context.scene.render.fps = 30
ext = os.path.splitext(src)[1].lower()
if ext == ".fbx":
    # концевые кости не выбрасываем: у своих скелетов (кисть-варежка, ухо) это настоящие кости со своими поворотами
    bpy.ops.import_scene.fbx(filepath=src, automatic_bone_orientation=True, ignore_leaf_bones=False)
elif ext == ".bvh":
    bpy.ops.import_anim.bvh(filepath=src, global_scale=1.0, update_scene_fps=False, update_scene_duration=True)
elif ext in (".glb", ".gltf"):
    bpy.ops.import_scene.gltf(filepath=src)
elif ext == ".dae":
    bpy.ops.wm.collada_import(filepath=src)
else:
    print("ANIM_ERR формат не поддержан", ext); sys.exit(1)
arms = [o for o in bpy.data.objects if o.type == "ARMATURE"]
if not arms:
    print("ANIM_ERR в файле нет скелета"); sys.exit(1)
acts = list(bpy.data.actions)
# у BVH кадры — в единицах файла (часто сантиметры): рост больше 10 «метров» — переводим в метры
arm = arms[0]
bpy.context.view_layer.update()
h = max((b.head_local.z for b in arm.data.bones), default=0) * max(arm.scale)
if ext == ".bvh" and h > 10:
    arm.scale = [s / 100 for s in arm.scale]
    bpy.context.view_layer.update()
bpy.ops.export_scene.gltf(filepath=out, export_format="GLB", export_skins=True, export_animations=True,
                          export_animation_mode="ACTIONS", export_force_sampling=True, export_frame_step=1,
                          export_optimize_animation_size=False, export_apply=False)
print("ANIM_OK", out, "дублей", len(acts), "костей", len(arm.data.bones))
