# Авториг модели без скелета: blender -b --python autorig.py -- <in> <out.glb> [разрешение=128] [костей вдоль тела=10]
# Меш → воксели (лучи по трём осям, большинство голосов, плюс сама поверхность — чтобы тонкие крылья и плавники
# не пропадали) → дерево суставов (autorig_core.py, граф уровней от самой толстой точки) → кости Blender →
# веса кожи «теплом» Blender; если тепло не справилось (дырявый меш) — по близости к костям. Выход — glb со скином.
import bpy, os, sys, math
import numpy as np
from mathutils import Vector
from mathutils.bvhtree import BVHTree

sys.path.insert(0, os.path.dirname(__file__))
from autorig_core import refine_tips, skeleton

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
mesh = body.data
mesh.calc_loop_triangles()
TRI = np.array([[mesh.vertices[k].co[:] for k in tri.vertices] for tri in mesh.loop_triangles], dtype=np.float64).reshape(-1, 3, 3)


def voxelize(origin, dims, voxel):
    """Воксели тела в сетке: центр вокселя (0,0,0) в origin."""
    votes = np.zeros(dims, dtype=np.int8)
    for axis in range(3):
        u, v = [k for k in range(3) if k != axis]
        inside = np.zeros(dims, dtype=bool)
        d = Vector((0, 0, 0))
        d[axis] = 1
        cells = (np.arange(dims[axis]) * voxel + origin[axis])
        for i in range(dims[u]):
            for j in range(dims[v]):
                o = np.zeros(3)
                o[u] = origin[u] + i * voxel
                o[v] = origin[v] + j * voxel
                o[axis] = origin[axis] - voxel
                p = Vector(o)
                # луч стартует у края сетки: стенки до неё тоже считаем, иначе внутри куба кисти чётность сбита
                hits = []
                q = Vector(o)
                q[axis] = -1e9
                pre = 0
                while True:
                    loc, _n, _i, _d = bvh.ray_cast(q, d, max(0.0, p[axis] - q[axis]))
                    if loc is None:
                        break
                    pre += 1
                    q = loc + d * (voxel * 1e-3)
                p = q if pre else p
                while len(hits) < 64:
                    loc, _n, _i, _d = bvh.ray_cast(p, d)
                    if loc is None:
                        break
                    hits.append(loc[axis])
                    p = loc + d * (voxel * 1e-3)
                if pre + len(hits) < 2:
                    continue
                n = np.searchsorted(np.array(hits), cells) + pre  # сколько стенок до центра вокселя
                col = (n % 2) == 1
                idx = [slice(None)] * 3
                idx[u], idx[v] = i, j
                inside[tuple(idx)] = col
        votes += inside
    occ = votes >= 2
    # поверхность: точки на треугольниках с шагом меньше вокселя — тонкие листы (крылья, плавники) остаются в форме
    top = origin + (np.array(dims) - 1) * voxel
    sel = ((TRI.max(1) >= origin - voxel) & (TRI.min(1) <= top + voxel)).all(1)
    for A, B, C in TRI[sel]:
        m = int(max(np.linalg.norm(B - A), np.linalg.norm(C - A), np.linalg.norm(C - B)) / (voxel * 0.5)) + 1
        st = np.array([(s_ / m, t_ / m) for s_ in range(m + 1) for t_ in range(m + 1 - s_)])
        P = A + np.outer(st[:, 0], B - A) + np.outer(st[:, 1], C - A)
        k = np.floor((P - origin) / voxel + 0.5).astype(int)
        k = k[((k >= 0) & (k < dims)).all(1)]
        occ[k[:, 0], k[:, 1], k[:, 2]] = True
    return occ


occ = voxelize(origin, dims, voxel)

# ручные точки (AUTORIG_MARKERS — JSON в осях Blender): суставы по точкам и пропорциям, имена Mixamo, пальцы шаблоном
import json as _json
_markers = _json.loads(os.environ["AUTORIG_MARKERS"]) if os.environ.get("AUTORIG_MARKERS") else None
bone_names = None
if _markers:
    from autorig_markers import marker_skeleton

    def depth_center(p, axis):
        """Середина тела на линии через p вдоль axis: первая и последняя стенка; мимо тела — сама p."""
        d = Vector(tuple(map(float, axis)))
        far = float(size.max()) * 2
        o = Vector(tuple(map(float, p))) - d * far
        hits = []
        q = o
        while len(hits) < 64:
            loc, _n, _i, _d = bvh.ray_cast(q, d, 2 * far)
            if loc is None:
                break
            hits.append(np.array(loc[:]))
            q = loc + d * (voxel * 1e-3)
        if len(hits) < 2:
            return np.asarray(p, float)
        return (hits[0] + hits[-1]) / 2

    joints, parents, bone_names = marker_skeleton(_markers, V, depth_center, int(_markers.get("fingers", 5)))
    info = {"voxels": int(occ.sum()), "branches": 0}
