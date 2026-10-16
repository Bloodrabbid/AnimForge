# Авториг по ручным точкам (как у Mixamo): подбородок, пах, запястья, локти, колени — точки на коже, кликнутые
# спереди. Глубину каждой точки берём серединой тела на этой линии (луч вперёд-назад: первая и последняя стенка),
# остальные суставы — по пропорциям человека от этих точек (на глаз, по анатомическим атласам: шея ≈ 13 % пути
# подбородок → пах ниже подбородка, плечо — продолжение линии запястье → локоть на длину предплечья ×1.05 и т. д.).
# Пальцы — по шаблону, даже у сомкнутой кисти-варежки: кисть меряется по вершинам за запястьем, пальцы ставятся
# веером поперёк неё, большой — со стороны «вперёд». Имена — как у Mixamo, rig.detect узнаёт их сам.
# Координаты — Blender (Z вверх). Чистые функции: луч и вершины передаются снаружи — так это проверяется без Blender.
import numpy as np

SIDES = (("l", "Left"), ("r", "Right"))


def _n(v):
    v = np.asarray(v, float)
    n = np.linalg.norm(v)
    return v / n if n > 1e-12 else v


def marker_skeleton(m, V, depth_center, fingers=5):
    """m — точки: chin, groin, wrist_l/r, elbow_l/r, knee_l/r (Blender), forward — куда смотрит персонаж.
    V — вершины кожи (N×3). depth_center(p, axis) — середина тела на линии через p вдоль axis (или p, если мимо).
    Возвращает (joints, parents, names)."""
    up = np.array([0.0, 0.0, 1.0])
    fwd = _n(np.asarray(m.get("forward", (0, -1, 0)), float) - up * np.dot(m.get("forward", (0, -1, 0)), up))
    zmin, zmax = float(V[:, 2].min()), float(V[:, 2].max())
    H = zmax - zmin
    P = {k: depth_center(np.asarray(m[k], float), fwd) for k in ("chin", "groin", "wrist_l", "wrist_r", "elbow_l", "elbow_r", "knee_l", "knee_r")}
    J, par, names = [], [], []

    def add(name, p, parent):
        J.append(tuple(map(float, p)))
        par.append(names.index(parent) if parent else -1)
        names.append(name)

    mid_x = (P["groin"][0] + P["chin"][0]) / 2
    hips = depth_center(np.array([mid_x, P["groin"][1], P["groin"][2] + 0.05 * H]), fwd)
    chin = P["chin"]
    neck_z = chin[2] - 0.13 * (chin[2] - P["groin"][2])
    add("Hips", hips, None)
    prev = "Hips"
    for k, nm in enumerate(("Spine", "Spine1", "Spine2")):
        z = hips[2] + (neck_z - hips[2]) * (k + 1) / 4
        add(nm, depth_center(np.array([mid_x, hips[1], z]), fwd), prev)
        prev = nm
    neck = depth_center(np.array([mid_x, chin[1], neck_z]), fwd)
    add("Neck", neck, prev)
    head = depth_center(np.array([mid_x, chin[1], chin[2] + 0.02 * H]), fwd)
    add("Head", head, "Neck")
    add("HeadTop_End", np.array([head[0], head[1], zmax]), "Head")
    for s, S in SIDES:
        w, e = P[f"wrist_{s}"], P[f"elbow_{s}"]
        fore = np.linalg.norm(w - e)
        shoulder = e + _n(e - w) * fore * 1.05
        shoulder[2] = min(shoulder[2], neck_z)
        clav = np.array([mid_x + (shoulder[0] - mid_x) * 0.25, neck[1], neck_z - 0.015 * H])
        add(f"{S}Shoulder", clav, "Spine2")
        add(f"{S}Arm", shoulder, f"{S}Shoulder")
        add(f"{S}ForeArm", e, f"{S}Arm")
        add(f"{S}Hand", w, f"{S}ForeArm")
        _hand(add, S, w, e, V, fwd, H, fingers)
        k = P[f"knee_{s}"]
        hip_j = np.array([k[0], hips[1], P["groin"][2]])
        add(f"{S}UpLeg", hip_j, "Hips")
        add(f"{S}Leg", k, f"{S}UpLeg")
        ankle = np.array([k[0], k[1], zmin + 0.045 * H])
        add(f"{S}Foot", ankle, f"{S}Leg")
        # носок: вершины стопы впереди лодыжки — самая дальняя по «вперёд»
        near = V[(np.abs(V[:, 0] - k[0]) < 0.08 * H) & (V[:, 2] < zmin + 0.08 * H)]
        reach = float(np.max((near - ankle) @ fwd)) if len(near) else 0.08 * H
        reach = max(reach, 0.04 * H)
        add(f"{S}ToeBase", ankle + fwd * reach * 0.65 + up * (-0.025 * H), f"{S}Foot")
        add(f"{S}Toe_End", ankle + fwd * reach + up * (-0.03 * H), f"{S}ToeBase")
    return J, par, names


FINGERS = ("Thumb", "Index", "Middle", "Ring", "Pinky")


def _hand(add, S, w, e, V, fwd, H, fingers):
    """Пальцы веером: кисть — вершины за запястьем вдоль предплечья (не дальше 0.13 роста), её длина и ширина."""
    f = _n(w - e)
    rel = V - w
    along = rel @ f
    sel = (along > 0) & (np.linalg.norm(rel, axis=1) < 0.13 * H)
    L = float(along[sel].max()) if sel.any() else 0.08 * H
    # поперёк кисти — горизонталь, перпендикулярная предплечью; большой палец — с той стороны, что ближе к «вперёд»
    across = _n(np.cross(f, [0.0, 0.0, 1.0]))
    if np.dot(across, fwd) < 0:
        across = -across
    pts = rel[sel]
    wide = (pts @ across) if len(pts) else np.array([-0.02 * H, 0.02 * H])
    lo, hi = float(np.percentile(wide, 5)), float(np.percentile(wide, 95))
    if fingers <= 0:
        add(f"{S}HandEnd", w + f * L, f"{S}Hand")
        return
    knuck = w + f * 0.45 * L
    rest = L * 0.55
    # 5 — большой и четыре; 1…4 — без большого, с указательного
    n4 = list(FINGERS[1:1 + min(4, fingers)]) if fingers < 5 else list(FINGERS[1:])
    thumb = fingers >= 5
    top = lo + (hi - lo) * (0.85 if thumb else 1.0)  # у большого — свой край кисти
    for k, nm in enumerate(n4):
        t = top - (k + 0.5) * (top - lo) / len(n4)
        prev = f"{S}Hand"
        p = knuck + across * t
        for j, sg in enumerate((0.45, 0.30, 0.25)):
            add(f"{S}Hand{nm}{j + 1}", p, prev)
            prev = f"{S}Hand{nm}{j + 1}"
            p = p + f * rest * sg
        add(f"{S}Hand{nm}4", p, prev)
    if thumb:
        # большой — от основания ладони к «вперёд» и вдоль кисти
        d = _n(f * 0.6 + across * 0.8)
        prev = f"{S}Hand"
        p = w + f * 0.12 * L + across * hi * 0.9
        for j, sg in enumerate((0.35, 0.3, 0.25)):
            add(f"{S}HandThumb{j + 1}", p, prev)
            prev = f"{S}HandThumb{j + 1}"
            p = p + d * L * sg
        add(f"{S}HandThumb4", p, prev)
