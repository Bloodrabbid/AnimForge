import subprocess, os, glob, re
D = "out/ccby/bandai/dataset/Bandai-Namco-Research-Motiondataset-1/data"
groups = {
  "bandai-locomotion": {"walk", "run", "dash", "walk-back", "walk-left", "walk-right"},
  "bandai-gestures": {"bow", "bye", "byebye", "guide", "call", "respond"},
  "bandai-action": {"kick", "punch", "slash", "dance-long", "dance-short"},
}
for gid, motions in groups.items():
    items = []
    for f in sorted(glob.glob(f"{D}/*.bvh")):
        m = re.match(r"dataset-1_(.+?)_(.+?)_(\d+)\.bvh", os.path.basename(f))
        if m and m.group(1) in motions:
            items.append(f"{m.group(1)}_{m.group(2)}_{m.group(3)}={f}")
    r = subprocess.run(["/Applications/Blender.app/Contents/MacOS/Blender", "-b", "--factory-startup", "--python", "bridge/blender/merge_bvh.py", "--", f"out/ccby/build/{gid}.glb", *items], capture_output=True, text=True, env={**os.environ, "MERGE_KEEP_FIRST": "1"})
    print(gid, len(items), [l for l in r.stdout.splitlines() if "MERGE" in l or "Error" in l][:3], r.stderr[-300:] if r.returncode else "")
