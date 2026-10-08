# Общие детали многоногих шаблонов (насекомое, паук, сколопендра): нога «колено вверх» — бедро вверх-наружу,
# голень вниз-наружу к земле, лапка по земле. Персонажи смотрят на +X Blender, как четвероногое.
import math
import bodykit as k


def leg(parts, rig, weights, tag, base, out, reach, knee_h, parent, thick=0.035):
    """Нога от точки base: out — направление наружу (x, y) по земле, reach — вынос стопы от base по земле,
    knee_h — высота колена над base. Кости leg_<tag>_0 (бедро), _1 (голень), _2 (лапка)."""
    ox, oy = out
    n = math.hypot(ox, oy); ox, oy = ox / n, oy / n
    bx, by, bz = base
    knee = (bx + ox * reach * 0.45, by + oy * reach * 0.45, bz + knee_h)
    foot = (bx + ox * reach, by + oy * reach, 0.03)
    tip = (bx + ox * (reach + 0.08 * reach), by + oy * (reach + 0.08 * reach), 0.0)
    parts.append(k.tube(f"Femur_{tag}", base, knee, lambda u: thick * (1 - 0.2 * u), rings=10, seg=8))
    parts.append(k.tube(f"Tibia_{tag}", knee, foot, lambda u: thick * 0.8 * (1 - 0.5 * u) + 0.004, rings=12, seg=8))
    parts.append(k.tube(f"Tarsus_{tag}", foot, tip, lambda u: thick * 0.35, rings=4, seg=6))
    b0 = rig.bone(f"leg_{tag}_0", base, knee, parent=parent)
    b1 = rig.bone(f"leg_{tag}_1", knee, foot, parent=b0, connect=True)
    rig.bone(f"leg_{tag}_2", foot, tip, parent=b1, connect=True)
    for p in ("Femur", "Tibia", "Tarsus"):
        weights[f"{p}_{tag}"] = [f"leg_{tag}_"]
