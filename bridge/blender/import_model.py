# Импорт чужой модели (FBX, OBJ, glTF, DAE) и пересохранение в glb со скином — вход для AnimForge.
# blender -b --python import_model.py -- <in> <out.glb>
import bpy, os, sys
a = sys.argv[sys.argv.index("--") + 1:]
src, out = a[0], a[1]
bpy.ops.wm.read_factory_settings(use_empty=True)
ext = os.path.splitext(src)[1].lower()
if ext == ".fbx":
    # импортёр FBX в Blender 5 падает на светильниках старых файлов (lamp.cycles.cast_shadow) — свет не нужен
    try:
        import io_scene_fbx.import_fbx as F
        F.blen_read_light = lambda *a, **k: bpy.data.lights.new(name="light", type="POINT")
    except Exception as e:
        print("IMPORT_WARN", e)
    bpy.ops.import_scene.fbx(filepath=src, automatic_bone_orientation=True, ignore_leaf_bones=True)
elif ext in (".glb", ".gltf"):
    bpy.ops.import_scene.gltf(filepath=src)
elif ext == ".obj":
    bpy.ops.wm.obj_import(filepath=src)
elif ext == ".dae":
    bpy.ops.wm.collada_import(filepath=src)
else:
    print("IMPORT_ERR формат не поддержан", ext); sys.exit(1)
arms = [o for o in bpy.data.objects if o.type == "ARMATURE"]
meshes = [o for o in bpy.data.objects if o.type == "MESH"]
# анимации исходника не нужны: AnimForge пишет свои клипы
for o in bpy.data.objects:
    if o.animation_data: o.animation_data_clear()
for act in list(bpy.data.actions): bpy.data.actions.remove(act)
# кожа должна сидеть на своих костях. Движки (Unity, Godot, glTF) кладут вершины по матрицам привязки, а положение
# узла меша игнорируют; Blender же рисует меш по его узлу. У моделей, вытащенных рипером из сцен-витрин, меш и скелет
# висят под разными узлами — и смысл вершин неоднозначен: «как видит Blender» (мировое положение меша) или «как видит
# движок» (вершины в системе скелета). Выбираем тот вариант, где вершины ближе к костям, на которые у них вес.
from mathutils import Matrix
from mathutils.geometry import intersect_point_line


def bone_fit(m, arm, rel):
    """Средняя дистанция вершины до своей главной кости (в системе скелета) при переводе вершин матрицей rel."""
    bones = arm.data.bones
    names = {g.index: g.name for g in m.vertex_groups}
    vs = m.data.vertices
    step = max(1, len(vs) // 3000)
    total, n = 0.0, 0
    for i in range(0, len(vs), step):
        v = vs[i]
        g = max(v.groups, key=lambda g: g.weight, default=None)
        b = bones.get(names.get(g.group, "")) if g else None
        if not b:
            continue
        p = rel @ v.co
        cl, t = intersect_point_line(p, b.head_local, b.tail_local)
        if t < 0: cl = b.head_local
        elif t > 1: cl = b.tail_local
        total += (p - cl).length
        n += 1
    return total / n if n else 0.0


fixed = []
for m in meshes:
    mod = next((x for x in m.modifiers if x.type == "ARMATURE" and x.object), None)
    if not mod:
        continue
    arm = mod.object
    rel = arm.matrix_world.inverted() @ m.matrix_world
    if max(abs(rel[i][j] - (1 if i == j else 0)) for i in range(4) for j in range(4)) < 1e-6:
        continue
    keep, snap = bone_fit(m, arm, rel), bone_fit(m, arm, Matrix.Identity(4))
    if keep <= snap:
        m.data.transform(rel)  # как видит Blender: сохраняем мировое положение вершин
    w = arm.matrix_world.copy()
    m.parent = arm
    m.parent_type = "OBJECT"
    m.matrix_parent_inverse.identity()
    m.matrix_world = w
    fixed.append(f"{m.name}:{'blender' if keep <= snap else 'engine'}({keep:.4g}/{snap:.4g})")
bpy.context.view_layer.update()
bpy.ops.export_scene.gltf(filepath=out, export_format="GLB", export_skins=True, export_animations=False)
print("IMPORT_OK", out, "armatures", len(arms), "bones", sum(len(x.data.bones) for x in arms), "meshes", len(meshes), "rebased", fixed)
