# Авториг модели без скелета: blender -b --python autorig.py -- <in> <out.glb> [разрешение=128] [костей вдоль тела=10]
# Меш → воксели (лучи по трём осям, большинство голосов, плюс сама поверхность — чтобы тонкие крылья и плавники
# не пропадали) → дерево суставов (autorig_core.py, граф уровней от самой толстой точки) → кости Blender →
# веса кожи «теплом» Blender; если тепло не справилось (дырявый меш) — по близости к костям. Выход — glb со скином.
import bpy, os, sys, math
import numpy as np
from mathutils import Vector
from mathutils.bvhtree import BVHTree

sys.path.insert(0, os.path.dirname(__file__))
from autorig_core import skeleton

a = sys.argv[sys.argv.index("--") + 1:]
src, out = a[0], a[1]
res = int(a[2]) if len(a) > 2 else 128
along = int(a[3]) if len(a) > 3 else 10

bpy.ops.wm.read_factory_settings(use_empty=True)
ext = os.path.splitext(src)[1].lower()
imp = {
    ".fbx": lambda: bpy.ops.import_scene.fbx(filepath=src),
    ".glb": lambda: bpy.ops.import_scene.gltf(filepath=src),
    ".gltf": lambda: bpy.ops.import_scene.gltf(filepath=src),
    ".obj": lambda: bpy.ops.wm.obj_import(filepath=src),
    ".dae": lambda: bpy.ops.wm.collada_import(filepath=src),
    ".stl": lambda: bpy.ops.wm.stl_import(filepath=src),
    ".ply": lambda: bpy.ops.wm.ply_import(filepath=src),
}.get(ext)
if not imp:
    print("AUTORIG_ERR формат не поддержан", ext)
    sys.exit(1)
imp()

# если скелет в файле был — персонаж только то, что к нему привязано (кожа и меши на костях); сферы-подставки
# и полы сцен-витрин не берём, как и skin.ts. Без скелета — все меши
def on_armature(o):
    if any(m.type == "ARMATURE" and m.object for m in o.modifiers):
        return True
    p = o.parent
    while p:
        if p.type == "ARMATURE":
            return True
        p = p.parent
    return False
meshes = [o for o in bpy.data.objects if o.type == "MESH"]
rigged = [o for o in meshes if on_armature(o)]
if rigged:
    meshes = rigged
# анимации не нужны; старый скелет уйдёт вместе со всеми объектами после склейки
# (удалять его раньше нельзя — сдвинется мировое положение мешей-детей)
for act in list(bpy.data.actions):
    bpy.data.actions.remove(act)
if not meshes:
    print("AUTORIG_ERR в файле нет мешей")
    sys.exit(1)
# склейка без операторов (join в фоне путает активный объект): меши в мировых координатах → один bmesh
import bmesh
bm = bmesh.new()
mats = []
for o in meshes:
    me = o.data.copy()
    me.transform(o.matrix_world)
    off = len(mats)
    mats += list(me.materials)
    for poly in me.polygons:
        poly.material_index += off
    bm.from_mesh(me)
    bpy.data.meshes.remove(me)
merged = bpy.data.meshes.new("body")
bm.to_mesh(merged)
bm.free()
for m in mats:
    merged.materials.append(m)
for o in list(bpy.data.objects):
    bpy.data.objects.remove(o)
body = bpy.data.objects.new("body", merged)
bpy.context.scene.collection.objects.link(body)
bpy.context.view_layer.objects.active = body

V = np.array([v.co[:] for v in body.data.vertices], dtype=np.float64)
lo, hi = V.min(0), V.max(0)
size = hi - lo
voxel = float(size.max()) / res
pad = 2
dims = np.ceil(size / voxel).astype(int) + 2 * pad
origin = lo - (pad - 0.5) * voxel  # центр вокселя (0,0,0)

