# «Глаза» агента: рендерит клип из glb в кадры (лист кадров собирает CLI через magick).
# Запуск: blender -b --python render_sheet.py -- <in.glb> <анимация> <папка_кадров> <число_кадров> <вид: side|top|three_quarter>
import bpy, math, sys
from mathutils import Vector

a = sys.argv[sys.argv.index("--") + 1:]
glb, anim, out_dir, count, view = a[0], a[1], a[2], int(a[3]), a[4]

bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.import_scene.gltf(filepath=glb)
arm = next(o for o in bpy.data.objects if o.type == "ARMATURE")
act = next((x for x in bpy.data.actions if x.name == anim or x.name.startswith(anim)), None)
if act is None:
    print("SHEET_ERR no action", anim, [x.name for x in bpy.data.actions])
    sys.exit(1)
if arm.animation_data is None:
    arm.animation_data_create()
arm.animation_data.action = act
f0, f1 = act.frame_range
meshes = [o for o in bpy.data.objects if o.type == "MESH"]

sc = bpy.context.scene
sc.render.engine = "BLENDER_WORKBENCH"
sc.display.shading.light = "STUDIO"
sc.display.shading.color_type = "MATERIAL"
sc.render.resolution_x, sc.render.resolution_y = (int(a[6]), int(a[7])) if len(a) > 7 else (480, 300)
sc.world = bpy.data.worlds.new("w")
sc.world.color = (0.92, 0.93, 0.95)
sc.display.shading.background_type = "WORLD"
cam = bpy.data.objects.new("cam", bpy.data.cameras.new("cam"))
sc.collection.objects.link(cam)
sc.camera = cam

# кадр по объёму меша во всех позах: охват считаем по первому кадру с запасом
sc.frame_set(int(f0))
dg = bpy.context.evaluated_depsgraph_get()
pts = []
for m in meshes:
    ev = m.evaluated_get(dg)
    me = ev.to_mesh()
    pts += [ev.matrix_world @ v.co for v in me.vertices]
    ev.to_mesh_clear()
c = sum(pts, Vector()) / len(pts)
r = max((p - c).length for p in pts)
# side/top/three_quarter — для тел вдоль X (рыба, змея); front/profile — для персонажей, смотрящих на −Y Blender
el, az = {"side": (5, -90), "top": (89, -90), "three_quarter": (35, -60), "front": (8, -90), "profile": (8, 0), "front_3q": (20, -55)}[view]
el, az = math.radians(el), math.radians(az)
d = Vector((math.cos(el) * math.cos(az), math.cos(el) * math.sin(az), math.sin(el)))
cam.location = c + d * r * float(a[5] if len(a) > 5 else 3.4)
cam.rotation_euler = (c - cam.location).to_track_quat("-Z", "Y").to_euler()

for k in range(count):
    f = f0 + (f1 - f0) * k / count
    sc.frame_set(int(f), subframe=f - int(f))
    sc.render.filepath = f"{out_dir}/f_{k:03d}.png"
    bpy.ops.render.render(write_still=True)
print("SHEET_OK", count, "frames", act.name, round(f0, 2), round(f1, 2))
