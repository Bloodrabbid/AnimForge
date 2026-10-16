import subprocess, os, csv
D = "out/ccby/style100"
NAME = {"FW": "walk", "BW": "walk-back", "SW": "strafe-walk", "FR": "run", "BR": "run-back", "SR": "strafe-run", "ID": "idle", "TR1": "transition-walk-run-1", "TR2": "transition-walk-run-2", "TR3": "transition-walk-run-3"}
groups = {"100style-walk": ["FW", "BW", "SW"], "100style-run": ["FR", "BR", "SR"], "100style-idle": ["ID"], "100style-transitions": ["TR1", "TR2", "TR3"]}
rows = [l.split("\t") for l in open(f"{D}/cuts.tsv")]
for gid, types in groups.items():
    items = [f"{NAME[t]}_{st}{'' if t.startswith('TR') else '_loop'}={D}/{st}_{t}.bvh" for st, t, *_ in rows if t in types]
    r = subprocess.run(["/Applications/Blender.app/Contents/MacOS/Blender", "-b", "--factory-startup", "--python", "bridge/blender/merge_bvh.py", "--", f"out/ccby/build/{gid}.glb", *items], capture_output=True, text=True, env={**os.environ, "MERGE_KEEP_FIRST": "1"})
    print(gid, len(items), [l for l in r.stdout.splitlines() if "MERGE" in l or "Error" in l][:3], r.stderr[-300:] if r.returncode else "", flush=True)
