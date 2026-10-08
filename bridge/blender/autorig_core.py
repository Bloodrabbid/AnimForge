# Авториг без Blender: по воксельной форме тела строит дерево суставов (только numpy).
# Идея — граф уровней (Reeb): от самой толстой точки тела считаем расстояние «по телу», режем тело на слои
# этого расстояния; связная часть слоя — узел, соседние слои — рёбра. Лапы, хвост, шея, щупальца отходят от тела
# отдельными частями слоя, поэтому развилки получаются сами, без знания, что это за существо.
# Дальше дерево чистим от коротких отростков (уши, пальцы, шум вокселизации) и нарезаем на кости равной длины.
from collections import deque
import numpy as np

N6 = [(1, 0, 0), (-1, 0, 0), (0, 1, 0), (0, -1, 0), (0, 0, 1), (0, 0, -1)]
N26 = [(a, b, c) for a in (-1, 0, 1) for b in (-1, 0, 1) for c in (-1, 0, 1) if (a, b, c) != (0, 0, 0)]


def _bfs(occ, seeds, nbrs):
    """Расстояние в шагах по занятым вокселям от набора семян; −1 — недостижимо."""
    dist = np.full(occ.shape, -1, dtype=np.int32)
    q = deque()
    for s in seeds:
        dist[s] = 0
        q.append(s)
    X, Y, Z = occ.shape
    while q:
        x, y, z = q.popleft()
        d = dist[x, y, z] + 1
        for dx, dy, dz in nbrs:
            a, b, c = x + dx, y + dy, z + dz
            if 0 <= a < X and 0 <= b < Y and 0 <= c < Z and occ[a, b, c] and dist[a, b, c] < 0:
                dist[a, b, c] = d
                q.append((a, b, c))
    return dist


def largest_component(occ):
    """Самый большой связный кусок (26-соседство): мусор вокселизации и отдельные пылинки отбрасываем."""
    label = np.zeros(occ.shape, dtype=np.int32)
    best, best_n, k = 0, 0, 0
    for idx in zip(*np.nonzero(occ)):
        if label[idx]:
            continue
        k += 1
        label[idx] = k
        q, n = deque([idx]), 0
        while q:
            x, y, z = q.popleft()
            n += 1
            for dx, dy, dz in N26:
                a, b, c = x + dx, y + dy, z + dz
                if 0 <= a < occ.shape[0] and 0 <= b < occ.shape[1] and 0 <= c < occ.shape[2] and occ[a, b, c] and not label[a, b, c]:
                    label[a, b, c] = k
                    q.append((a, b, c))
        if n > best_n:
            best, best_n = k, n
    return label == best


def surface_distance(occ):
    """Толщина: шагов до ближайшего пустого вокселя (граница сетки — тоже пусто)."""
    pad = np.pad(occ, 1)
    inner = pad[1:-1, 1:-1, 1:-1]
    edge = np.zeros_like(inner)
    for dx, dy, dz in N6:
        edge |= inner & ~pad[1 + dx:pad.shape[0] - 1 + dx, 1 + dy:pad.shape[1] - 1 + dy, 1 + dz:pad.shape[2] - 1 + dz]
    return _bfs(occ, list(zip(*np.nonzero(edge))), N6)


