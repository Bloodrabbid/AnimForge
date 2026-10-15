// Стандартные имена костей для экспорта: по цепочкам проекта (pelvis, spine, chest, neck, head, arm_*, leg_*) кости
// своей модели получают имена Mixamo или Unreal (UE4/UE5 Manny). Тогда авто-сопоставление в движке (IK Retargeter в
// Unreal, Humanoid Avatar в Unity, ретаргет Mixamo в Blender) узнаёт скелет само. Сами скелеты Epic/Adobe не нужны —
// только имена. Кости вне цепочек (пальцы, уши, хвост) остаются со своими именами.
import type { Project } from "./project.ts";
import type { Rig } from "./evaluate.ts";

export type NameScheme = "mixamo" | "unreal";
export const NAME_SCHEMES: NameScheme[] = ["mixamo", "unreal"];

const SIDE = { mixamo: { l: "Left", r: "Right" }, unreal: { l: "l", r: "r" } };

/** Карта «своё имя → стандартное». Ступня и носок — первые дети последней кости ноги, кисть — последней кости руки;
 * если в руке три кости, первая — ключица. Имя не ставится, если оно уже занято костью вне карты. */
export function standardNames(project: Project, rig: Rig, scheme: NameScheme): Map<string, string> {
  const map = new Map<string, string>();
  const ch = project.chains;
  const mx = scheme === "mixamo";
  const set = (bone: string | undefined, name: string) => {
    if (bone && rig.index.has(bone) && !map.has(bone)) map.set(bone, mx ? `mixamorig:${name}` : name);
  };
  const child = (bone: string | undefined) => {
    if (!bone || !rig.index.has(bone)) return undefined;
    const i = rig.index.get(bone)!;
    // главный ребёнок — с самым длинным «хвостом» потомков (у кисти это средний палец, у стопы — носок)
    const kids = rig.parent.flatMap((p, k) => (p === i ? [k] : []));
    const depth = (k: number): number => 1 + Math.max(0, ...rig.parent.flatMap((p, c) => (p === k ? [depth(c)] : [])));
    kids.sort((a, b) => depth(b) - depth(a));
    return kids.length ? rig.skel.nodes[kids[0]].name : undefined;
  };
  const pelvis = ch.pelvis?.[0];
  set(pelvis, mx ? "Hips" : "pelvis");
  // у Unreal над тазом — кость root (на ней root motion)
  if (!mx && pelvis && rig.parent[rig.index.get(pelvis)!] >= 0) set(rig.skel.nodes[rig.parent[rig.index.get(pelvis)!]].name, "root");
  const spine = [...(ch.spine ?? []), ...(ch.chest ?? [])].filter((b, i, a) => a.indexOf(b) === i && b !== pelvis);
  spine.forEach((b, i) => set(b, mx ? (i ? `Spine${i}` : "Spine") : `spine_${String(i + 1).padStart(2, "0")}`));
  (ch.neck ?? []).forEach((b, i) => set(b, mx ? (i ? `Neck${i}` : "Neck") : `neck_${String(i + 1).padStart(2, "0")}`));
  set(ch.head?.[0], mx ? "Head" : "head");
  for (const s of ["l", "r"] as const) {
    const S = SIDE[scheme][s];
    const nm = (mix: string, ue: string) => (mx ? `${S}${mix}` : `${ue}_${S}`);
    const arm = ch[`arm_${s}`] ?? [];
    const a = arm.length >= 3 ? arm.slice(1) : arm;
    if (arm.length >= 3) set(arm[0], nm("Shoulder", "clavicle"));
    set(a[0], nm("Arm", "upperarm"));
    set(a[1], nm("ForeArm", "lowerarm"));
    set(child(a[a.length - 1]), nm("Hand", "hand"));
    const leg = ch[`leg_${s}`] ?? [];
    set(leg[0], nm("UpLeg", "thigh"));
    set(leg[1], nm("Leg", "calf"));
    const foot = child(leg[leg.length - 1]);
    set(foot, nm("Foot", "foot"));
    set(child(foot), nm("ToeBase", "ball"));
    set(ch[`eye_${s}`]?.[0], mx ? `${S}Eye` : `eye_${S}`);
  }
  // имя, уже занятое костью вне карты, не ставим: в скелете имена должны быть уникальны
  const taken = new Set(rig.skel.nodes.map((n) => n.name).filter((n) => !map.has(n)));
  for (const [k, v] of map) if (taken.has(v)) map.delete(k);
  return map;
}
