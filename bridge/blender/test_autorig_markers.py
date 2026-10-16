# Авториг по ручным точкам без Blender: синтетический человек (точки кожи), луч глубины — середина по оси.
import unittest
import numpy as np
from autorig_markers import marker_skeleton

H = 1.8


def body():
    """Облако точек «человек в T-позе», лицом к −Y, Z вверх: туловище, голова, руки с кистями, ноги со стопами."""
    rng = np.random.default_rng(1)
    parts = []
    box = lambda c, s, n=400: c + (rng.random((n, 3)) - 0.5) * s
    parts.append(box([0, 0, 1.25], [0.36, 0.22, 0.6]))   # туловище
    parts.append(box([0, 0, 1.68], [0.2, 0.22, 0.24]))   # голова
    for sx in (1, -1):
        parts.append(box([sx * 0.45, 0, 1.45], [0.6, 0.1, 0.1]))   # рука
        parts.append(box([sx * 0.83, 0, 1.45], [0.16, 0.03, 0.09]))  # кисть-варежка
        parts.append(box([sx * 0.1, 0, 0.5], [0.12, 0.12, 0.9]))   # нога
        parts.append(box([sx * 0.1, -0.08, 0.03], [0.1, 0.24, 0.06]))  # стопа вперёд (−Y)
    return np.vstack(parts)


M = {"chin": [0, -0.1, 1.58], "groin": [0, -0.1, 0.95], "wrist_l": [0.75, -0.05, 1.45], "wrist_r": [-0.75, -0.05, 1.45],
     "elbow_l": [0.45, -0.05, 1.45], "elbow_r": [-0.45, -0.05, 1.45], "knee_l": [0.1, -0.06, 0.5], "knee_r": [-0.1, -0.06, 0.5], "forward": [0, -1, 0]}
center = lambda p, axis: np.array([p[0], 0.0, p[2]])  # середина тела по Y — ноль


class MarkerSkeleton(unittest.TestCase):
    def build(self, fingers=5):
        J, par, names = marker_skeleton(M, body(), center, fingers)
        return {n: np.array(J[i]) for i, n in enumerate(names)}, par, names

    def test_points_land_where_clicked_depth_centered(self):
        j, _, _ = self.build()
        np.testing.assert_allclose(j["LeftForeArm"], [0.45, 0, 1.45])
        np.testing.assert_allclose(j["LeftHand"], [0.75, 0, 1.45])
        np.testing.assert_allclose(j["RightLeg"], [-0.1, 0, 0.5])

    def test_shoulder_continues_forearm_line(self):
        j, _, _ = self.build()
        # плечо — за локтем на длину предплечья ×1.05, к телу
        self.assertAlmostEqual(j["LeftArm"][0], 0.45 - 0.3 * 1.05, places=6)
        self.assertLess(j["LeftShoulder"][0], j["LeftArm"][0])

    def test_tree_is_valid_and_named_like_mixamo(self):
        j, par, names = self.build()
        self.assertEqual(par[0], -1)
        self.assertTrue(all(p < i for i, p in enumerate(par) if p >= 0), "родитель раньше ребёнка")
        for n in ("Hips", "Spine2", "Neck", "Head", "LeftUpLeg", "RightFoot", "LeftToeBase"):
            self.assertIn(n, names)
        # носок — впереди лодыжки (персонаж смотрит на −Y)
        self.assertLess(j["LeftToeBase"][1], j["LeftFoot"][1])
        self.assertGreater(j["Neck"][2], j["Spine2"][2])

    def test_finger_count_and_thumb_forward(self):
        for n, want in ((0, 0), (1, 1), (3, 3), (4, 4), (5, 5)):
            _, _, names = self.build(n)
            got = {x[len("LeftHand"):-1] for x in names if x.startswith("LeftHand") and x[-1].isdigit()}
            self.assertEqual(len(got), want, f"пальцев {n}: {sorted(got)}")
        j, _, _ = self.build(5)
        # большой — со стороны «вперёд» (−Y), мизинец — сзади
        self.assertLess(j["LeftHandThumb1"][1], j["LeftHandPinky1"][1])
        self.assertLess(j["RightHandThumb1"][1], j["RightHandPinky1"][1])
        # пальцы — за запястьем вдоль предплечья
        self.assertGreater(j["LeftHandMiddle1"][0], j["LeftHand"][0])
        self.assertLess(j["RightHandMiddle1"][0], j["RightHand"][0])


if __name__ == "__main__":
    unittest.main()