def skeleton(occ, voxel=1.0, origin=(0.0, 0.0, 0.0), up=2, bones_along=10, min_branch=0.12):
    """Дерево суставов по воксельной форме.
    occ — bool[X,Y,Z]; voxel — размер вокселя; origin — мировые координаты центра вокселя (0,0,0); up — индекс оси «вверх».
    bones_along — сколько костей укладывается вдоль самого длинного размера тела.
    min_branch — отросток короче этой доли длины тела убираем.
    Возвращает (joints [(x,y,z)], parents [int, −1 у корня], info)."""
    occ = largest_component(np.asarray(occ, dtype=bool))
    if occ.sum() < 8:
        raise ValueError("слишком мало вокселей — модель пустая или слишком тонкая")
    thick = surface_distance(occ)
    # корень — самое толстое место (грудь, брюхо, панцирь); при равенстве — ближе к центру масс
    pts = np.argwhere(occ)
    com = pts.mean(0)
    tmax = thick.max()
    cand = np.argwhere(thick >= tmax)
    root = tuple(cand[np.argmin(((cand - com) ** 2).sum(1))])
    geo = _bfs(occ, [root], N26)
    extent = (pts.max(0) - pts.min(0)).max() + 1
    step = max(1, int(round(extent / 48)))  # толщина слоя в вокселях
    level = np.where(occ, geo // step, -1)
    # узлы: связные части каждого слоя
    comp = np.full(occ.shape, -1, dtype=np.int32)
    nodes = []  # dict(level, cells)
    for idx in map(tuple, pts):
        if comp[idx] >= 0:
            continue
        lv = level[idx]
        cid = len(nodes)
        comp[idx] = cid
        q, cells = deque([idx]), []
        while q:
            x, y, z = q.popleft()
            cells.append((x, y, z))
            for dx, dy, dz in N26:
                a, b, c = x + dx, y + dy, z + dz
                if 0 <= a < occ.shape[0] and 0 <= b < occ.shape[1] and 0 <= c < occ.shape[2] and level[a, b, c] == lv and comp[a, b, c] < 0:
                    comp[a, b, c] = cid
                    q.append((a, b, c))
        nodes.append({"level": int(lv), "cells": np.array(cells)})
    # рёбра — к соседнему слою ниже (к корню); родитель — с кем больше касаний
    contact = {}
    for x, y, z in map(tuple, pts):
        a_id = comp[x, y, z]
        for dx, dy, dz in N26:
            a, b, c = x + dx, y + dy, z + dz
            if 0 <= a < occ.shape[0] and 0 <= b < occ.shape[1] and 0 <= c < occ.shape[2] and occ[a, b, c]:
                b_id = comp[a, b, c]
                if nodes[b_id]["level"] == nodes[a_id]["level"] - 1:
                    contact[(a_id, b_id)] = contact.get((a_id, b_id), 0) + 1
    parent = [-1] * len(nodes)
    best = {}
    for (a, b), n in contact.items():
        if n > best.get(a, (0, -1))[0]:
            best[a] = (n, b)
    for a, (_, b) in best.items():
        parent[a] = b
    root_node = comp[root]
    centroid = [n["cells"].mean(0) for n in nodes]
    children = [[] for _ in nodes]
    for i, p in enumerate(parent):
        if p >= 0:
            children[p].append(i)

    # длина ветки до самого дальнего листа (в вокселях) — для чистки коротких отростков
    order = sorted(range(len(nodes)), key=lambda i: -nodes[i]["level"])
    reach = [0.0] * len(nodes)
    for i in order:
        for c in children[i]:
            reach[i] = max(reach[i], reach[c] + float(np.linalg.norm(centroid[c] - centroid[i])))
    min_len = min_branch * extent
    # толщина тела у узла: отросток меряем от поверхности, а не от оси (бугорок над корнем — не ветка)
    radius = [float(thick[tuple(n["cells"].T)].max()) for n in nodes]

    def keep(i):
        p = parent[i]
        edge = float(np.linalg.norm(centroid[i] - centroid[p])) if p >= 0 else 0
        return reach[i] + edge - (radius[p] if p >= 0 else 0) >= min_len

    # проход от корня: у развилки оставляем ветки длиннее порога (самую длинную — всегда)
    alive = [False] * len(nodes)
    stack = [root_node]
    alive[root_node] = True
    while stack:
        i = stack.pop()
        kids = sorted(children[i], key=lambda c: -reach[c])
        for k, c in enumerate(kids):
            if (k == 0 and i != root_node) or keep(c):
                alive[c] = True
                stack.append(c)
    # сжимаем в ветки: путь от узла-развилки (или корня) до следующей развилки или листа
    kids_alive = [[c for c in children[i] if alive[c]] for i in range(len(nodes))]
    seg = extent / max(2, bones_along)
    to_world = lambda v: tuple(float(origin[k] + v[k] * voxel) for k in range(3))
    joints, parents = [to_world(centroid[root_node])], [-1]

    def emit(start, parent_joint):
        # идём по цепочке, пока одна дочь
        path = [start]
        i = start
        while len(kids_alive[i]) == 1:
            i = kids_alive[i][0]
            path.append(i)
        poly = np.array([centroid[parent_of_path[start]]] + [centroid[p] for p in path])
        d = np.concatenate([[0], np.cumsum(np.linalg.norm(np.diff(poly, axis=0), axis=1))])
        L = d[-1]
        last = parent_joint
        if L < 0.35 * seg:
            # слишком короткий отрезок до развилки — сустав не ставим, дети растут из родительского
            for c in kids_alive[i]:
                parent_of_path[c] = i
                emit(c, last)
            return
        m = max(1, int(round(L / seg)))
        for k in range(1, m + 1):
            t = L * k / m
            j = np.searchsorted(d, t)
            j = min(max(j, 1), len(d) - 1)
            f = (t - d[j - 1]) / max(d[j] - d[j - 1], 1e-9)
            p = poly[j - 1] + (poly[j] - poly[j - 1]) * f
            joints.append(to_world(p))
            parents.append(last)
            last = len(joints) - 1
        for c in kids_alive[i]:
            parent_of_path[c] = i
            emit(c, last)

    parent_of_path = {}
    for c in kids_alive[root_node]:
        parent_of_path[c] = root_node
        emit(c, 0)
    joints, parents = reroot(joints, parents, up, extent * voxel)
    info = {"voxels": int(occ.sum()), "levels": int(level.max()) + 1, "nodes": len(nodes), "root_thickness": int(tmax), "branches": sum(1 for k in kids_alive if len(k) == 0)}
    return joints, parents, info


def reroot(joints, parents, up=2, extent=1.0, major=0.25):
    """Корень — самая нижняя «большая» развилка: где сходятся хотя бы три ветки длиннее major·длины тела.
    У двуногого и птицы это таз (ноги + позвоночник), у паука — центр тела; пальцы и уши в счёт не идут.
    Так иерархия совпадает с привычной движкам и Mixamo (таз — предок всего), и rig.detect находит ноги и руки."""
    n = len(joints)
    P = np.array(joints, dtype=float)
    adj = [[] for _ in range(n)]
    for i, p in enumerate(parents):
        if p >= 0:
            adj[i].append(p)
            adj[p].append(i)

    def far(start, banned):
        # самый дальний путь от start, не заходя в banned
        best, stack = 0.0, [(start, banned, 0.0)]
        while stack:
            v, prev, d = stack.pop()
            best = max(best, d)
            for w in adj[v]:
                if w != prev:
                    stack.append((w, v, d + float(np.linalg.norm(P[w] - P[v]))))
        return best

    cand = []
    for j in range(n):
        if len(adj[j]) < 3:
            continue
        long = sum(1 for w in adj[j] if far(w, j) + float(np.linalg.norm(P[w] - P[j])) >= major * extent)
        if long >= 3:
            cand.append(j)
    com = P.mean(0)
    if cand:
        r = min(cand, key=lambda j: (round(P[j][up] / (0.05 * extent)), float(np.linalg.norm(P[j] - com))))
    else:
        # тело-линия (рыба, змея, червь, щупальце): нигде не сходятся три длинные ветки — корень в конец тела,
        # тогда всё тело — одна цепочка для волны. Конец — тот, что ближе к центру масс (у рыбы — голова)
        def farthest(s0):
            dist, stack, best = {s0: 0.0}, [s0], s0
            while stack:
                v = stack.pop()
                for w in adj[v]:
                    if w not in dist:
                        dist[w] = dist[v] + float(np.linalg.norm(P[w] - P[v]))
                        stack.append(w)
                        if dist[w] > dist[best]:
                            best = w
            return best
        a = farthest(0)
        b = farthest(a)
        r = min((a, b), key=lambda j: float(np.linalg.norm(P[j] - com)))
    # обход от нового корня: родители — по дереву, номера — в порядке обхода (корень 0, родитель раньше ребёнка)
    order, par, seen = [], {r: -1}, {r}
    q = deque([r])
    while q:
        v = q.popleft()
        order.append(v)
        for w in adj[v]:
            if w not in seen:
                seen.add(w)
                par[w] = v
                q.append(w)
    idx = {v: k for k, v in enumerate(order)}
    return [joints[v] for v in order], [idx[par[v]] if par[v] >= 0 else -1 for v in order]


def refine_tips(joints, parents, sample, min_fingers=4, max_fingers=6, log=None, fine=48, up=2):
    """Пальцы: на 128 вокселей пальцы кисти сливаются в лопату, и ветка руки кончается одним суставом.
    У каждого кончика ветки форму рядом с ним вокселим мельче (sample — колбэк, Blender или тест) и строим
    скелет заново; если за ладонью расходятся 4–6 отростков, кончик заменяем запястьем-ладонью-пальцами.
    Уши, рога, морда дают меньше отростков, лапа без отдельных пальцев — ни одного: там всё как было.
    sample(center, half, voxel) → (occ, origin): воксели тела в кубе center ± half.
    Возвращает (joints, parents, сколько кончиков заменено)."""
    J = [np.array(j, dtype=float) for j in joints]
    kids = [[] for _ in J]
    for i, p in enumerate(parents):
        if p >= 0:
            kids[p].append(i)
    new_j, new_p = [tuple(map(float, j)) for j in J], list(parents)
    removed, hands = set(), 0
    # кисти — не у самых нижних кончиков (ступни, лапы) и не у самого верхнего (голова): там отростки
    # на мелкой сетке — детали обуви и черепа, а не пальцы
    leaves = [i for i in range(len(J)) if not kids[i] and parents[i] >= 0]
    hz = np.array([J[i][up] for i in range(len(J))])
    low = hz.min() + 0.15 * (hz.max() - hz.min())
    top = max(leaves, key=lambda i: hz[i]) if leaves else -1
    for L in leaves:
        P = parents[L]
        if hz[L] < low or L == top:
            continue
        PL = float(np.linalg.norm(J[L] - J[P]))
        if PL < 1e-9:
            continue
        # куб вокруг отрезка запястье → кончик, с запасом: кисть целиком, предплечье — обрубком
        c = (J[L] + J[P]) / 2
        vox = PL / fine
        occ, org = sample(c, 0.75 * PL, vox)
        # шар, а не куб: углы куба на срезе толстой части (голова) дают ложные отростки
        g = np.indices(occ.shape).reshape(3, -1).T * vox + np.asarray(org)
        occ = occ & (np.linalg.norm(g - c, axis=1) <= 0.75 * PL).reshape(occ.shape)
        if occ.sum() < 50:
            continue
        try:
            lj, lp, _ = skeleton(occ, voxel=vox, origin=org, bones_along=10, min_branch=0.1)
        except ValueError:
            continue
        lj = [np.array(x) for x in lj]
        adj = [[] for _ in lj]
        for i, p in enumerate(lp):
            if p >= 0:
                adj[i].append(p)
                adj[p].append(i)
        # от обрубка предплечья (самый задний сустав вдоль руки): идём до первой развилки — это ладонь
        ax = (J[L] - J[P]) / PL
        W = min(range(len(lj)), key=lambda k: float(np.dot(lj[k] - c, ax)))
        par, order, q = {W: -1}, [W], deque([W])
        while q:
            v = q.popleft()
            for w in adj[v]:
                if w not in par:
                    par[w] = v
                    order.append(w)
                    q.append(w)
        ch = {v: [w for w in adj[v] if par.get(w) == v] for v in order}
        H = W
        while len(ch[H]) == 1:
            H = ch[H][0]
        tips = [v for v in order if not ch[v] and v != W]
        def depth(v):
            d = 0.0
            while v != H and par[v] >= 0:
                d += float(np.linalg.norm(lj[v] - lj[par[v]]))
                v = par[v]
            return d
        def branch(v):
            # длина пальца: от кончика до ближайшей развилки
            d = 0.0
            while par[v] >= 0 and len(ch[par[v]]) == 1:
                d += float(np.linalg.norm(lj[v] - lj[par[v]]))
                v = par[v]
            return d + (float(np.linalg.norm(lj[v] - lj[par[v]])) if par[v] >= 0 else 0.0)
        # отростки короче 0.15 руки до кисти — шум вокселизации, не пальцы
        tips = [v for v in tips if branch(v) >= 0.15 * PL]
        fingers = tips
        # пальцы смотрят от запястья (кроме, может быть, большого) и похожи по длине; у головы отростки
        # торчат куда попало (уши, затылок, подбородок)
        ahead = sum(1 for v in fingers if float(np.dot(lj[v] - lj[H], ax)) > 0.5 * float(np.linalg.norm(lj[v] - lj[H])))
        lens = [branch(v) for v in fingers] or [0]
        # пальцы тонкие: толщина у середины пальца — не больше 0.12 длины кисти (у отростков головы — в разы больше)
        thick = surface_distance(largest_component(occ))
        def radius(v):
            m = (lj[v] + lj[par[v]]) / 2 if par[v] >= 0 else lj[v]
            k = np.clip(np.floor((m - np.asarray(org)) / vox + 0.5).astype(int), 0, np.array(occ.shape) - 1)
            return float(thick[tuple(k)]) * vox
        fat = max((radius(v) for v in fingers), default=0.0) / PL
        if log:
            log(f"tip {L} at {np.round(J[L], 2).tolist()} PL={PL:.3f}: tips={len(tips)} fingers={len(fingers)} ahead={ahead} fat={fat:.2f} lens={[round(x / PL, 2) for x in lens]}")
        if not (min_fingers <= len(fingers) <= max_fingers) or len(fingers) != len(tips):
            continue
        # и почти параллельны: направления ладонь → кончик в пределах 45° от среднего (большой палец может выбиваться)
        dirs = [(lj[v] - lj[H]) / max(float(np.linalg.norm(lj[v] - lj[H])), 1e-9) for v in fingers]
        mean = np.sum(dirs, axis=0) / max(float(np.linalg.norm(np.sum(dirs, axis=0))), 1e-9) if dirs else ax
        par_n = sum(1 for d in dirs if float(np.dot(d, mean)) > np.cos(np.radians(45)))
        if log:
            log(f"   parallel={par_n}")
        if ahead < len(fingers) - 1 or par_n < len(fingers) - 1 or max(lens) > 3 * min(lens) or fat > 0.12:
            continue
        # приживляем: обрубок W — это сустав P; всё, что за ним, — новые суставы
        want = set()
        for v in fingers:
            while v != W:
                want.add(v)
                v = par[v]
        idx = {W: P}
        for v in [v for v in order[1:] if v in want]:
            new_j.append(tuple(map(float, lj[v])))
            new_p.append(idx[par[v]])
            idx[v] = len(new_j) - 1
        removed.add(L)
        hands += 1
    if not removed:
        return [tuple(map(float, j)) for j in J], list(parents), 0
    keep = [i for i in range(len(new_j)) if i not in removed]
    remap = {o: k for k, o in enumerate(keep)}
    return [new_j[i] for i in keep], [remap[new_p[i]] if new_p[i] >= 0 else -1 for i in keep], hands