else:
    joints, parents, info = skeleton(occ, voxel=voxel, origin=tuple(origin), bones_along=along)


def sample(c, half, vox):
    o = np.asarray(c) - half
    n = int(np.ceil(2 * half / vox)) + 1
    return voxelize(o, np.array([n, n, n]), vox), tuple(o)


# пальцы: у кончиков веток форма мельче (AUTORIG_FINGERS=1 — включить; дольше в полтора раза)
hands = 0
if os.environ.get("AUTORIG_FINGERS") == "1" and not _markers:
    joints, parents, hands = refine_tips(joints, parents, sample, log=print if os.environ.get("AUTORIG_DEBUG") else None)
if os.environ.get("AUTORIG_DEBUG"):
    # отладка: проекции формы и скелета (debug_autorig.py рисует из этого картинку)
    import json
    np.save(out + ".occ.npy", occ)
    json.dump({"joints": joints, "parents": parents, "voxel": voxel, "origin": list(map(float, origin)), "info": info}, open(out + ".skel.json", "w"))
# сборная модель (робот из деталей, Xbot): суставы двигаем к стыкам деталей — тогда каждая деталь целиком
# на одной кости и гнётся в щели между деталями, как задумано, а не посередине бедра.
# Стык ищем вдоль кости: точки через полвокселя, у каждой — деталь ближайшей вершины; смена детали — стык
nv0 = len(body.data.vertices)
root_of = list(range(nv0))
def find(x):
    while root_of[x] != x:
        root_of[x] = root_of[root_of[x]]
        x = root_of[x]
    return x
for e in body.data.edges:
    a_, b_ = find(e.vertices[0]), find(e.vertices[1])
    if a_ != b_:
        root_of[a_] = b_
vlab = np.array([find(v) for v in range(nv0)])
# деталь — заметный (≥1 % вершин) остров меньше половины модели; цельная кожа с глазами — не сборка,
# там суставы не трогаем (иначе у лисы пропали бы все суставы туловища: «стыков» внутри кожи нет)
big = set()
for k, n in zip(*np.unique(vlab, return_counts=True)):
    pts_k = V[vlab == k]
    if n >= 0.01 * nv0 and (pts_k.max(0) - pts_k.min(0)).max() < 0.5 * float(size.max()):
        big.add(k)


