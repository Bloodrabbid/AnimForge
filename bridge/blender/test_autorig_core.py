# Тесты авторига на воксельных формах без Blender: python3 -m unittest bridge/blender/test_autorig_core.py
import os, sys, unittest
import numpy as np

sys.path.insert(0, os.path.dirname(__file__))
from autorig_core import skeleton


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


if __name__ == "__main__":
    unittest.main()
