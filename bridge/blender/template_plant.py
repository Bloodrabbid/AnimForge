# Шаблон «растение-хищник» (по эхинопсу Witcher): стебель из костей stem_* вверх, верх загнут крючком вперёд-вниз,
# голова с четырьмя челюстями-лепестками jaw_*. Смотрит на +X Blender.
# blender -b --python template_plant.py -- <out.glb> [число костей стебля, по умолчанию 10]
import math, os, sys
sys.path.append(os.path.dirname(__file__))
import bodykit as k

a = sys.argv[sys.argv.index("--") + 1:]
out, N = a[0], int(a[1]) if len(a) > 1 else 10
k.reset()
# путь стебля: прямо вверх на 2/3, потом дуга вперёд и вниз (крючок)
def pt(u):
    if u < 0.65:
        return (0.0, 0.0, 2.2 * u / 0.65)
    w = (u - 0.65) / 0.35 * math.pi * 0.75
    return (0.45 * math.sin(w), 0.0, 2.2 + 0.45 * (1 - math.cos(w)) * 0.4 - 0.5 * (w / (math.pi * 0.75)) ** 2)
P = [pt(i / N) for i in range(N + 1)]
parts = [k.tube(f"Stem_{i}", P[i], P[i + 1], lambda u, i=i: 0.13 * (1 - 0.55 * (i + u) / N) + 0.03, rings=6, seg=14) for i in range(N)]
head0 = P[-1]
hd = (head0[0] + 0.05, 0, head0[2] - 0.3)
parts.append(k.tube("Head", head0, hd, lambda u: 0.16 * math.sin(math.pi * (0.1 + 0.8 * u)) ** 0.5, rings=12, seg=16))
JAW = []
for j in range(4):
    ang = math.radians(90 * j)
    tip = (hd[0] + 0.25 * math.cos(ang), 0.25 * math.sin(ang), hd[2] - 0.25)
    JAW.append(tip)
    parts.append(k.tube(f"Jaw_{j}", hd, tip, lambda u: 0.07 * (1 - u) + 0.01, rings=8, seg=10, squash=(1.0, 0.4)))
parts.append(k.tube("Pot", (0, 0, -0.05), (0, 0, 0.12), lambda u: 0.35 - 0.1 * u, rings=4, seg=20))
rig = k.Rig("PlantRig")
rig.bone("root", (0, 0, -0.05), (0, 0, 0.12))
stem = []
for i in range(N):
    stem.append(rig.bone(f"stem_{i}", P[i], P[i + 1], parent="root" if i == 0 else stem[-1], connect=i > 0))
rig.bone("head", head0, hd, parent=stem[-1], connect=True)
weights = {f"Stem_{i}": [f"stem_{i}"] for i in range(N)}
weights.update({"Head": ["head"], "Pot": ["root"]})
for j, tip in enumerate(JAW):
    rig.bone(f"jaw_{j}", hd, tip, parent="head")
    weights[f"Jaw_{j}"] = [f"jaw_{j}"]
arm = rig.done()
body = k.join(parts, "PlantBody", (0.35, 0.5, 0.2))
k.bind_and_export(body, arm, out, "PLANT", weights)
