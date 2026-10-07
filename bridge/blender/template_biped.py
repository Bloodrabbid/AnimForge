# Шаблон «двуногий робот» в духе Biped: бочонок-корпус с головой, две ноги-палки со ступнями.
# Ноги — цепочки leg_l_*, leg_r_* сверху вниз; корпус — spine_* снизу вверх. Под рецепт compass-step.
# blender -b --python template_biped.py -- <out.glb>
import math, os, sys
sys.path.append(os.path.dirname(__file__))
import bodykit as k

out = sys.argv[sys.argv.index("--") + 1:][0]
k.reset()
HIP = 0.55  # высота таза
parts = [
    k.tube("Body", (0, 0, HIP), (0, 0, HIP + 0.55), lambda u: 0.26 * math.sin(math.pi * (0.12 + 0.76 * u)) ** 0.4, rings=30, seg=20),
    k.tube("Eye", (0, -0.2, HIP + 0.38), (0, -0.3, HIP + 0.38), lambda u: 0.07, rings=4, seg=12),
]
for tag, x in (("l", 0.13), ("r", -0.13)):
    parts.append(k.tube(f"Leg_{tag}", (x, 0, HIP + 0.05), (x, 0, 0.06), lambda u: 0.05, rings=20, seg=10))
    parts.append(k.tube(f"Foot_{tag}", (x, 0.04, 0.04), (x, -0.16, 0.04), lambda u: 0.06 * math.sin(math.pi * (0.1 + 0.8 * u)) ** 0.5, rings=8, seg=10, squash=(1.0, 0.6)))
body = k.join(parts, "BipedBody", (0.85, 0.55, 0.25))

rig = k.Rig("BipedRig")
rig.bone("root", (0, 0, 0), (0, 0, 0.2))
spine = rig.chain("spine", (0, 0, HIP), (0, 0, HIP + 0.55), 2, parent="root")
for tag, x in (("l", 0.13), ("r", -0.13)):
    rig.chain(f"leg_{tag}", (x, 0, HIP + 0.05), (x, 0, 0.06), 2, parent=spine[0])
    rig.bone(f"foot_{tag}", (x, 0, 0.06), (x, -0.16, 0.04), parent=f"leg_{tag}_1", connect=False)
k.bind_and_export(body, rig.done(), out, "BIPED")
