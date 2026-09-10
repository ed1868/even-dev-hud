"""Render `/v1/health` for the `devhud status` command."""
import json, sys, time
d = json.load(sys.stdin)
print(f"  ok={d['ok']}  gateway={d['gateway']}")
for s in d.get("sources", []):
    age = ""
    if s.get("last_ok_at"):
        age = f"{round((time.time()*1000 - s['last_ok_at'])/60000)}m ago"
    state = s.get("last_error") or f"ok  {age}"
    print(f"  {s['source']:<22} {state[:60]}")
