# Тесты авторига на воксельных формах без Blender: python3 -m unittest bridge/blender/test_autorig_core.py
import os, sys, unittest
import numpy as np

sys.path.insert(0, os.path.dirname(__file__))
from autorig_core import refine_tips, skeleton


def tube(occ, a, b, r):
    """Закрасить цилиндр с полусферами от a до b радиусом r (в вокселях)."""
    a, b = np.array(a, float), np.array(b, float)
    g = np.indices(occ.shape).reshape(3, -1).T
    ab = b - a
    t = np.clip(((g - a) @ ab) / (ab @ ab), 0, 1)
    d = np.linalg.norm(g - (a + t[:, None] * ab), axis=1)
    occ.reshape(-1)[d <= r] = True


def leaves(joints, parents):
    has_kid = set(p for p in parents if p >= 0)
    return [np.array(joints[i]) for i in range(len(joints)) if i not in has_kid]


def animal():
    """Четвероногое вдоль X, верх — Z: туловище, 4 ноги вниз, шея с головой вперёд-вверх, хвост назад."""
    occ = np.zeros((70, 30, 44), bool)
    tube(occ, (18, 15, 26), (48, 15, 26), 7)  # туловище
    ends = {"fl": (44, 9, 2), "fr": (44, 21, 2), "hl": (22, 9, 2), "hr": (22, 21, 2), "head": (62, 15, 40), "tail": (3, 15, 30)}
    for k, e in ends.items():
        base = {"fl": (44, 9, 24), "fr": (44, 21, 24), "hl": (22, 9, 24), "hr": (22, 21, 24), "head": (50, 15, 30), "tail": (16, 15, 27)}[k]
        tube(occ, base, e, 3)
    return occ, ends


def human():
    """Двуногое, верх — Z: туловище, ноги вниз, руки в стороны (T-поза), шея с головой."""
    occ = np.zeros((64, 20, 90), bool)
    tube(occ, (32, 10, 42), (32, 10, 66), 7)  # туловище
    tube(occ, (27, 10, 42), (25, 10, 3), 3)  # левая нога
    tube(occ, (37, 10, 42), (39, 10, 3), 3)
    tube(occ, (32, 10, 62), (3, 10, 63), 2)  # руки
    tube(occ, (32, 10, 62), (61, 10, 63), 2)
    tube(occ, (32, 10, 70), (32, 10, 84), 4)  # голова
    return occ


def capsules_occ(caps, lo, voxel, dims):
    """Воксели набора капсул (a, b, r) в мировых координатах: сетка с центром вокселя (0,0,0) в lo."""
    g = np.indices(dims).reshape(3, -1).T * voxel + np.asarray(lo, float)
    occ = np.zeros(len(g), bool)
    for a, b, r in caps:
        a, b = np.array(a, float), np.array(b, float)
        ab = b - a
        t = np.clip(((g - a) @ ab) / (ab @ ab), 0, 1)
        occ |= np.linalg.norm(g - (a + t[:, None] * ab), axis=1) <= r
    return occ.reshape(dims)


def hand_human(fingers=4, gap=0.6):
    """Человек в T-позе (рост ~90), у левой руки ладонь и пальцы толщиной 1.2 с зазором gap — на крупной сетке
    они сливаются."""
    caps = [((32, 10, 42), (32, 10, 66), 7), ((27, 10, 42), (25, 10, 3), 3), ((37, 10, 42), (39, 10, 3), 3),
            ((32, 10, 62), (61, 10, 63), 2), ((32, 10, 70), (32, 10, 84), 4),
            ((32, 10, 62), (8, 10, 63), 2), ((8, 10, 63), (4, 10, 63), 2.2)]  # правая рука до запястья, ладонь
    # ступня с пальцами вперёд (+Y): пальцы ног — не кисть, их не трогаем
    caps.append(((39, 10, 3), (39, 4, 2), 2.2))
    for k in range(4):
        caps.append(((36.6 + k * 1.6, 4, 2), (36.6 + k * 1.6, -2, 1.5), 0.6))
    for k in range(fingers):
        z = 63 + (k - (fingers - 1) / 2) * (2 * 1.2 + gap) * 0.5
        caps.append(((4, 10, z), (-4, 10, z + (k - 1.5) * 0.4), 0.6))
    return caps


