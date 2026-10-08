# Шаблон «птица»: корпус, шея и голова с клювом, веерный хвост, две ноги (бедро, голень, цевка, палец),
# крылья из трёх костей (плечо, предплечье, кисть) с плоским опахалом. Смотрит на +X Blender. Крылья в rest расправлены.
# blender -b --python template_bird.py -- <out.glb>
import math, os, sys
sys.path.append(os.path.dirname(__file__))
import bodykit as k

out = sys.argv[sys.argv.index("--") + 1:][0]
k.reset()
H = 0.42  # высота корпуса
parts = [
    k.tube("Body", (-0.22, 0, H), (0.2, 0, H + 0.05), lambda u: 0.13 * math.sin(math.pi * (0.06 + 0.88 * u)) ** 0.6, rings=24, seg=18, squash=(0.9, 1.0)),
    k.tube("Neck", (0.16, 0, H + 0.06), (0.24, 0, H + 0.22), lambda u: 0.05 - 0.01 * u, rings=10, seg=12),
    k.tube("Head", (0.22, 0, H + 0.24), (0.34, 0, H + 0.26), lambda u: 0.06 * math.sin(math.pi * (0.1 + 0.8 * u)) ** 0.5, rings=10, seg=12),
    k.tube("Beak", (0.33, 0, H + 0.25), (0.43, 0, H + 0.23), lambda u: 0.022 * (1 - u) + 0.002, rings=6, seg=8),
    k.flat("Tail", [[(-0.2, -0.02, H + 0.02), (-0.2, 0.02, H + 0.02), (-0.45, 0.12, H + 0.06), (-0.48, 0, H + 0.06), (-0.45, -0.12, H + 0.06)]], 0.012),
]
WING = {}
LEG = {}
for tag, y in (("l", 1), ("r", -1)):
    # крыло: плечо → локоть → запястье → кончик; опахало — плоский многоугольник под костями
    sh, el, wr, tip = (0.08, 0.1 * y, H + 0.08), (0.02, 0.32 * y, H + 0.1), (0.05, 0.55 * y, H + 0.1), (-0.05, 0.85 * y, H + 0.1)
    WING[tag] = (sh, el, wr, tip)
    parts.append(k.tube(f"Arm_{tag}", sh, el, lambda u: 0.025, rings=8, seg=8))
    parts.append(k.tube(f"Fore_{tag}", el, wr, lambda u: 0.02, rings=8, seg=8))
    parts.append(k.tube(f"Hand_{tag}", wr, tip, lambda u: 0.016 * (1 - u) + 0.004, rings=8, seg=8))
    parts.append(k.flat(f"Vane1_{tag}", [[sh, el, (el[0] - 0.16, el[1], el[2]), (sh[0] - 0.18, sh[1], sh[2])]], 0.01))
    parts.append(k.flat(f"Vane2_{tag}", [[el, wr, (wr[0] - 0.2, wr[1], wr[2]), (el[0] - 0.16, el[1], el[2])]], 0.01))
    parts.append(k.flat(f"Vane3_{tag}", [[wr, tip, (tip[0] - 0.12, tip[1] - 0.02 * y, tip[2]), (wr[0] - 0.2, wr[1], wr[2])]], 0.01))
    # нога: бедро вперёд-вниз, голень назад-вниз, цевка вниз, палец вперёд
    LEG[tag] = pts = [(-0.02, 0.06 * y, H - 0.06), (0.05, 0.07 * y, H - 0.2), (-0.03, 0.07 * y, H - 0.32), (-0.01, 0.07 * y, 0.03), (0.08, 0.07 * y, 0.0)]
    for nm, a_, b_, r_ in zip(("Thigh", "Shin", "Tarsus", "Toe"), pts, pts[1:], (0.035, 0.022, 0.014, 0.012)):
        parts.append(k.tube(f"{nm}_{tag}", a_, b_, lambda u, r_=r_: r_, rings=8, seg=8))

rig = k.Rig("BirdRig")  # скелет — после всех деталей: k.flat переключает активный объект и сбил бы режим правки костей
rig.bone("pelvis", (-0.05, 0, H), (-0.22, 0, H + 0.02))
rig.bone("chest", (-0.05, 0, H), (0.18, 0, H + 0.05), parent="pelvis")
rig.chain("neck", (0.18, 0, H + 0.06), (0.24, 0, H + 0.23), 2, parent="chest")
rig.bone("head", (0.24, 0, H + 0.23), (0.43, 0, H + 0.24), parent="neck_1", connect=True)
rig.chain("tail", (-0.2, 0, H + 0.02), (-0.47, 0, H + 0.06), 2, parent="pelvis")
weights = {"Body": ["pelvis", "chest"], "Neck": ["neck_"], "Head": ["head"], "Beak": ["head"], "Tail": ["tail_"]}
for tag in ("l", "r"):
    sh, el, wr, tip = WING[tag]
    rig.bone(f"wing_{tag}_0", sh, el, parent="chest")
    rig.bone(f"wing_{tag}_1", el, wr, parent=f"wing_{tag}_0", connect=True)
    rig.bone(f"wing_{tag}_2", wr, tip, parent=f"wing_{tag}_1", connect=True)
    weights.update({f"Arm_{tag}": [f"wing_{tag}_0"], f"Fore_{tag}": [f"wing_{tag}_1"], f"Hand_{tag}": [f"wing_{tag}_2"],
                    f"Vane1_{tag}": [f"wing_{tag}_0"], f"Vane2_{tag}": [f"wing_{tag}_1"], f"Vane3_{tag}": [f"wing_{tag}_2"]})
    pts = LEG[tag]
    for j in range(4):
        rig.bone(f"leg_{tag}_{j}", pts[j], pts[j + 1], parent="pelvis" if j == 0 else f"leg_{tag}_{j - 1}", connect=j > 0)
    for nm in ("Thigh", "Shin", "Tarsus", "Toe"):
        weights[f"{nm}_{tag}"] = [f"leg_{tag}_"]
arm = rig.done()
body = k.join(parts, "BirdBody", (0.35, 0.33, 0.38))
k.bind_and_export(body, arm, out, "BIRD", weights)
