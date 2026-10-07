# Шаблон тела «рыба»: меш + цепочка костей голова→хвост + автоматические веса Blender → glTF.
# Запуск: blender -b --python template_fish.py -- <out.glb> [число_костей=6] [длина=2.4]
import bpy, bmesh, math, sys

args = sys.argv[sys.argv.index("--") + 1:]
out = args[0]
n_bones = int(args[1]) if len(args) > 1 else 6
length = float(args[2]) if len(args) > 2 else 2.4

bpy.ops.wm.read_factory_settings(use_empty=True)
head_x, tail_x = length * 0.45, -length * 0.55


def girth(x):
    """Толщина тела по длине: тупая голова, самое толстое место на трети, тонкий хвостовой стебель."""
    u = (head_x - x) / (head_x - tail_x)  # 0 у носа, 1 у хвоста
    return max(0.02, 0.32 * math.sin(math.pi * min(1.0, u * 1.15) ** 0.7) * (1 - 0.75 * u))


# тело: трубка вдоль X из колец (bmesh), чтобы гнулась плавно
RINGS, SEG = 42, 24
bm = bmesh.new()
rings = []
for i in range(RINGS + 1):
    x = head_x - (head_x - tail_x) * i / RINGS
    g = girth(x)
    rings.append([bm.verts.new((x, math.cos(2 * math.pi * k / SEG) * g * 0.75, math.sin(2 * math.pi * k / SEG) * g)) for k in range(SEG)])
for i in range(RINGS):
    for k in range(SEG):
        a, b = rings[i][k], rings[i][(k + 1) % SEG]
        bm.faces.new((a, b, rings[i + 1][(k + 1) % SEG], rings[i + 1][k]))
bm.faces.new(list(reversed(rings[0])))
bm.faces.new(rings[-1])
body_mesh = bpy.data.meshes.new("FishBody")
bm.normal_update()
bm.to_mesh(body_mesh)
bm.free()
body = bpy.data.objects.new("FishBody", body_mesh)
bpy.context.collection.objects.link(body)
# хвостовой плавник: вертикальная «ласточка»
bm = bmesh.new()
fin = [(tail_x + 0.05, 0, 0), (tail_x - 0.35, 0, 0.32), (tail_x - 0.22, 0, 0), (tail_x - 0.35, 0, -0.32)]
verts = [bm.verts.new(p) for p in fin]
bm.faces.new(verts)
# спинной плавник
dorsal = [(0.25, 0, 0.27), (-0.05, 0, 0.5), (-0.35, 0, 0.2)]
bm.faces.new([bm.verts.new(p) for p in dorsal])
fin_mesh = bpy.data.meshes.new("Fins")
bm.to_mesh(fin_mesh)
bm.free()
fins = bpy.data.objects.new("Fins", fin_mesh)
bpy.context.collection.objects.link(fins)
sol = fins.modifiers.new("thick", "SOLIDIFY")
sol.thickness = 0.02
bpy.context.view_layer.objects.active = fins
bpy.ops.object.modifier_apply(modifier="thick")
# объединяем в один меш
bpy.ops.object.select_all(action="DESELECT")
fins.select_set(True)
body.select_set(True)
bpy.context.view_layer.objects.active = body
bpy.ops.object.join()
bpy.ops.object.shade_smooth()
mat = bpy.data.materials.new("FishSkin")
mat.diffuse_color = (0.25, 0.45, 0.7, 1)
mat.use_nodes = True
mat.node_tree.nodes["Principled BSDF"].inputs["Base Color"].default_value = (0.25, 0.45, 0.7, 1)
body.data.materials.append(mat)

# скелет: root + spine_0..spine_{n-1} от головы к кончику хвоста
arm_data = bpy.data.armatures.new("FishRig")
arm = bpy.data.objects.new("FishRig", arm_data)
bpy.context.collection.objects.link(arm)
bpy.context.view_layer.objects.active = arm
bpy.ops.object.mode_set(mode="EDIT")
root = arm_data.edit_bones.new("root")
root.head, root.tail = (head_x, 0, 0), (head_x, 0, 0.2)
prev = root
xs = [head_x - (head_x - (tail_x - 0.3)) * i / n_bones for i in range(n_bones + 1)]
for i in range(n_bones):
    b = arm_data.edit_bones.new(f"spine_{i}")
    b.head, b.tail = (xs[i], 0, 0), (xs[i + 1], 0, 0)
    b.parent = prev
    b.use_connect = i > 0
    prev = b
bpy.ops.object.mode_set(mode="OBJECT")

bpy.ops.object.select_all(action="DESELECT")
body.select_set(True)
arm.select_set(True)
bpy.context.view_layer.objects.active = arm
bpy.ops.object.parent_set(type="ARMATURE_AUTO")

bpy.ops.export_scene.gltf(filepath=out, export_format="GLB", export_skins=True, export_animations=False, export_apply=False)
print("FISH_OK", out, "bones", n_bones + 1, "verts", len(body.data.vertices))
