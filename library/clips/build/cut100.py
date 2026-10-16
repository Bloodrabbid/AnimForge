# 100STYLE: из каждой записи (стиль × вид движения) — один кусок без повторов: прямой ход, поза в конце = поза в
# начале (цикл без шва). Переходы (TR) — 12 с с наибольшим разбросом скорости (шаг ↔ бег). Пишет укороченные BVH.
import csv, os, sys, numpy as np
R = "out/ccby/100STYLE"; OUT = "out/ccby/style100"; FPS = 60
cuts = {r["STYLE_NAME"]: r for r in csv.DictReader(open(f"{R}/Frame_Cuts.csv"))}
WIN = {"FW": (150, 300), "BW": (150, 300), "SW": (150, 300), "FR": (100, 240), "BR": (100, 240), "SR": (100, 240), "ID": (240, 360)}

def load(f):
    L = open(f).read().split("\n"); i = L.index("MOTION")
    rows = [l for l in L[i + 3:] if l.strip()]
    return L[:i], L[i + 2], rows, np.array([list(map(float, l.split())) for l in rows])

def pick(M, a, b, typ, lo, hi):
    rot = M[:, 6:]  # без корня: поза тела
    best = (1e9, a, a + lo)
    for s in range(a, max(a + 1, b - hi), 10):
        e = np.arange(s + lo, min(s + hi, b - 3))
        if not len(e): continue
        d = lambda x, y: np.abs((rot[x] - rot[y] + 180) % 360 - 180).mean(axis=-1)
        c = d(s, e) + d(s + 2, e + 2)
        if typ != "ID":
            q = M[s:e[-1] + 1, [0, 2]] - M[s, [0, 2]]          # путь корня от начала окна
            ch = q[e - s]; L = np.linalg.norm(ch, axis=1)       # хорда до каждого конца
            u = ch / np.maximum(L, 1e-6)[:, None]
            X = np.abs(u[:, :1] * q[None, :, 1] - u[:, 1:] * q[None, :, 0])  # отход от хорды, [конец, кадр]
            X[np.arange(len(q))[None, :] > (e - s)[:, None]] = 0
            c = c + 40 * X.max(axis=1) / np.maximum(L, 1e-6) + 99 * (L < 30)  # кривой путь; стоит на месте — не ход
        k = int(np.argmin(c))
        if c[k] < best[0]: best = (float(c[k]), s, int(e[k]))
    return best

def transition(M, a, b, n=12 * FPS):
    v = np.linalg.norm(np.diff(M[:, [0, 2]], axis=0), axis=1) * FPS
    best = (-1, a)
    for s in range(a, max(a + 1, b - n), 30):
        sd = v[s:s + n].std()
        if sd > best[0]: best = (sd, s)
    return best[1], min(b, best[1] + n)

log = open(f"{OUT}/cuts.tsv", "w")
for style in sorted(cuts):
    for typ in ["FW", "BW", "SW", "FR", "BR", "SR", "ID", "TR1", "TR2", "TR3"]:
        f = f"{R}/{style}/{style}_{typ}.bvh"
        a, b = cuts[style].get(f"{typ}_START"), cuts[style].get(f"{typ}_STOP")
        if not os.path.exists(f) or a in (None, "N/A"): continue
        head, ftime, rows, M = load(f)
        a, b = int(a), min(int(b), len(rows) - 1)
        if typ.startswith("TR"): s, e = transition(M, a, b); cost = 0
        else: cost, s, e = pick(M, a, b, typ, *WIN[typ])
        # лицом вперёд (+Z — так смотрит поза покоя): поворот корня вокруг Y — первый в порядке Y X Z, его угол просто
        # сдвигается; путь — поворачивается вокруг начала отрезка. Направление: у хода — по пути, вбок — путь ±90°
        # ближе к тазу, у стойки и переходов — средний поворот таза
        S = M[s:e].copy()
        ya = np.radians(S[:, 3]); hips = np.arctan2(np.sin(ya).mean(), np.cos(ya).mean())
        ch = S[-1, [0, 2]] - S[0, [0, 2]]; path = np.arctan2(ch[0], ch[1])
        wrap = lambda x: (x + np.pi) % (2 * np.pi) - np.pi
        if typ in ("FW", "FR"): yaw = path
        elif typ in ("BW", "BR"): yaw = wrap(path + np.pi)
        elif typ in ("SW", "SR"): yaw = min((wrap(path + d) for d in (np.pi / 2, -np.pi / 2)), key=lambda y: abs(wrap(y - hips)))
        else: yaw = hips
        c, sn = np.cos(-yaw), np.sin(-yaw)
        x, z = S[:, 0] - S[0, 0], S[:, 2] - S[0, 2]
        S[:, 0], S[:, 2] = c * x + sn * z, -sn * x + c * z
        S[:, 3] = S[:, 3] - np.degrees(yaw)
        with open(f"{OUT}/{style}_{typ}.bvh", "w") as o:
            o.write("\n".join(head + ["MOTION", f"Frames: {e - s}", ftime] + [" ".join(f"{v:.5g}" for v in r) for r in S]) + "\n")
        log.write(f"{style}\t{typ}\t{s}\t{e}\t{(e - s) / FPS:.2f}\t{cost:.2f}\t{np.degrees(yaw):.1f}\n"); log.flush()
    print(style, flush=True)