def snap_to_seams(joints, parents):
    """Суставы → к стыкам деталей; суставы посреди цельной детали многодетальной ветки убираем.
    Возвращает (joints, parents, сдвинуто, убрано)."""
    snapped = 0
    if len(big) < 3:
        return joints, parents, 0, 0
    J = np.array([tuple(j) for j in joints], dtype=float)
    kids0 = [[c for c, p in enumerate(parents) if p == i] for i in range(len(J))]
    def label_at(P):
        out = np.empty(len(P), dtype=np.int64)
        for k0 in range(0, len(P), 256):
            d = ((P[k0:k0 + 256, None, :] - V[None]) ** 2).sum(2)
            out[k0:k0 + 256] = vlab[d.argmin(1)]
        return out
    def pieces(i):
        # сколько деталей на ветке сустава (от развилки до кончика): у Xbot нога — бедро, колено, голень, стопа;
        # у шаблона из трубок нога — одна деталь, и её суставы нужны, чтобы она гнулась
        a_ = i
        while parents[a_] > 0 and len(kids0[parents[a_]]) == 1:
            a_ = parents[a_]
        path = [parents[a_] if parents[a_] >= 0 else a_, a_]
        while len(kids0[path[-1]]) == 1:
            path.append(kids0[path[-1]][0])
        P = np.concatenate([np.linspace(J[path[k]], J[path[k + 1]], 6) for k in range(len(path) - 1)])
        return len({l for l in label_at(P) if l in big})
    newJ = J.copy()
    drop = set()
    for i in range(1, len(J)):
        p = parents[i]
        nxt = J[kids0[i][0]] if len(kids0[i]) == 1 else J[i] + (J[i] - J[p]) * 0.5
        reach = 0.4 * min(np.linalg.norm(J[i] - J[p]), np.linalg.norm(nxt - J[i]))
        n_s = max(4, int(2 * reach / (voxel * 0.5)))
        # отрезок вдоль кости до и после сустава
        d0 = (J[i] - J[p]) / max(np.linalg.norm(J[i] - J[p]), 1e-9)
        d1 = (nxt - J[i]) / max(np.linalg.norm(nxt - J[i]), 1e-9)
        ts = np.linspace(-reach, reach, n_s)
        P = np.array([J[i] + (d0 if t < 0 else d1) * t for t in ts])
        lab = label_at(P)
        lab = np.where(np.isin(lab, list(big)), lab, -1)
        cuts = [0.5 * (ts[k] + ts[k + 1]) for k in range(len(ts) - 1) if lab[k] != lab[k + 1] and lab[k] >= 0 and lab[k + 1] >= 0]
        if not cuts:
            # мелкая вставка (шарнир) между деталями — стык и есть
            cuts = [0.5 * (ts[k] + ts[k + 1]) for k in range(len(ts) - 1) if (lab[k] < 0) != (lab[k + 1] < 0)]
        if cuts:
            t = min(cuts, key=abs)
            newJ[i] = J[i] + (d0 if t < 0 else d1) * t
            snapped += 1
        elif len(kids0[i]) == 1 and lab[0] >= 0 and (lab == lab[0]).all() and pieces(i) >= 3:
            # сустав посреди цельной детали (бедро робота) — гнуть её негде, сустав убираем
            drop.add(i)
    # убираем суставы-середины: дети переходят к родителю, номера сжимаются (родитель по-прежнему раньше)
    keep_i = [i for i in range(len(J)) if i not in drop]
    remap = {old_i: k for k, old_i in enumerate(keep_i)}
    def up_to_kept(p):
        while p in drop:
            p = parents[p]
        return p
    parents = [remap[up_to_kept(parents[i])] if parents[i] >= 0 else -1 for i in keep_i]
    return [Vector(tuple(map(float, newJ[i]))) for i in keep_i], parents, snapped, len(drop)


def build_armature(joints, parents, given=None):
    """Кости: голова — сустав, хвост — к среднему детей (у листа — продолжение от родителя)."""
    arm_data = bpy.data.armatures.new("rig")
    rig = bpy.data.objects.new("rig", arm_data)
    bpy.context.scene.collection.objects.link(rig)
    bpy.context.view_layer.objects.active = rig
    bpy.ops.object.mode_set(mode="EDIT")
    kids = [[c for c, p in enumerate(parents) if p == i] for i in range(len(joints))]
    names = list(given) if given else ["root" if i == 0 else f"j{i:02d}" for i in range(len(joints))]
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
    return rig, kids, names


joints = [Vector(j) for j in joints]
rig, kids, names = build_armature(joints, parents, bone_names)

# веса: тепло Blender; если часть вершин осталась без веса — считаем сами по расстоянию до костей
bpy.ops.object.select_all(action="DESELECT")
body.select_set(True)
rig.select_set(True)
bpy.context.view_layer.objects.active = rig
method = "heat"
snapped = dropped = 0
try:
    bpy.ops.object.parent_set(type="ARMATURE_AUTO")
except Exception as e:
    print("heat failed:", e)
