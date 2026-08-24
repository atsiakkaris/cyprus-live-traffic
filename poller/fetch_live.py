"""
fetch_live.py — poll the public traffic4cyprus feeds, join geometry with live
speed/travel-time per Bluetooth path, and write a single latest.json snapshot.

Run this on a schedule (e.g. every 5 min). No history is kept — each run
overwrites the previous snapshot, since the app only ever needs "now".
"""
import html
import json
import re
import sys
import urllib.request
import xml.etree.ElementTree as ET
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path

BASE = "https://www.traffic4cyprus.org.cy/swarco3/api/Data"
GEOMETRY_URL = f"{BASE}/PredefinedLocationPublication"
LIVE_URL = f"{BASE}/PredefinedLocationDataPublication"

OUT_PATH = Path(__file__).parent.parent / "preview" / "latest.json"


def fetch(url):
    req = urllib.request.Request(url, headers={"User-Agent": "cyprus-live-traffic-poller/0.1"})
    with urllib.request.urlopen(req, timeout=30) as resp:
        return resp.read().decode("utf-8")


def parse_geometry(xml_text):
    """{path_id: {name, coords: [[lat, lon], ...]}}"""
    root = ET.fromstring(xml_text.strip())
    result = {}
    for loc in root.findall(".//{*}predefinedLocationReference"):
        pid = loc.get("id")
        if not pid:
            continue
        name_el = loc.find(".//{*}predefinedLocationName//{*}value")
        name = name_el.text if name_el is not None and name_el.text else pid
        pos_el = loc.find(".//{*}posList")
        if pos_el is None or not pos_el.text:
            continue
        m = re.search(r"<gml:coordinates[^>]*>(.*?)</gml:coordinates>", html.unescape(pos_el.text), re.DOTALL)
        if not m:
            continue
        coords = []
        for pair in m.group(1).strip().split():
            parts = pair.split(",")
            if len(parts) == 2:
                try:
                    coords.append([float(parts[0]), float(parts[1])])
                except ValueError:
                    pass
        if coords:
            result[pid] = {"name": name, "coords": coords}
    return result


def parse_live(xml_text):
    """{path_id: {speed_kmh, travel_time_s, measured_at}}"""
    root = ET.fromstring(xml_text.strip())
    result = {}
    for loc in root.findall(".//{*}predefinedLocationReference"):
        pid = loc.get("id")
        if not pid:
            continue
        ext = loc.find(".//{*}_predefinedLocationExtension")
        if ext is None:
            continue
        speed_el = ext.find("obs_speed")
        ttime_el = ext.find("obs_t_time")
        ts_el = ext.find("measurement_timestamp")
        try:
            speed = float(speed_el.text) if speed_el is not None and speed_el.text else None
        except ValueError:
            speed = None
        try:
            ttime = float(ttime_el.text) if ttime_el is not None and ttime_el.text else None
        except ValueError:
            ttime = None
        result[pid] = {
            "speed_kmh": round(speed, 1) if speed is not None else None,
            "travel_time_s": round(ttime, 0) if ttime is not None else None,
            "measured_at": ts_el.text if ts_el is not None else None,
        }
    return result


def build_snapshot():
    geometry = parse_geometry(fetch(GEOMETRY_URL))
    live = parse_live(fetch(LIVE_URL))

    paths = []
    for pid, geo in geometry.items():
        entry = {
            "id": pid,
            "name": geo["name"],
            "coords": geo["coords"],
        }
        entry.update(live.get(pid, {"speed_kmh": None, "travel_time_s": None, "measured_at": None}))
        paths.append(entry)

    # Mode (not max) across all paths' own measured_at — see worker.js's
    # modeMeasuredAt for the reasoning; kept in sync here so local dev via
    # the poller shows the same "outdated since" note as the deployed app.
    measured_ats = [p["measured_at"] for p in paths if p.get("measured_at")]
    common_measurement_timestamp = Counter(measured_ats).most_common(1)[0][0] if measured_ats else None

    return {
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "path_count": len(paths),
        "matched_live_count": sum(1 for p in paths if p.get("speed_kmh") is not None),
        "common_measurement_timestamp": common_measurement_timestamp,
        "paths": paths,
    }


def main():
    snapshot = build_snapshot()
    OUT_PATH.write_text(json.dumps(snapshot, indent=None, separators=(",", ":")), encoding="utf-8")
    print(f"Wrote {OUT_PATH} — {snapshot['path_count']} paths, "
          f"{snapshot['matched_live_count']} with live data")


if __name__ == "__main__":
    sys.exit(main())
