# «Глаза» агента: рисует кадры из готовых вершин (скиннинг посчитан в CLI по спецификации glTF, packages/cli/src/skin.ts).
# Запуск: blender -b --python render_mesh.py -- <topo.json> <frames.bin> <папка_кадров> <число_кадров> <вид> <отдаление: 1 — целиком> <ширина> <высота>
# frames.bin — float32 подряд: кадр × все вершины всех частей × (x, y, z) в осях Blender.
import bpy, json, math, sys
from array import array
from mathutils import Vector

a = sys.argv[sys.argv.index("--") + 1:]
topo_path, bin_path, out_dir, count, view = a[0], a[1], a[2], int(a[3]), a[4]
dist, width, height = float(a[5]), int(a[6]), int(a[7])

topo = json.load(open(topo_path))
data = array("f")
data.frombytes(open(bin_path, "rb").read())
per_frame = sum(p["verts"] for p in topo) * 3

bpy.ops.wm.read_factory_settings(use_empty=True)
sc = bpy.context.scene
meshes = []
for p in topo:
    me = bpy.data.meshes.new(p["name"])
    f = p["faces"]
    me.from_pydata([(0, 0, 0)] * p["verts"], [], [f[i:i + 3] for i in range(0, len(f), 3)])
    mat = bpy.data.materials.new(p["name"])
    mat.diffuse_color = p["color"]
    me.materials.append(mat)
    for poly in me.polygons:
        poly.use_smooth = True
    ob = bpy.data.objects.new(p["name"], me)
    sc.collection.objects.link(ob)
    meshes.append(ob)


def set_frame(k):
    o = k * per_frame
    for ob, p in zip(meshes, topo):
        n = p["verts"] * 3
        ob.data.vertices.foreach_set("co", data[o:o + n])
        ob.data.update()
        o += n


sc.render.engine = "BLENDER_WORKBENCH"
sc.display.shading.light = "STUDIO"
sc.display.shading.color_type = "MATERIAL"
sc.render.resolution_x, sc.render.resolution_y = width, height
sc.world = bpy.data.worlds.new("w")
sc.world.color = (0.92, 0.93, 0.95)
sc.display.shading.background_type = "WORLD"
cam = bpy.data.objects.new("cam", bpy.data.cameras.new("cam"))
sc.collection.objects.link(cam)
sc.camera = cam

# кадр по габаритам всех поз клипа (удар может вынести руку за rest-габарит); центр — по габаритам, а не по среднему
# вершин: у головы вершин больше всего, кадр уезжал вверх
lo, hi = [1e30] * 3, [-1e30] * 3
for k in range(count):
    base = k * per_frame
    for i in range(base, base + per_frame, 3 * 7):
        for j in range(3):
            v = data[i + j]
            if v < lo[j]: lo[j] = v
            if v > hi[j]: hi[j] = v
lo, hi = Vector(lo), Vector(hi)
c = (lo + hi) / 2
r = (hi - lo).length / 2
set_frame(0)
# пол — непрозрачный диск на z = 0: видно, как стоят ноги, и что ушло под землю или под воду
fl = bpy.data.meshes.new("floor")
R = max(r * 1.6, 1e-3)
ring = [(c.x + R * math.cos(2 * math.pi * k / 48), c.y + R * math.sin(2 * math.pi * k / 48), 0.0) for k in range(48)]
fl.from_pydata(ring, [], [list(range(48))])
fm = bpy.data.materials.new("floor")
fm.diffuse_color = (0.97, 0.97, 0.98, 1)  # в студийном свете плоскость темнеет — берём почти белый
fl.materials.append(fm)
sc.collection.objects.link(bpy.data.objects.new("floor", fl))
# side/top/three_quarter — для тел вдоль X (рыба, змея); front/profile — для персонажей, смотрящих на −Y Blender
el, az = {"side": (5, -90), "top": (89, -90), "three_quarter": (35, -60), "front": (8, -90), "profile": (8, 0), "profile_r": (8, 180), "front_3q": (20, -55), "front_3q_r": (20, -125)}[view]
el, az = math.radians(el), math.radians(az)
d = Vector((math.cos(el) * math.cos(az), math.cos(el) * math.sin(az), math.sin(el)))
# dist — множитель: 1 — сфера вокруг габаритов ровно вписана в узкую сторону кадра
cam.data.sensor_fit = "VERTICAL" if height <= width else "HORIZONTAL"
cam.location = c + d * r / math.sin(cam.data.angle / 2) * dist
cam.rotation_euler = (c - cam.location).to_track_quat("-Z", "Y").to_euler()
cam.data.clip_start, cam.data.clip_end = r * 0.01, r * dist * 10

for k in range(count):
    set_frame(k)
    sc.render.filepath = f"{out_dir}/f_{k:03d}.png"
    bpy.ops.render.render(write_still=True)
print("SHEET_OK", count, "frames")
