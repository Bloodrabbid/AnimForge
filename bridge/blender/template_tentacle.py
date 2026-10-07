# Шаблон «щупальце»: конус, растущий вверх из основания, с кольцами-присосками по одной стороне.
# blender -b --python template_tentacle.py -- <out.glb> [костей=10] [высота=3]
import math, os, sys
sys.path.append(os.path.dirname(__file__))
import bodykit as k

a = sys.argv[sys.argv.index("--") + 1:]
out, n, H = a[0], int(a[1]) if len(a) > 1 else 10, float(a[2]) if len(a) > 2 else 3.0
k.reset()


def r(u):
    return max(0.015, 0.28 * (1 - u) ** 0.9 * (1 + 0.04 * math.sin(u * 60)))  # лёгкая «кольчатость»


body = k.join([k.tube("Tentacle", (0, 0, 0), (0, 0, H), r, rings=90, seg=18)], "TentacleBody", (0.55, 0.25, 0.35))
rig = k.Rig("TentacleRig")
rig.bone("root", (0, 0, -0.1), (0, 0, 0))
rig.chain("seg", (0, 0, 0), (0, 0, H), n, parent="root")
k.bind_and_export(body, rig.done(), out, "TENTACLE")
