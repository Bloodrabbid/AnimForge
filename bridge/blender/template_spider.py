# Шаблон «паук»: головогрудь и брюшко, четыре пары длинных ног веером, «колени» выше тела.
# blender -b --python template_spider.py -- <out.glb>
import math, os, sys
sys.path.append(os.path.dirname(__file__))
import bodykit as k
from multileg import leg

out = sys.argv[sys.argv.index("--") + 1:][0]
k.reset()
H = 0.25
parts = [
    k.tube("Cephalo", (-0.02, 0, H), (0.22, 0, H + 0.01), lambda u: 0.1 * math.sin(math.pi * (0.1 + 0.8 * u)) ** 0.5, rings=16, seg=16, squash=(1.0, 0.75)),
    k.tube("Abdomen", (-0.02, 0, H + 0.02), (-0.42, 0, H + 0.08), lambda u: 0.16 * math.sin(math.pi * (0.06 + 0.88 * u)) ** 0.6, rings=24, seg=18),
]
rig = k.Rig("SpiderRig")
rig.bone("cephalothorax", (-0.02, 0, H), (0.22, 0, H + 0.01))
rig.bone("head", (0.22, 0, H + 0.01), (0.28, 0, H + 0.01), parent="cephalothorax", connect=True)
rig.chain("abdomen", (-0.02, 0, H + 0.02), (-0.42, 0, H + 0.08), 2, parent="cephalothorax")
weights = {"Cephalo": ["cephalothorax", "head"], "Abdomen": ["abdomen_"]}
for tag, y in (("l", 1), ("r", -1)):
    for i, (x, ang) in enumerate(((0.18, 35), (0.12, 70), (0.06, 110), (0.0, 145))):
        a = math.radians(ang)
        leg(parts, rig, weights, f"{tag}{i}", (x, 0.07 * y, H), (math.cos(a), math.sin(a) * y), 0.62, 0.2, "cephalothorax", thick=0.022)
arm = rig.done()  # кости готовы до склейки меша: join работает в объектном режиме
body = k.join(parts, "SpiderBody", (0.22, 0.2, 0.2))
k.bind_and_export(body, arm, out, "SPIDER", weights)