bvh = BVHTree.FromObject(body, bpy.context.evaluated_depsgraph_get())
votes = np.zeros(dims, dtype=np.int8)
for axis in range(3):
    u, v = [k for k in range(3) if k != axis]
    inside = np.zeros(dims, dtype=bool)
    d = Vector((0, 0, 0))
    d[axis] = 1
    for i in range(dims[u]):
        for j in range(dims[v]):
            o = np.zeros(3)
            o[u] = origin[u] + i * voxel
            o[v] = origin[v] + j * voxel
            o[axis] = origin[axis] - voxel
            p = Vector(o)
            hits = []
            while len(hits) < 64:
                loc, _n, _i, _d = bvh.ray_cast(p, d)
                if loc is None:
                    break
                hits.append(loc[axis])
                p = loc + d * (voxel * 1e-3)
            if len(hits) < 2:
                continue
            cells = (np.arange(dims[axis]) * voxel + origin[axis])
            n = np.searchsorted(np.array(hits), cells)  # сколько стенок до центра вокселя
            col = (n % 2) == 1
            idx = [slice(None)] * 3
            idx[u], idx[v] = i, j
            inside[tuple(idx)] = col
    votes += inside
occ = votes >= 2
# поверхность: точки на треугольниках с шагом меньше вокселя — тонкие листы (крылья, плавники) остаются в форме
mesh = body.data
mesh.calc_loop_triangles()
for tri in mesh.loop_triangles:
    A, B, C = (np.array(mesh.vertices[k].co[:]) for k in tri.vertices)
    m = int(max(np.linalg.norm(B - A), np.linalg.norm(C - A), np.linalg.norm(C - B)) / (voxel * 0.5)) + 1
    for s in range(m + 1):
        for t in range(m + 1 - s):
            P = A + (B - A) * (s / m) + (C - A) * (t / m)
            k = np.floor((P - origin) / voxel + 0.5).astype(int)
            if (k >= 0).all() and (k < dims).all():
                occ[tuple(k)] = True

joints, parents, info = skeleton(occ, voxel=voxel, origin=tuple(origin), bones_along=along)
if os.environ.get("AUTORIG_DEBUG"):
    # отладка: проекции формы и скелета (debug_autorig.py рисует из этого картинку)
    import json
    np.save(out + ".occ.npy", occ)
    json.dump({"joints": joints, "parents": parents, "voxel": voxel, "origin": list(map(float, origin)), "info": info}, open(out + ".skel.json", "w"))
joints = [Vector(j) for j in joints]

# кости: голова — сустав, хвост — к среднему детей (у листа — продолжение от родителя)
arm_data = bpy.data.armatures.new("rig")
rig = bpy.data.objects.new("rig", arm_data)
bpy.context.scene.collection.objects.link(rig)
bpy.context.view_layer.objects.active = rig
bpy.ops.object.mode_set(mode="EDIT")
kids = [[c for c, p in enumerate(parents) if p == i] for i in range(len(joints))]
names = ["root" if i == 0 else f"j{i:02d}" for i in range(len(joints))]
ebones = []
for i, jp in enumerate(joints):
    b = arm_data.edit_bones.new(names[i])
    b.head = jp
    if kids[i]:
        t = sum((joints[c] for c in kids[i]), Vector()) / len(kids[i])
        if (t - jp).length < voxel * 0.5:
            t = jp + Vector((0, 0, voxel * 2))
    else:
        p = joints[parents[i]] if parents[i] >= 0 else jp - Vector((0, 0, voxel))
        t = jp + (jp - p) * 0.35
        if (t - jp).length < voxel * 0.5:
            t = jp + Vector((0, 0, voxel * 2))
    b.tail = t
    ebones.append(b)
for i, p in enumerate(parents):
    if p >= 0:
        ebones[i].parent = ebones[p]
bpy.ops.object.mode_set(mode="OBJECT")

# веса: тепло Blender; если часть вершин осталась без веса — считаем сами по расстоянию до костей
bpy.ops.object.select_all(action="DESELECT")
body.select_set(True)
rig.select_set(True)
bpy.context.view_layer.objects.active = rig
method = "heat"
try:
    bpy.ops.object.parent_set(type="ARMATURE_AUTO")
except Exception as e:
    print("heat failed:", e)
