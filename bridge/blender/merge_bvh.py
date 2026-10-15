# Несколько BVH одного набора (CMU в переводе cgspeed: у всех одни имена костей) → один glb: скелет первого файла и
# все дубли. Первый кадр каждого файла — добавленная T-поза, её срезаем. Кадры BVH (120 к/с) приводятся к 30 к/с сцены.
# blender -b --factory-startup --python merge_bvh.py -- <out.glb> <имя>=<файл.bvh> ...
import bpy, sys
a = sys.argv[sys.argv.index("--") + 1:]
out, items = a[0], [x.split("=", 1) for x in a[1:]]
bpy.ops.wm.read_factory_settings(use_empty=True)
scene = bpy.context.scene
scene.render.fps = 30
main = None


def fcurves(act):
    # Blender 5: кривые живут в слоях действия (slotted actions)
    if hasattr(act, "fcurves"):
        return list(act.fcurves)
    return [fc for l in act.layers for st in l.strips for cb in st.channelbags for fc in cb.fcurves]


for name, path in items:
    before = set(bpy.data.objects)
    bpy.ops.import_anim.bvh(filepath=path, global_scale=1.0, use_fps_scale=True, update_scene_fps=False, update_scene_duration=False, rotate_mode="NATIVE")
    arm = [o for o in bpy.data.objects if o not in before and o.type == "ARMATURE"][0]
    act = arm.animation_data.action
    act.name = name
    # T-поза первого кадра — прочь, клип начинается со второго кадра записи
    for fc in fcurves(act):
        if len(fc.keyframe_points) > 2:
            fc.keyframe_points.remove(fc.keyframe_points[0])
    act.use_fake_user = True
    if main is None:
        main = arm
    else:
        arm.animation_data.action = None
        bpy.data.objects.remove(arm, do_unlink=True)
main.animation_data.action = None
# единицы BVH у CMU свои: масштаб узла скелета приводит рост к 1,7 м (ход корня масштабируется с ним); на перенос
# это не влияет — clip.import меряет отношение ростов — только на вид источника
zs = [b.head_local.z for b in main.data.bones] + [b.tail_local.z for b in main.data.bones]
main.scale = [1.7 / max(1e-6, max(zs) - min(zs))] * 3
bpy.ops.export_scene.gltf(filepath=out, export_format="GLB", export_skins=True, export_animations=True,
                          export_animation_mode="ACTIONS", export_force_sampling=True, export_frame_step=1,
                          export_optimize_animation_size=False, export_apply=False)
print("MERGE_OK", out, len(items))
