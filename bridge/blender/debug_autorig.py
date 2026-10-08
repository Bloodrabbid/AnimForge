# Картинка для отладки авторига: три проекции вокселей (серым) и кости (линии, корень — красный).
# python3 bridge/blender/debug_autorig.py out.glb → out.glb.debug.svg (форму и скелет пишет autorig.py при AUTORIG_DEBUG=1)
import json, sys
import numpy as np

base = sys.argv[1]
occ = np.load(base + ".occ.npy")
sk = json.load(open(base + ".skel.json"))
J = (np.array(sk["joints"]) - np.array(sk["origin"])) / sk["voxel"]
S = 4
views = [("спереди (X–Z)", 0, 2, 1), ("сбоку (Y–Z)", 1, 2, 0), ("сверху (X–Y)", 0, 1, 2)]
parts, x0 = [], 0
for title, a, b, c in views:
    proj = occ.any(axis=c)
    if a > b:
        proj = proj.T
    w, h = occ.shape[a], occ.shape[b]
    rects = "".join(f'<rect x="{x0 + i * S}" y="{(h - 1 - j) * S + 20}" width="{S}" height="{S}" fill="#555"/>' for i, j in zip(*np.nonzero(proj if a < b else proj.T)))
    lines = "".join(
        f'<line x1="{x0 + J[p][a] * S + S / 2:.1f}" y1="{(h - 1 - J[p][b]) * S + 20 + S / 2:.1f}" x2="{x0 + J[i][a] * S + S / 2:.1f}" y2="{(h - 1 - J[i][b]) * S + 20 + S / 2:.1f}" stroke="#ffb547" stroke-width="2"/>'
        for i, p in enumerate(sk["parents"]) if p >= 0)
    dots = "".join(f'<circle cx="{x0 + j[a] * S + S / 2:.1f}" cy="{(h - 1 - j[b]) * S + 20 + S / 2:.1f}" r="{4 if k == 0 else 2.2}" fill="{"#ff4d4d" if k == 0 else "#7fb0ff"}"/>' for k, j in enumerate(J))
    parts.append(f'<text x="{x0}" y="14" fill="#ddd" font-size="13" font-family="Arial">{title}</text>{rects}{lines}{dots}')
    x0 += w * S + 20
H = max(occ.shape) * S + 30
open(base + ".debug.svg", "w").write(f'<svg xmlns="http://www.w3.org/2000/svg" width="{x0}" height="{H}"><rect width="100%" height="100%" fill="#1a1a1e"/>{"".join(parts)}</svg>')
print(base + ".debug.svg", sk["info"])
