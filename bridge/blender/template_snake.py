# Шаблон «змея»: длинное тело, голова чуть шире шеи, хвост сходит на нет; много костей, чтобы волна шла плавно.
# blender -b --python template_snake.py -- <out.glb> [костей=14] [длина=4]
import math, os, sys
sys.path.append(os.path.dirname(__file__))
import bodykit as k

a = sys.argv[sys.argv.index("--") + 1:]
out, n, L = a[0], int(a[1]) if len(a) > 1 else 14, float(a[2]) if len(a) > 2 else 4.0
k.reset()
head_x, tail_x = L * 0.5, -L * 0.5


def r(u):
    head = 0.11 + 0.05 * math.exp(-((u - 0.03) / 0.03) ** 2)  # голова
    neck = 0.09 if u < 0.09 else 0
    body = 0.13 * math.sin(math.pi * min(1, (u - 0.06) / 0.94)) ** 0.5 if u > 0.06 else 0
    return max(0.012, max(head if u < 0.08 else 0, neck, body) * (1 - 0.85 * u ** 3))


body = k.join([k.tube("Snake", (head_x, 0, 0.13), (tail_x, 0, 0.13), r, rings=120, seg=16, squash=(1.0, 0.8))], "SnakeBody", (0.35, 0.5, 0.25))
rig = k.Rig("SnakeRig")
rig.bone("root", (head_x, 0, 0.13), (head_x, 0, 0.35))
rig.chain("spine", (head_x, 0, 0.13), (tail_x, 0, 0.13), n, parent="root")
k.bind_and_export(body, rig.done(), out, "SNAKE")
