# Шаблон «призрак»: без ног, таз висит над землёй; корпус, голова, длинные руки; подол — четыре цепочки вниз (под jiggle).
# Смотрит на −Y Blender (= +Z glTF), как двуногие.
# blender -b --python template_ghost.py -- <out.glb>
import math, os, sys
sys.path.append(os.path.dirname(__file__))
import bodykit as k

out = sys.argv[sys.argv.index("--") + 1:][0]
k.reset()
P = 1.0  # высота таза
parts = [
    k.tube("Torso", (0, 0, P), (0, 0, P + 0.62), lambda u: 0.2 * (1 - 0.35 * u) + 0.04 * math.sin(math.pi * u), rings=20, seg=18),
    k.tube("Head", (0, 0, P + 0.66), (0, 0, P + 0.98), lambda u: 0.15 * math.sin(math.pi * (0.08 + 0.84 * u)) ** 0.6, rings=16, seg=16),
]
HEM = []
for j in range(4):
    a = math.radians(45 + 90 * j)
    top, bot = (0.16 * math.cos(a), 0.16 * math.sin(a), P + 0.05), (0.3 * math.cos(a), 0.3 * math.sin(a), P - 0.6)
    HEM.append((top, bot))
    parts.append(k.tube(f"Hem_{j}", top, bot, lambda u: 0.13 * (1 - 0.7 * u) + 0.01, rings=16, seg=10, squash=(1.0, 0.5)))
ARMS = {}
for tag, x in (("l", 1), ("r", -1)):
    sh, el, wr, tip = (0.2 * x, 0, P + 0.55), (0.38 * x, -0.05, P + 0.25), (0.48 * x, -0.12, P - 0.05), (0.55 * x, -0.16, P - 0.3)
    ARMS[tag] = (sh, el, wr, tip)
    for nm, a_, b_, r_ in (("Upper", sh, el, 0.05), ("Fore", el, wr, 0.04), ("Claw", wr, tip, 0.03)):
        parts.append(k.tube(f"{nm}_{tag}", a_, b_, lambda u, r_=r_: r_ * (1 - 0.4 * u), rings=10, seg=10))
rig = k.Rig("GhostRig")  # скелет — после деталей меша
rig.bone("root", (0, 0, 0), (0, 0, 0.2))
rig.bone("pelvis", (0, 0, P), (0, 0, P + 0.25), parent="root")
rig.bone("chest", (0, 0, P + 0.25), (0, 0, P + 0.62), parent="pelvis", connect=True)
rig.bone("head", (0, 0, P + 0.66), (0, 0, P + 0.98), parent="chest")
weights = {"Torso": ["pelvis", "chest"], "Head": ["head"]}
for j, (top, bot) in enumerate(HEM):
    rig.chain(f"hem_{j}", top, bot, 3, parent="pelvis")
    weights[f"Hem_{j}"] = [f"hem_{j}_"]
for tag in ("l", "r"):
    sh, el, wr, tip = ARMS[tag]
    rig.bone(f"arm_{tag}_0", sh, el, parent="chest")
    rig.bone(f"arm_{tag}_1", el, wr, parent=f"arm_{tag}_0", connect=True)
    rig.bone(f"hand_{tag}", wr, tip, parent=f"arm_{tag}_1", connect=True)
    weights.update({f"Upper_{tag}": [f"arm_{tag}_0"], f"Fore_{tag}": [f"arm_{tag}_1"], f"Claw_{tag}": [f"hand_{tag}"]})
arm = rig.done()
body = k.join(parts, "GhostBody", (0.62, 0.68, 0.72))
k.bind_and_export(body, arm, out, "GHOST", weights)