class AutorigCore(unittest.TestCase):
    def test_human_root_is_pelvis_not_belly(self):
        joints, parents, _ = skeleton(human())
        r = joints[0]
        self.assertTrue(30 <= r[2] <= 46, f"корень у развилки ног (таз), а не груди или живота: {r}")
        self.assertEqual(len(leaves(joints, parents)), 5, "две ноги, две руки, голова")
        self.assertTrue(all(p < i for i, p in enumerate(parents)), "родитель всегда раньше ребёнка")

    def test_animal_has_six_branches_ending_at_tips(self):
        occ, ends = animal()
        joints, parents, info = skeleton(occ)
        lv = leaves(joints, parents)
        self.assertEqual(len(lv), 6, f"ветки: 4 ноги, голова, хвост; получилось {len(lv)}: {info}")
        for name, e in ends.items():
            d = min(np.linalg.norm(l - np.array(e)) for l in lv)
            self.assertLess(d, 5.5, f"{name}: ближайший лист в {d:.1f} вокселях от кончика")
        # корень — в туловище, а не на конечности
        self.assertLess(abs(joints[0][2] - 26), 6)
        self.assertTrue(18 <= joints[0][0] <= 48)

    def test_short_bumps_are_pruned(self):
        occ, _ = animal()
        tube(occ, (33, 15, 33), (33, 15, 35), 2)  # бугорок на спине — не отдельная ветка
        joints, parents, _ = skeleton(occ)
        self.assertEqual(len(leaves(joints, parents)), 6)

    def test_straight_tube_is_one_chain_with_even_bones(self):
        occ = np.zeros((80, 16, 16), bool)
        tube(occ, (4, 8, 8), (75, 8, 8), 5)
        joints, parents, _ = skeleton(occ, bones_along=10)
        self.assertEqual(len(leaves(joints, parents)), 1, "тело-линия: корень в конце, одна цепочка во всю длину")
        self.assertTrue(joints[0][0] < 12 or joints[0][0] > 67, f"корень на конце трубки: {joints[0]}")
        lens = [np.linalg.norm(np.array(joints[i]) - np.array(joints[p])) for i, p in enumerate(parents) if p >= 0]
        self.assertLess(max(lens) / min(lens), 1.6, f"кости примерно равные: {lens}")
        self.assertGreaterEqual(len(lens), 8)

    def test_world_coordinates(self):
        occ, _ = animal()
        j1, _, _ = skeleton(occ)
        j2, _, _ = skeleton(occ, voxel=0.5, origin=(10, 0, 0))
        self.assertAlmostEqual(j2[0][0], 10 + j1[0][0] * 0.5, places=6)


class Fingers(unittest.TestCase):
    def run_hand(self, fingers):
        caps = hand_human(fingers)
        lo = np.array([-8.0, 0.0, 0.0])
        coarse = 1.0
        occ = capsules_occ(caps, lo, coarse, (74, 20, 90))
        joints, parents, _ = skeleton(occ, voxel=coarse, origin=tuple(lo))
        calls = []

        def sample(c, half, voxel):
            calls.append(voxel)
            o = np.asarray(c) - half
            n = int(np.ceil(2 * half / voxel)) + 1
            return capsules_occ(caps, o, voxel, (n, n, n)), tuple(o)

        return joints, parents, refine_tips(joints, parents, sample), calls

    def test_fingers_grow_on_hand_only(self):
        joints, parents, (j2, p2, hands), calls = self.run_hand(4)
        self.assertGreater(len(calls), 0)
        self.assertLess(min(calls), 0.5, "кисть вокселится мельче основной сетки")
        self.assertEqual(hands, 1, "пальцы — только у руки с пальцами")
        tips = leaves(j2, p2)
        finger_tips = [t for t in tips if t[0] < -1]
        self.assertEqual(len(finger_tips), 4, f"четыре пальца: {finger_tips}")
        self.assertEqual(len(tips), len(leaves(joints, parents)) - 1 + 4)
        self.assertTrue(all(p < i for i, p in enumerate(p2)), "родитель раньше ребёнка")

    def test_mitten_stays(self):
        _, _, (_, _, hands), _ = self.run_hand(0)
        self.assertEqual(hands, 0, "кисть без пальцев не трогаем")


if __name__ == "__main__":
    unittest.main()
