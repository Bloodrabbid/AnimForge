# Шаблон «рабочий» в духе Tools Up!: короткие ноги, бочонок-тело, крупная голова, глаза на своих костях (для моргания
# масштабом), висячие уши-цепочки (для покачивания), руки. Смотрит на −Y Blender (= +Z glTF).
# blender -b --python template_worker.py -- <out.glb>
import math, os, sys
sys.path.append(os.path.dirname(__file__))
import bodykit as k

out = sys.argv[sys.argv.index("--") + 1:][0]
k.reset()
HIP = 0.45                     # высота таза (у Tools Up! 0.475)
CH = HIP + 0.38                # грудь
HEAD = CH + 0.12               # основание головы
bulge = lambda r0, p=0.5: (lambda u: r0 * math.sin(math.pi * (0.08 + 0.84 * u)) ** p)
parts = [
    k.tube("Body", (0, 0, HIP - 0.08), (0, 0, CH + 0.1), bulge(0.24, 0.45), rings=26, seg=20),
    k.tube("Head", (0, 0, HEAD), (0, 0, HEAD + 0.5), bulge(0.27, 0.55), rings=26, seg=22),
]
for tag, x in (("l", 1), ("r", -1)):
    parts.append(k.tube(f"Eye_{tag}", (0.09 * x, -0.2, HEAD + 0.26), (0.09 * x, -0.29, HEAD + 0.26), lambda u: 0.06, rings=6, seg=14))
    parts.append(k.tube(f"Ear_{tag}", (0.24 * x, 0, HEAD + 0.32), (0.42 * x, 0, HEAD + 0.12), lambda u: 0.07 * (1 - 0.6 * u), rings=16, seg=10, squash=(1.0, 0.45)))
    parts.append(k.tube(f"Arm_{tag}", (0.22 * x, 0, CH), (0.3 * x, 0, CH - 0.42), lambda u: 0.055, rings=20, seg=10))
    parts.append(k.tube(f"Leg_{tag}", (0.11 * x, 0, HIP), (0.11 * x, 0, 0.05), lambda u: 0.07 - 0.015 * u, rings=20, seg=10))
    parts.append(k.tube(f"Foot_{tag}", (0.11 * x, 0.05, 0.045), (0.11 * x, -0.15, 0.045), lambda u: 0.07 * math.sin(math.pi * (0.1 + 0.8 * u)) ** 0.5, rings=8, seg=10, squash=(1.0, 0.6)))
body = k.join(parts, "WorkerBody", (0.95, 0.62, 0.2))

rig = k.Rig("WorkerRig")
rig.bone("root", (0, 0, 0), (0, 0, 0.15))
rig.bone("pelvis", (0, 0, HIP), (0, 0, HIP + 0.19), parent="root")
rig.bone("chest", (0, 0, HIP + 0.19), (0, 0, HEAD), parent="pelvis", connect=True)
rig.bone("head", (0, 0, HEAD), (0, 0, HEAD + 0.5), parent="chest", connect=True)
for tag, x in (("l", 1), ("r", -1)):
    rig.bone(f"eye_{tag}", (0.09 * x, -0.24, HEAD + 0.26), (0.09 * x, -0.34, HEAD + 0.26), parent="head")
    rig.chain(f"ear_{tag}", (0.22 * x, 0, HEAD + 0.33), (0.43 * x, 0, HEAD + 0.11), 2, parent="head")
    rig.chain(f"arm_{tag}", (0.22 * x, 0, CH), (0.3 * x, 0, CH - 0.42), 2, parent="chest")
    rig.chain(f"leg_{tag}", (0.11 * x, 0, HIP), (0.11 * x, 0, 0.05), 2, parent="pelvis")
    rig.bone(f"foot_{tag}", (0.11 * x, 0, 0.05), (0.11 * x, -0.15, 0.045), parent=f"leg_{tag}_1", connect=True)
k.bind_and_export(body, rig.done(), out, "WORKER")
