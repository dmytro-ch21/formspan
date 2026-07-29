#!/usr/bin/env python3
"""Convert the authored XLSX catalogs into the seed JSON the backend embeds.

Run from the repo root:
    python3 scripts/import-exercise-catalog.py <catalog.xlsx> [techniques.xlsx]

Kept as a script rather than a one-off because the spreadsheets are the
authoring surface: when they change, this regenerates the seed rather than
anyone hand-editing 500 JSON objects.

The two mappings that matter, and why they're lossy on purpose:

  * movement_pattern — the source has 75 distinct values (Elbow Flexion,
    Scapular Elevation, Plantar Flexion...). That granularity is great for
    browsing and useless for rules: "heavy hinge work yesterday" would have
    to enumerate a dozen of them. So the coarse pattern the rules reason
    over is derived here, and the source's own value is preserved in
    movement_pattern_detail for display and filtering. Same argument as
    choosing movement_pattern over muscle lists in the first place.

  * load_type — the source's 19 tracking types collapse onto the existing
    five. Worth noting they *do* all collapse: no new load type was needed,
    which is some evidence the original five were the right cut.
"""
import json
import re
import sys
from pathlib import Path

import openpyxl

# Source tracking type -> the load_type that decides which inputs a client
# renders. Where the source encodes extra setup detail (box height, band
# level, assistance), that's a property of the setup, not a distinct thing
# to measure, so it collapses.
LOAD_TYPE = {
    "Weight × Reps": "weight_reps",
    "Band Level × Reps": "weight_reps",   # band level is the load
    "Assistance + Reps": "weight_reps",   # assistance is negative load
    "Height + Reps": "reps",              # box height is setup, not load
    "Reps": "reps",
    "Reps / Distance": "reps",
    "Duration": "time",
    "Duration / Reps": "time",
    "Duration / Rounds": "time",
    "Time / Floors / Level": "time",
    "Distance": "distance",
    "Weight + Distance": "distance",      # loaded carry
    "Load + Distance": "distance",
    "Distance / Duration": "distance_time",
    "Time / Distance / Pace": "distance_time",
    "Time / Distance / Split": "distance_time",
    "Time / Distance / Power": "distance_time",
    "Time / Distance / Speed": "distance_time",
    "Time / Distance / Resistance": "distance_time",
}

# Source movement pattern -> the coarse pattern rules can be written against.
# Anything unlisted falls back to "isolation", which is the honest answer for
# the long tail of single-joint patterns.
PATTERN = {
    "Squat": "squat", "Hip Hinge": "hinge", "Hip Extension": "hinge",
    "Lunge": "lunge", "Step": "lunge",
    "Horizontal Push": "horizontal_push", "Diagonal Push": "horizontal_push",
    "Press": "vertical_push", "Vertical Push": "vertical_push",
    "Horizontal Pull": "horizontal_pull", "Vertical Pull": "vertical_pull",
    "Carry": "carry",
    "Spinal Flexion": "core", "Anti-Extension": "core", "Anti-Rotation": "core",
    "Anti-Lateral Flexion": "core", "Isometric": "core", "Lateral Flexion": "core",
    "Rotation": "rotation",
    "Cyclical": "locomotion", "Locomotion": "locomotion", "Crawl": "locomotion",
    "Ground Movement": "locomotion", "Conditioning": "locomotion",
    "Olympic Pull": "olympic",
    "Jump": "jump",
    "Grappling": "grappling",
}
MOBILITY_HINT = re.compile(r"mobility|prehab|stretch", re.I)

# Media already uploaded to R2, keyed by the exercise ID it belongs to.
#
# The storage paths still read `exercises/barbell-back-squat/...` because the
# objects were uploaded before the authored catalog replaced the twelve
# hand-written entries and renamed most of them. The key is an opaque path,
# so re-pointing it costs nothing and re-uploading eight files would gain
# nothing but tidiness — worth doing when the media pipeline grows, not now.
MEDIA = {
    "back-squat":     "barbell-back-squat",
    "overhead-press": "barbell-overhead-press",
    "dumbbell-walking-lunge": "dumbbell-lunge",
    "plank":          "plank",
}
MEDIA_DIMS = {
    ("barbell-back-squat", "demo"): (683, 1024),
    ("barbell-back-squat", "thumbnail"): (213, 320),
    ("barbell-overhead-press", "demo"): (683, 1024),
    ("barbell-overhead-press", "thumbnail"): (213, 320),
    ("dumbbell-lunge", "demo"): (1024, 1024),
    ("dumbbell-lunge", "thumbnail"): (320, 320),
    ("plank", "demo"): (683, 1024),
    ("plank", "thumbnail"): (213, 320),
}


def media_for(exercise_id: str) -> list[dict]:
    prefix = MEDIA.get(exercise_id)
    if not prefix:
        return []
    out = []
    for kind in ("demo", "thumbnail"):
        w, h = MEDIA_DIMS[(prefix, kind)]
        out.append({
            "kind": kind,
            "storage_key": f"exercises/{prefix}/{kind}.webp",
            "content_type": "image/webp",
            "width": w, "height": h, "position": 0,
        })
    return out


# Entries the source catalog doesn't cover. It's a commercial-gym catalog,
# so its only running options are five treadmill variants — no outdoor run,
# which is the one a BJJ athlete who runs outside actually logs. Curated here
# rather than added to the spreadsheet so the spreadsheet stays a faithful
# record of the gym's equipment.
EXTRAS = [
    {
        "id": "run", "name": "Run", "sport": "running",
        "movement_pattern": "locomotion", "movement_pattern_detail": "Cyclical",
        "primary_muscles": ["quadriceps", "hamstrings", "calves", "glutes"],
        "secondary_muscles": ["core"], "equipment": [],
        "load_type": "distance_time", "is_unilateral": False,
        "instructions": "Any continuous outdoor run. Distance and elapsed "
                        "time together give pace, so pace is derived rather "
                        "than entered.",
        "media": [],
    },
]