groups = {g.index: g.name for g in body.vertex_groups}
unweighted = sum(1 for v in mesh.vertices if sum(g.weight for g in v.groups if g.group in groups) < 1e-4)
if not body.vertex_groups or unweighted > 0.02 * len(mesh.vertices):
    method = "nearest"
    if body.parent is None:
        body.parent = rig
    if not any(m.type == "ARMATURE" for m in body.modifiers):
        body.modifiers.new("rig", "ARMATURE").object = rig
    body.vertex_groups.clear()
    segs = []
    for i in range(len(joints)):
        h = np.array(joints[i][:])
        if kids[i]:
            t = np.mean([np.array(joints[c][:]) for c in kids[i]], axis=0)
        else:
            t = h + (h - np.array(joints[parents[i]][:])) * 0.35 if parents[i] >= 0 else h
        segs.append((h, t))
    H = np.array([s[0] for s in segs]); T = np.array([s[1] for s in segs])
    D = T - H
    L2 = np.maximum((D ** 2).sum(1), 1e-12)
    tpar = np.clip(((V[:, None, :] - H[None]) * D[None]).sum(2) / L2[None], 0, 1)
    dist = np.linalg.norm(V[:, None, :] - (H[None] + tpar[..., None] * D[None]), axis=2)
    top = np.argsort(dist, axis=1)[:, :3]
    vg = [body.vertex_groups.new(name=n) for n in names]
    for vi in range(len(V)):
        d = dist[vi, top[vi]]
        w = 1.0 / np.maximum(d, voxel * 0.25) ** 4
        w /= w.sum()
        for k, bi in enumerate(top[vi]):
            if w[k] > 0.01:
                vg[bi].add([vi], float(w[k]), "REPLACE")

# детали-острова (у сборных моделей голова, шапка, молоток — отдельные куски; у цельных — глаза, зубы):
# остров меньше половины модели целиком на одну кость — ту, что держит его сильнее всего, если он короткий
# (до полутора костей), округлый или одна кость и так держит его больше чем на 60 %. Иначе тепло
# растаскивает жёсткую деталь между соседними костями, и голова робота мнётся
nv = len(mesh.vertices)
root_of = list(range(nv))
def find(x):
    while root_of[x] != x:
        root_of[x] = root_of[root_of[x]]
        x = root_of[x]
    return x
for e in mesh.edges:
    a_, b_ = find(e.vertices[0]), find(e.vertices[1])
    if a_ != b_:
        root_of[a_] = b_
islands = {}
for vi in range(nv):
    islands.setdefault(find(vi), []).append(vi)
gname = {g.index: g.name for g in body.vertex_groups}
model_ext = float(size.max())
rigid = 0
if len(islands) > 1:
    seg_h = {names[i]: np.array(joints[i][:]) for i in range(len(joints))}
    for vs in islands.values():
        pts = V[vs]
        ext_i = float((pts.max(0) - pts.min(0)).max())
        if ext_i >= 0.5 * model_ext:
            continue
        score = {}
        for vi in vs:
            for g in mesh.vertices[vi].groups:
                if g.group in gname:
                    score[gname[g.group]] = score.get(gname[g.group], 0.0) + g.weight
        # длинная вытянутая деталь, которую тепло честно делит между костями (нога-цилиндр), должна гнуться;
        # округлая (голова, панцирь) — жёсткая, даже если большая
        share = max(score.values()) / sum(score.values()) if score else 1.0
        sd = np.sqrt(np.sort(np.linalg.eigvalsh(np.cov((pts - pts.mean(0)).T) + 1e-12 * np.eye(3)))[::-1])
        elongated = sd[0] > 2.0 * sd[1]
        if ext_i > 1.5 * model_ext / along and share < 0.6 and elongated:
            continue
        if score:
            bone = max(score, key=score.get)
        else:
            c = pts.mean(0)
            bone = min(seg_h, key=lambda n: float(np.linalg.norm(seg_h[n] - c)))
        for g in body.vertex_groups:
            g.remove(vs)
        (body.vertex_groups.get(bone) or body.vertex_groups.new(name=bone)).add(vs, 1.0, "REPLACE")
        rigid += 1

os.makedirs(os.path.dirname(os.path.abspath(out)), exist_ok=True)
bpy.ops.export_scene.gltf(filepath=out, export_format="GLB", export_animations=False, export_skins=True, use_selection=False)
print(f"AUTORIG_OK joints={len(joints)} weights={method} rigid_parts={rigid} unweighted={unweighted} voxels={info['voxels']} branches={info['branches']} res={res}")
