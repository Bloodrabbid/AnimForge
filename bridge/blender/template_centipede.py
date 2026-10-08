# Шаблон «сколопендра»: длинное тело из сегментов (цепочка seg_*), на каждом пара коротких ног, голова с усиками.
# blender -b --python template_centipede.py -- <out.glb> [число сегментов, по умолчанию 10]
import math, os, sys
sys.path.append(os.path.dirname(__file__))
import bodykit as k
from multileg import leg

a = sys.argv[sys.argv.index("--") + 1:]
out, N = a[0], int(a[1]) if len(a) > 1 else 10
k.reset()
H, L = 0.12, 1.6
x0 = L / 2
step = L / N
parts = [k.tube("Body", (-x0, 0, H), (x0, 0, H), lambda u: 0.055 * (0.75 + 0.25 * math.sin(math.pi * u)), rings=N * 6, seg=14, squash=(1.0, 0.6)),
         k.tube("Head", (x0, 0, H), (x0 + 0.12, 0, H - 0.01), lambda u: 0.06 * math.sin(math.pi * (0.15 + 0.7 * u)) ** 0.5, rings=10, seg=14, squash=(1.0, 0.6))]
rig = k.Rig("CentipedeRig")
# сегменты от хвоста к голове: корень — хвостовой сегмент, как у змеи; голова — дочь переднего
segs = rig.chain("seg", (-x0, 0, H), (x0, 0, H), N)
rig.bone("head", (x0, 0, H), (x0 + 0.12, 0, H - 0.01), parent=segs[-1], connect=True)
weights = {"Body": ["seg_"], "Head": ["head", "antenna_"]}
for tag, y in (("l", 1), ("r", -1)):
    a0, a1 = (x0 + 0.1, 0.02 * y, H + 0.02), (x0 + 0.3, 0.12 * y, H + 0.08)
    parts.append(k.tube(f"Antenna_{tag}", a0, a1, lambda u: 0.006, rings=8, seg=6))
    rig.chain(f"antenna_{tag}", a0, a1, 2, parent="head")
    weights[f"Antenna_{tag}"] = [f"antenna_{tag}_"]
    for i in range(N):
        x = -x0 + step * (i + 0.5)
        # i = 0 — у хвоста; ноги нумеруем от головы: передняя пара — 0
        leg(parts, rig, weights, f"{tag}{N - 1 - i}", (x, 0.045 * y, H - 0.01), (0.25, 1.0 * y), 0.2, 0.06, segs[i], thick=0.014)
arm = rig.done()  # кости готовы до склейки меша: join работает в объектном режиме
body = k.join(parts, "CentipedeBody", (0.55, 0.25, 0.12))
k.bind_and_export(body, arm, out, "CENTIPEDE", weights)