def slug(s: str) -> str:
    return re.sub(r"-+", "-", re.sub(r"[^a-z0-9]+", "-", str(s).lower())).strip("-")


def split_list(v) -> list[str]:
    if not v or str(v).strip().lower() in {"none", "nan", ""}:
        return []
    return [slug(p) for p in re.split(r"[;,/]", str(v)) if p.strip()]


def read_sheet(path: Path, sheet: str, first_col: str) -> list[dict]:
    wb = openpyxl.load_workbook(path, read_only=True, data_only=True)
    rows = list(wb[sheet].iter_rows(values_only=True))
    # The sheets carry a title banner above the real header row.
    hi = next(i for i, r in enumerate(rows) if r and str(r[0]).strip() == first_col)
    hdr = [str(c).strip() if c else "" for c in rows[hi]]
    return [dict(zip(hdr, r)) for r in rows[hi + 1:] if r and r[0]]


def convert_exercises(path: Path) -> list[dict]:
    out, skipped = [], []
    for r in read_sheet(path, "Exercise Catalog", "Exercise ID"):
        tracking = str(r.get("Tracking Type") or "").strip()
        load_type = LOAD_TYPE.get(tracking)
        if not load_type:
            skipped.append((r.get("Exercise Name"), tracking))
            continue

        category = str(r.get("Category") or "").strip()
        modality = str(r.get("Modality") or "").strip()
        raw_pattern = str(r.get("Movement Pattern") or "").strip()
        name = str(r.get("Exercise Name") or "").strip()

        if "BJJ" in category or "Grappling" in category:
            sport = "bjj"
        elif re.search(r"\b(run|treadmill|sprint|jog)\b", name, re.I):
            sport = "running"
        else:
            # Everything else is strength. Conditioning and mobility work
            # live here rather than as their own sports: the user's model
            # treats endurance as a *goal* within strength, not a discipline.
            sport = "strength"

        pattern = PATTERN.get(raw_pattern)
        if not pattern:
            pattern = "mobility" if MOBILITY_HINT.search(modality) else "isolation"

        out.append({
            "id": slug(name) or slug(r.get("Exercise ID")),
            "name": name,
            "sport": sport,
            "movement_pattern": pattern,
            "movement_pattern_detail": raw_pattern,
            "primary_muscles": split_list(r.get("Primary Muscles")),
            "secondary_muscles": split_list(r.get("Secondary Muscles")),
            "equipment": split_list(r.get("Equipment")),
            "load_type": load_type,
            "is_unilateral": str(r.get("Laterality") or "").strip() == "Unilateral",
            "instructions": str(r.get("Coaching Notes") or "").strip(),
        })
        out[-1]["media"] = media_for(out[-1]["id"])

    # A duplicate slug would silently overwrite a different exercise, so
    # disambiguate rather than let the seed's own validator reject the batch.
    seen: dict[str, int] = {}
    for e in out:
        if e["id"] in seen:
            seen[e["id"]] += 1
            e["id"] = f"{e['id']}-{seen[e['id']]}"
        else:
            seen[e["id"]] = 1

    out.extend(EXTRAS)

    if skipped:
        print(f"  skipped {len(skipped)} with unmapped tracking type:", file=sys.stderr)
        for n, t in skipped[:5]:
            print(f"    {n!r}: {t!r}", file=sys.stderr)
    return out


def convert_techniques(path: Path) -> list[dict]:
    out = []
    for r in read_sheet(path, "Techniques", "technique_id"):
        out.append({
            "id": slug(r.get("technique_id")),
            "name": str(r.get("name") or "").strip(),
            "aliases": [a.strip() for a in str(r.get("aliases") or "").split(",") if a.strip()],
            "category": str(r.get("category") or "").strip(),
            "position": str(r.get("position") or "").strip(),
            "position_detail": str(r.get("position_detail") or "").strip(),
            "gi_no_gi": str(r.get("gi_no_gi") or "").strip(),
            "typical_belt": str(r.get("typical_belt") or "").strip(),
            "description": str(r.get("description") or "").strip(),
            # The graph edges: what this comes from, and what beats it.
            "setup_from": [s.strip() for s in str(r.get("setup_from") or "").split(",") if s.strip()],
            "common_counters": [s.strip() for s in str(r.get("common_counters") or "").split(",") if s.strip()],
        })
    return out


def main() -> None:
    if len(sys.argv) < 2:
        sys.exit(__doc__)
    root = Path(__file__).resolve().parent.parent

    ex = convert_exercises(Path(sys.argv[1]))
    dest = root / "backend/internal/modules/exercise/exercises.generated.json"
    dest.write_text(json.dumps(ex, indent=2, ensure_ascii=False) + "\n")
    print(f"exercises: {len(ex)} -> {dest.relative_to(root)}")

    if len(sys.argv) > 2:
        tech = convert_techniques(Path(sys.argv[2]))
        dest = root / "backend/internal/modules/technique/techniques.generated.json"
        dest.parent.mkdir(parents=True, exist_ok=True)
        dest.write_text(json.dumps(tech, indent=2, ensure_ascii=False) + "\n")
        print(f"techniques: {len(tech)} -> {dest.relative_to(root)}")


if __name__ == "__main__":
    main()
