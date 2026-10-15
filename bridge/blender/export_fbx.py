# Экспорт в FBX: glb, запечённый AnimForge, → FBX со скином и всеми клипами (каждый клип — отдельный тейк).
# blender -b --factory-startup --python export_fbx.py -- <in.glb> <out.fbx> <units: blender|unreal|unity|maya>
# Единицы и оси — как ждёт движок:
#   blender, maya — метры как есть, Y вверх (так же читает Godot);
#   unity — «FBX All»: масштаб вшит в файл, в Unity объект с масштабом 1;
#   unreal — как unity (масштаб в файле, UE сам переводит в сантиметры), Z вверх, а скелет зовётся «Armature»:
#            объект с таким именем UE не превращает в лишнюю кость над root.
import bpy, sys
a = sys.argv[sys.argv.index("--") + 1:]
src, out, units = a[0], a[1], (a[2] if len(a) > 2 else "blender")
bpy.ops.wm.read_factory_settings(use_empty=True)
# кадры клипов считаются при импорте по частоте сцены — ставим ту, с которой AnimForge запекает
bpy.context.scene.render.fps = 30
# кости — как в glb: без «угадывания» направлений, иначе повороты в тейках меняют смысл относительно rest
bpy.ops.import_scene.gltf(filepath=src, bone_heuristic="TEMPERANCE", import_shading="NORMALS")
arms = [o for o in bpy.data.objects if o.type == "ARMATURE"]
if not arms:
    print("FBX_ERR в glb нет скелета"); sys.exit(1)
arm = arms[0]
acts = [act for act in bpy.data.actions]
# каждый клип — своя включённая дорожка NLA, тогда FBX пишет их тейками с именами клипов (выключенные не пишет)
ad = arm.animation_data or arm.animation_data_create()
ad.action = None
for t in list(ad.nla_tracks): ad.nla_tracks.remove(t)
for act in acts:
    tr = ad.nla_tracks.new(); tr.name = act.name
    tr.strips.new(act.name, int(act.frame_range[0]), act)
    tr.mute = False
scene = bpy.context.scene
kw = dict(filepath=out, use_selection=False, object_types={"ARMATURE", "MESH", "EMPTY"}, add_leaf_bones=False, bake_anim=True,
          bake_anim_use_all_bones=True, bake_anim_use_nla_strips=True, bake_anim_use_all_actions=False, bake_anim_force_startend_keying=True,
          bake_anim_simplify_factor=0.0, mesh_smooth_type="FACE", path_mode="COPY", embed_textures=True)
if units == "unity":
    kw.update(apply_scale_options="FBX_SCALE_ALL", axis_forward="-Z", axis_up="Y", apply_unit_scale=True)
elif units == "unreal":
    arm.name = "Armature"
    kw.update(apply_scale_options="FBX_SCALE_ALL", axis_forward="-Y", axis_up="Z", apply_unit_scale=True)
else:
    kw.update(apply_scale_options="FBX_SCALE_NONE", axis_forward="-Z", axis_up="Y")
bpy.ops.export_scene.fbx(**kw)
print("FBX_OK", out, "клипов", len(acts), "костей", len(arm.data.bones), "единицы", units)
