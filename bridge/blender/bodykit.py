# Кирпичики шаблонов тел: трубка по профилю, плоские плавники, цепочки костей, автоматические веса, экспорт.
# Ось тела задаётся двумя точками, профиль — функцией толщины от u ∈ [0, 1] (0 — основание, 1 — кончик).
import bpy, bmesh, math
from mathutils import Vector


def reset():
    bpy.ops.wm.read_factory_settings(use_empty=True)


def tube(name, a, b, radius, rings=40, seg=20, squash=(1.0, 1.0), cap=True):
    """Трубка от точки a к точке b; radius(u) — толщина; squash — сжатие по двум поперечным осям."""
    a, b = Vector(a), Vector(b)
    axis = (b - a).normalized()
    side = axis.cross(Vector((0, 0, 1)))
    if side.length < 1e-4:
        side = axis.cross(Vector((0, 1, 0)))
    side.normalize()
    up = side.cross(axis).normalized()
    bm = bmesh.new()
    rows = []
    for i in range(rings + 1):
        u = i / rings
        c = a.lerp(b, u)
        r = radius(u)
        rows.append([bm.verts.new(c + side * math.cos(2 * math.pi * k / seg) * r * squash[0] + up * math.sin(2 * math.pi * k / seg) * r * squash[1]) for k in range(seg)])
    for i in range(rings):
        for k in range(seg):
            bm.faces.new((rows[i][k], rows[i][(k + 1) % seg], rows[i + 1][(k + 1) % seg], rows[i + 1][k]))
    if cap:
        bm.faces.new(list(reversed(rows[0])))
        bm.faces.new(rows[-1])
    return finish(bm, name)


def flat(name, polys, thickness=0.02):
    """Плоские детали (плавники, уши): список многоугольников, каждый — список точек."""
    bm = bmesh.new()
    for poly in polys:
        bm.faces.new([bm.verts.new(p) for p in poly])
    obj = finish(bm, name)
    m = obj.modifiers.new("thick", "SOLIDIFY")
    m.thickness = thickness
    bpy.context.view_layer.objects.active = obj
    bpy.ops.object.modifier_apply(modifier="thick")
    return obj


def finish(bm, name):
    me = bpy.data.meshes.new(name)
    bm.normal_update()
    bm.to_mesh(me)
    bm.free()
    obj = bpy.data.objects.new(name, me)
    bpy.context.collection.objects.link(obj)
    return obj


def join(objs, name, color):
    # каждая деталь помечается группой «part:<имя>» — по ней bind_and_export ограничит веса своими костями
    for o in objs:
        g = o.vertex_groups.new(name="part:" + o.name)
        g.add([v.index for v in o.data.vertices], 1.0, "REPLACE")
    bpy.ops.object.select_all(action="DESELECT")
    for o in objs:
        o.select_set(True)
    bpy.context.view_layer.objects.active = objs[0]
    bpy.ops.object.join()
    body = bpy.context.active_object
    body.name = name
    bpy.ops.object.shade_smooth()
    # близкие вершины на стыках деталей сливаем, иначе веса рвутся
    bm = bmesh.new()
    bm.from_mesh(body.data)
    bmesh.ops.remove_doubles(bm, verts=bm.verts, dist=1e-4)
    bm.to_mesh(body.data)
    bm.free()
    mat = bpy.data.materials.new(name + "Skin")
    mat.use_nodes = True
    mat.diffuse_color = (*color, 1)
    mat.node_tree.nodes["Principled BSDF"].inputs["Base Color"].default_value = (*color, 1)
    body.data.materials.append(mat)
    return body


class Rig:
    def __init__(self, name):
        self.data = bpy.data.armatures.new(name)
        self.obj = bpy.data.objects.new(name, self.data)
        bpy.context.collection.objects.link(self.obj)
        bpy.context.view_layer.objects.active = self.obj
        bpy.ops.object.mode_set(mode="EDIT")
        self.bones = {}

    def bone(self, name, head, tail, parent=None, connect=False):
        b = self.data.edit_bones.new(name)
        b.head, b.tail = Vector(head), Vector(tail)
        if parent:
            b.parent = self.bones[parent]
            b.use_connect = connect
        self.bones[name] = b
        return name

    def chain(self, prefix, a, b, n, parent=None):
        """n костей подряд от a к b: prefix_0 … prefix_{n-1}."""
        a, b = Vector(a), Vector(b)
        names = []
        for i in range(n):
            names.append(self.bone(f"{prefix}_{i}", a.lerp(b, i / n), a.lerp(b, (i + 1) / n), parent if i == 0 else names[-1], connect=i > 0))
        return names

    def done(self):
        bpy.ops.object.mode_set(mode="OBJECT")
        return self.obj


def restrict_weights(body, parts):
    """parts: деталь → префиксы костей, которым она может принадлежать. Автовеса «протекают» между близкими деталями
    (рука тянет туловище и голову), поэтому лишние кости у вершин детали обнуляем и нормируем остаток."""
    names = {g.index: g.name for g in body.vertex_groups}
    fixed = 0
    for v in body.data.vertices:
        part = next((names[g.group][5:] for g in v.groups if names[g.group].startswith("part:")), None)
        if part not in parts:
            continue
        ok = lambda n: any(n.startswith(pre) for pre in parts[part])
        bones = [(g.group, g.weight) for g in v.groups if not names[g.group].startswith("part:")]
        keep = [(i, w) for i, w in bones if ok(names[i]) and w > 1e-4]
        if len(keep) != len([b for b in bones if b[1] > 1e-4]):
            fixed += 1
        for i, _ in bones:
            body.vertex_groups[names[i]].remove([v.index])
        if not keep:  # деталь целиком ушла чужим костям — жёстко на первую свою
            first = next(n for n in names.values() if not n.startswith("part:") and ok(n))
            keep = [(body.vertex_groups[first].index, 1.0)]
        total = sum(w for _, w in keep)
        for i, w in keep:
            body.vertex_groups[names[i]].add([v.index], w / total, "REPLACE")
    for g in [g for g in body.vertex_groups if g.name.startswith("part:")]:
        body.vertex_groups.remove(g)
    return fixed


def bind_and_export(body, arm, out, tag, parts=None):
    bpy.ops.object.select_all(action="DESELECT")
    body.select_set(True)
    arm.select_set(True)
    bpy.context.view_layer.objects.active = arm
    bpy.ops.object.parent_set(type="ARMATURE_AUTO")
    if parts:
        print(f"{tag}_PARTS вершин с чужими костями исправлено:", restrict_weights(body, parts))
    else:
        for g in [g for g in body.vertex_groups if g.name.startswith("part:")]:
            body.vertex_groups.remove(g)
    # вершины без веса (автовеса иногда «теряют» тонкие детали) — проверка качества шаблона
    unweighted = sum(1 for v in body.data.vertices if not any(g.weight > 1e-3 for g in v.groups))
    bpy.ops.export_scene.gltf(filepath=out, export_format="GLB", export_skins=True, export_animations=False)
    print(f"{tag}_OK", out, "bones", len(arm.data.bones), "verts", len(body.data.vertices), "unweighted", unweighted)