groups = {g.index: g.name for g in body.vertex_groups}
unweighted = sum(1 for v in mesh.vertices if sum(g.weight for g in v.groups if g.group in groups) < 1e-4)
if not body.vertex_groups or unweighted > 0.02 * len(mesh.vertices):
    # тепло не справилось (дырявый или сборный меш). Свои веса: ближние кости, но только те, к которым
    # от вершины есть путь внутри тела (как «видимость» у тепла: бедро не тянет живот, рука — бок), потом
    # сглаживание по рёбрам меша — без него на стыке костей торс мнётся буграми.
    # Вершины, которые тепло уже взвесило, остаются как были
    method = "heat+nearest" if body.vertex_groups else "nearest"
    # сборная модель (тепло на сборках и спотыкается): суставы к стыкам деталей и скелет заново —
    # тогда деталь целиком на своей кости. Где тепло справилось, суставы не трогаем: у шаблонов из трубок
    # «детали» — целые лапы, и им нужны суставы посередине
    # по ручным точкам суставы стоят где сказано — к стыкам деталей их не двигаем
    j2, p2, snapped, dropped = (joints, parents, 0, 0) if _markers else snap_to_seams(joints, parents)
    if snapped or dropped:
        old_rig = rig
        joints, parents = j2, p2
        rig, kids, names = build_armature(joints, parents, bone_names if len(joints) == len(bone_names or []) else None)
        bpy.data.objects.remove(old_rig)
        body.vertex_groups.clear()
        method = "nearest"
    body.parent = rig
    arm_mods = [m for m in body.modifiers if m.type == "ARMATURE"]
    for m in arm_mods:
        m.object = rig
    if not arm_mods:
        body.modifiers.new("rig", "ARMATURE").object = rig
    nb = len(joints)
    W = np.zeros((len(V), nb))
    gi = {g.index: names.index(g.name) for g in body.vertex_groups if g.name in names}
    for v in mesh.vertices:
        for g in v.groups:
            if g.group in gi:
                W[v.index, gi[g.group]] += g.weight
    done = W.sum(1) > 1e-4
    segs = []
    for i in range(nb):
        h = np.array(joints[i][:])
        if kids[i]:
            t = np.mean([np.array(joints[c][:]) for c in kids[i]], axis=0)
        else:
            t = h + (h - np.array(joints[parents[i]][:])) * 0.35 if parents[i] >= 0 else h
        segs.append((h, t))
    H = np.array([s[0] for s in segs]); T = np.array([s[1] for s in segs])
    D = T - H
    L2 = np.maximum((D ** 2).sum(1), 1e-12)
    todo = np.nonzero(~done)[0]
    Vt = V[todo]
    tpar = np.clip(((Vt[:, None, :] - H[None]) * D[None]).sum(2) / L2[None], 0, 1)
    near = H[None] + tpar[..., None] * D[None]
    dist = np.linalg.norm(Vt[:, None, :] - near, axis=2)
    # видимость: точки отрезка вершина → кость (кроме двух крайних вокселей у кожи) лежат в занятых вокселях
    grow = occ.copy()
    for ax in range(3):
        grow |= np.roll(occ, 1, ax) | np.roll(occ, -1, ax)
    def inside(P):
        k = np.floor((P - origin) / voxel + 0.5).astype(int)
        ok = ((k >= 0) & (k < dims)).all(-1)
        k = np.clip(k, 0, dims - 1)
        return ok & grow[k[..., 0], k[..., 1], k[..., 2]]
    ts = np.linspace(0.15, 1.0, 8)
    cand = np.argsort(dist, axis=1)[:, :6]
    for r, vi in enumerate(todo):
        c = cand[r]
        seg_pts = V[vi][None, None] + ts[None, :, None] * (near[r, c][:, None] - V[vi][None, None])
        vis = inside(seg_pts).mean(1) >= 0.85
        c = (c[vis] if vis.any() else c[:1])[:3]
        w = 1.0 / np.maximum(dist[r, c], voxel * 0.25) ** 4
        W[vi, c] = w / w.sum()
    # сглаживание по рёбрам: только у вершин без тепла, 8 проходов
    E = np.array([e.vertices[:] for e in mesh.edges], dtype=np.int64)
    if len(E):
        deg = np.bincount(E.ravel(), minlength=len(V)).astype(float)
        for _ in range(8):
            acc = np.zeros_like(W)
            np.add.at(acc, E[:, 0], W[E[:, 1]])
            np.add.at(acc, E[:, 1], W[E[:, 0]])
            avg = np.where(deg[:, None] > 0, acc / np.maximum(deg, 1)[:, None], W)
            W[todo] = 0.5 * W[todo] + 0.5 * avg[todo]
    # по 4 самые сильные кости на вершину, сумма 1
    top = np.argsort(-W, axis=1)[:, :4]
    body.vertex_groups.clear()
    vg = [body.vertex_groups.new(name=n) for n in names]
    for vi in range(len(V)):
        w = W[vi, top[vi]]
        s_ = w.sum()
        if s_ < 1e-9:
            continue
        for k, bi in enumerate(top[vi]):
            if w[k] / s_ > 0.01:
                vg[bi].add([int(vi)], float(w[k] / s_), "REPLACE")

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
        if os.environ.get("AUTORIG_DEBUG") and len(vs) >= 0.01 * nv:
            print(f"island n={len(vs)} ext={ext_i / model_ext:.2f} share={share:.2f} elong={sd[0] / sd[1]:.1f} top={sorted(score.items(), key=lambda x: -x[1])[:3]}")
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
print(f"AUTORIG_OK joints={len(joints)} markers={1 if _markers else 0} hands={hands} snapped={snapped} dropped={dropped} weights={method} rigid_parts={rigid} unweighted={unweighted} voxels={info['voxels']} branches={info['branches']} res={res}")
