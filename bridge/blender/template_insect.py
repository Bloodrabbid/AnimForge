# Шаблон «насекомое»: голова, грудь, брюшко; три пары ног на груди (передние вперёд, задние назад), усики.
# blender -b --python template_insect.py -- <out.glb>
import math, os, sys
sys.path.append(os.path.dirname(__file__))
import bodykit as k
from multileg import leg

out = sys.argv[sys.argv.index("--") + 1:][0]
k.reset()
H = 0.22
parts = [
    k.tube("Head", (0.32, 0, H + 0.03), (0.48, 0, H + 0.02), lambda u: 0.07 * math.sin(math.pi * (0.1 + 0.8 * u)) ** 0.5, rings=12, seg=14),
    k.tube("Thorax", (0.05, 0, H), (0.33, 0, H + 0.02), lambda u: 0.085 * math.sin(math.pi * (0.1 + 0.8 * u)) ** 0.5, rings=16, seg=16),
    k.tube("Abdomen", (0.06, 0, H + 0.01), (-0.45, 0, H + 0.06), lambda u: 0.13 * math.sin(math.pi * (0.08 + 0.84 * u)) ** 0.7, rings=24, seg=18, squash=(1.0, 0.8)),
]
rig = k.Rig("InsectRig")
rig.bone("thorax", (0.05, 0, H), (0.33, 0, H + 0.02))
rig.bone("head", (0.33, 0, H + 0.02), (0.48, 0, H + 0.02), parent="thorax", connect=True)
abd = rig.chain("abdomen", (0.05, 0, H + 0.01), (-0.45, 0, H + 0.06), 3, parent="thorax")
weights = {"Head": ["head", "antenna_"], "Thorax": ["thorax"], "Abdomen": ["abdomen_"]}
for tag, y in (("l", 1), ("r", -1)):
    a0, a1 = (0.46, 0.03 * y, H + 0.06), (0.62, 0.14 * y, H + 0.18)
    parts.append(k.tube(f"Antenna_{tag}", a0, a1, lambda u: 0.008, rings=10, seg=6))
    rig.chain(f"antenna_{tag}", a0, a1, 2, parent="head")
    weights[f"Antenna_{tag}"] = [f"antenna_{tag}_"]
    # три пары: передняя смотрит вперёд, средняя вбок, задняя назад
    for i, (x, ang) in enumerate(((0.28, 40), (0.19, 90), (0.10, 140))):
        a = math.radians(ang)
        leg(parts, rig, weights, f"{tag}{i}", (x, 0.06 * y, H - 0.02), (math.cos(a), math.sin(a) * y), 0.34, 0.12, "thorax")
arm = rig.done()  # кости готовы до склейки меша: join работает в объектном режиме
body = k.join(parts, "InsectBody", (0.25, 0.32, 0.18))
k.bind_and_export(body, arm, out, "INSECT", weights)
