// Мост к glTF через glTF-Transform: чтение скелета и запись запечённых клипов. Без Node-зависимостей.
import { Document, Node } from "@gltf-transform/core";
import type { Quat, Vec3 } from "./math.ts";
import type { Bone, Project, Skeleton } from "./project.ts";
import { Rig, bakeClip } from "./evaluate.ts";

export function readSkeleton(doc: Document): Skeleton {
  const root = doc.getRoot();
  const joints = new Set<Node>();
  for (const skin of root.listSkins()) skin.listJoints().forEach((j) => joints.add(j));
  const nodes: Bone[] = [];
  const visit = (n: Node, parent: string | null) => {
    nodes.push({
      name: n.getName(),
      parent,
      restT: n.getTranslation() as Vec3,
      restR: n.getRotation() as Quat,
      restS: n.getScale() as Vec3,
      isJoint: joints.has(n),
    });
    n.listChildren().forEach((c) => visit(c, n.getName()));
  };
  for (const scene of root.listScenes()) scene.listChildren().forEach((n) => visit(n, null));
  return { nodes };
}

/** Записывает все клипы проекта в документ как glTF-анимации (повороты, LINEAR). Старые анимации с теми же именами заменяются. */
export function writeClips(doc: Document, project: Project, rig: Rig): { clip: string; bones: number; keys: number }[] {
  const root = doc.getRoot();
  const buffer = root.listBuffers()[0] ?? doc.createBuffer();
  const byName = new Map(root.listNodes().map((n) => [n.getName(), n]));
  const report: { clip: string; bones: number; keys: number }[] = [];
  for (const clip of project.clips) {
    root.listAnimations().filter((a) => a.getName() === clip.name).forEach((a) => a.dispose());
    const baked = bakeClip(project, rig, clip);
    const anim = doc.createAnimation(clip.name);
    const input = doc.createAccessor(`${clip.name}_t`).setType("SCALAR").setArray(new Float32Array(baked.times)).setBuffer(buffer);
    for (const [bone, qs] of baked.rotations) {
      const node = byName.get(bone);
      if (!node) continue;
      const output = doc.createAccessor(`${clip.name}_${bone}_r`).setType("VEC4").setArray(new Float32Array(qs.flat())).setBuffer(buffer);
      const sampler = doc.createAnimationSampler().setInput(input).setOutput(output).setInterpolation("LINEAR");
      anim.addSampler(sampler).addChannel(doc.createAnimationChannel().setTargetNode(node).setTargetPath("rotation").setSampler(sampler));
    }
    report.push({ clip: clip.name, bones: baked.rotations.size, keys: baked.times.length });
  }
  return report;
}
