# Шаблон «четвероногое»: туловище, шея с головой, хвост и четыре ноги: бедро/плечо, голень/предплечье, ступня.
# Имена костей — смысловые (spine_*, neck_*, head, tail_*, leg_fl_* …): по ним рецепты находят цепочки сами.
# blender -b --python template_quadruped.py -- <out.glb>
import math, os, sys
sys.path.append(os.path.dirname(__file__))
import bodykit as k

out = sys.argv[sys.argv.index("--") + 1:][0]
k.reset()
H = 0.9  # высота спины
parts = [
    k.tube("Torso", (0.7, 0, H), (-0.7, 0, H), lambda u: 0.28 * math.sin(math.pi * (0.15 + 0.7 * u)) ** 0.6, rings=40, seg=20, squash=(0.85, 1.0)),
    k.tube("Neck", (0.6, 0, H + 0.05), (1.0, 0, H + 0.45), lambda u: 0.14 - 0.04 * u, rings=14, seg=14),
    k.tube("Head", (0.95, 0, H + 0.5), (1.4, 0, H + 0.38), lambda u: 0.16 * math.sin(math.pi * (0.2 + 0.8 * u)) ** 0.5 + 0.03, rings=16, seg=16),
    k.tube("Tail", (-0.68, 0, H + 0.05), (-1.4, 0, H + 0.3), lambda u: 0.07 * (1 - u) + 0.01, rings=24, seg=10),
]
legs = {"fl": (0.5, 0.18), "fr": (0.5, -0.18), "bl": (-0.5, 0.18), "br": (-0.5, -0.18)}
for tag, (x, y) in legs.items():
    parts.append(k.tube(f"Leg_{tag}", (x, y, H - 0.05), (x + 0.02, y, 0.07), lambda u: 0.08 - 0.035 * u, rings=24, seg=12))
    parts.append(k.tube(f"Paw_{tag}", (x - 0.02, y, 0.05), (x + 0.16, y, 0.04), lambda u: 0.055 * math.sin(math.pi * (0.15 + 0.7 * u)) ** 0.5, rings=10, seg=12, squash=(1.0, 0.6)))
body = k.join(parts, "QuadBody", (0.6, 0.45, 0.3))

rig = k.Rig("QuadRig")
rig.bone("root", (0, 0, H), (0, 0, H + 0.25))
spine = rig.chain("spine", (-0.65, 0, H), (0.65, 0, H), 4, parent="root")  # от таза к груди
rig.chain("neck", (0.65, 0, H + 0.02), (1.0, 0, H + 0.45), 2, parent=spine[-1])
rig.bone("head", (1.0, 0, H + 0.45), (1.4, 0, H + 0.38), parent="neck_1", connect=True)
rig.chain("tail", (-0.68, 0, H + 0.05), (-1.4, 0, H + 0.3), 4, parent=spine[0])
for tag, (x, y) in legs.items():
    parent = spine[-1] if tag.startswith("f") else spine[0]
    up = rig.bone(f"leg_{tag}_0", (x, y, H - 0.05), (x + 0.04, y, H * 0.5), parent=parent)
    rig.bone(f"leg_{tag}_1", (x + 0.04, y, H * 0.5), (x + 0.02, y, 0.07), parent=up, connect=True)
    # ступня — своя кость: пол и IK ставят на землю её, а не колено
    rig.bone(f"leg_{tag}_2", (x + 0.02, y, 0.07), (x + 0.16, y, 0.04), parent=f"leg_{tag}_1", connect=True)
# детали слушаются только своих костей, иначе автовеса ног тянут живот
weights = {"Torso": ["root", "spine_"], "Neck": ["neck_"], "Head": ["head"], "Tail": ["tail_"]}
for tag in legs:
    weights[f"Leg_{tag}"] = [f"leg_{tag}_"]
    weights[f"Paw_{tag}"] = [f"leg_{tag}_"]
k.bind_and_export(body, rig.done(), out, "QUAD", weights)
