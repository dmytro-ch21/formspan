#!/usr/bin/env python3
"""Convert the authored XLSX catalogs into the seed JSON the backend embeds.

Run from the repo root:
    python3 scripts/import-exercise-catalog.py <catalog.xlsx|-> [techniques.xlsx]

Pass `-` for the catalog to import techniques only.

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


def _split(v, seps=";,"):
    """Split a free-text list cell. The sheet mixes `;` and `,` as separators
    within the same column, so both are honoured."""
    import re
    return [x.strip() for x in re.split(f"[{seps}]", str(v or "")) if x.strip()]


def convert_ibjjf_rulesets(path: Path) -> tuple[list[dict], dict[tuple, str]]:
    """Collapse the six IBJJF columns into the handful of distinct rulesets.

    They are near-constant across the library: 450 techniques carry only 25
    distinct combinations, `ibjjf_age_scope` has exactly one value, and the
    most common `ibjjf_rule_notes` string repeats 359 times at ~200 chars.
    Stored per technique that is 182 KB of duplicated prose; stored once per
    ruleset it is 10.6 KB. That is the single biggest win available on the
    wire, and it costs one join on a table that fits in a page.

    Returns the rulesets plus a lookup from the raw tuple to its id, so the
    technique conversion in the same run can reference them consistently.
    """
    COLS = ("ibjjf_age_scope", "ibjjf_rule_class", "ibjjf_adult_gi_allowed_belts",
            "ibjjf_adult_no_gi_allowed_belts", "ibjjf_rule_notes", "ibjjf_rule_source")
    tuples = []
    for r in read_sheet(path, "Techniques", "technique_id"):
        t = tuple(str(r.get(c) or "").strip() for c in COLS)
        if t not in tuples:
            tuples.append(t)

    # Ids are derived from the tuple's CONTENT, not its position.
    #
    # They used to be `slug(rule_class)` plus a numeric suffix assigned in sort
    # order. That is deterministic for identical input but NOT stable across
    # sheet edits: the sort key includes the raw notes text, so fixing a typo
    # in a rule note — the exact maintenance this normalisation exists to make
    # cheap — could renumber which tuple is `-2`. Anything pinning that id
    # would silently repoint to a different, existing ruleset and pass every
    # check, with the failure being wrong competition legality.
    #
    # A short content hash cannot drift: the id changes only when the ruling
    # it names changes, which is exactly when it should.
    import hashlib
    tuples.sort()
    GI_BASELINE = {"White", "Blue", "Purple", "Brown", "Black"}
    NOGI_BASELINE = {"Blue", "Purple", "Brown", "Black"}
    rulesets, lookup, used = [], {}, {}
    for t in tuples:
        age, cls, gi_belts, nogi_belts, notes, source = t
        base = slug(cls) or "ruleset"
        digest = hashlib.sha256("\u0000".join(t).encode()).hexdigest()[:6]
        rid = f"{base}-{digest}"
        lookup[t] = rid
        gi_list = _split(gi_belts) if not gi_belts.startswith("N/A") and gi_belts != "Not legal" else []
        nogi_list = _split(nogi_belts) if not nogi_belts.startswith("N/A") and nogi_belts != "Not legal" else []
        rulesets.append({
            "id": rid,
            "age_scope": age,
            "rule_class": cls,
            # "N/A — gi-specific" is a statement about scope, not a belt list;
            # kept verbatim in `*_note` rather than parsed into a fake belt
            # array that would read as "allowed at no belts".
            "gi_allowed_belts": gi_list,
            "gi_note": gi_belts if gi_belts.startswith("N/A") or gi_belts == "Not legal" else "",
            "no_gi_allowed_belts": nogi_list,
            "no_gi_note": nogi_belts if nogi_belts.startswith("N/A") or nogi_belts == "Not legal" else "",
            "notes": notes,
            "sources": _split(source, ";"),
            # Is this a real restriction, or just the shape of IBJJF's
            # divisions? Adult no-gi simply has no White belt division, so a
            # no-gi technique listing "Blue, Purple, Brown, Black" is the
            # BASELINE, not a restriction on the technique. Conflating the two
            # makes ~130 ordinary techniques look restricted — a mistake made
            # three times while building this before it was written down.
            # Only a list NARROWER than its division's baseline is a warning.
            "is_restricted": bool(
                (gi_list and set(gi_list) != GI_BASELINE)
                or (nogi_list and set(nogi_list) != NOGI_BASELINE)
                or gi_belts == "Not legal" or nogi_belts == "Not legal"
            ),
        })
    # A 6-hex-char digest over ~25 rows collides with probability ~5e-7, but a
    # collision would be SILENT: two different rulesets upsert onto one id, the
    # second overwriting the first, and every technique in the first group then
    # shows the wrong competition legality. That is precisely the failure this
    # content-addressing was introduced to eliminate, so it fails loudly instead.
    ids = [r["id"] for r in rulesets]
    if len(set(ids)) != len(ids):
        dupes = sorted({i for i in ids if ids.count(i) > 1})
        raise SystemExit(f"ruleset id collision: {dupes} — widen the digest")

    return rulesets, lookup


def convert_techniques(path: Path) -> tuple[list[dict], list[dict]]:
    rulesets, ruleset_of = convert_ibjjf_rulesets(path)

    # The sheet writes `setup_from` as technique IDS (`grappling_stance_motion`)
    # while `common_next_moves`/`common_counters` are prose names. Emitting the
    # ids verbatim put raw snake_case identifiers on 368 of 466 detail screens
    # and left the graph 2% resolvable instead of 80%.
    #
    # Resolved HERE rather than in each client: the OpenAPI description already
    # promises these name a technique, and a client-side workaround leaves the
    # data wrong for every other consumer.
    rows = list(read_sheet(path, "Techniques", "technique_id"))
    name_of_id = {slug(r.get("technique_id")): str(r.get("name") or "").strip() for r in rows}

    def resolve(label: str) -> str:
        return name_of_id.get(slug(label), label)

    COLS = ("ibjjf_age_scope", "ibjjf_rule_class", "ibjjf_adult_gi_allowed_belts",
            "ibjjf_adult_no_gi_allowed_belts", "ibjjf_rule_notes", "ibjjf_rule_source")
    out = []
    for r in read_sheet(path, "Techniques", "technique_id"):
        key = tuple(str(r.get(c) or "").strip() for c in COLS)
        out.append({
            "id": slug(r.get("technique_id")),
            "name": str(r.get("name") or "").strip(),
            "aliases": _split(r.get("aliases")),
            "category": str(r.get("category") or "").strip(),
            "position": str(r.get("position") or "").strip(),
            "position_detail": str(r.get("position_detail") or "").strip(),
            "gi_no_gi": str(r.get("gi_no_gi") or "").strip(),
            # The sheet renamed this column; accept either so a re-import of
            # an older export doesn't silently blank every belt.
            "typical_belt": str(r.get("suggested_learning_belt") or r.get("typical_belt") or "").strip(),
            "description": str(r.get("description") or "").strip(),
            "when_to_use": str(r.get("when_to_use") or "").strip(),
            # The graph edges: what this comes from, what follows, what beats it.
            # Ids become names; anything that isn't an id passes through as
            # the prose it already is.
            "setup_from": [resolve(x) for x in _split(r.get("setup_from"))],
            "common_next_moves": _split(r.get("common_next_moves")),
            "common_counters": _split(r.get("common_counters")),
            "video_reference": str(r.get("video_reference") or "").strip(),
            "source_notes": str(r.get("source_notes") or "").strip(),
            "ibjjf_ruleset_id": ruleset_of[key],
        })
    return out, rulesets


def main() -> None:
    if len(sys.argv) < 2:
        sys.exit(__doc__)
    root = Path(__file__).resolve().parent.parent

    # `-` skips the exercise catalog. The two libraries are authored in
    # separate spreadsheets on separate schedules, and coupling them meant a
    # technique-only re-import had to rewrite exercises.generated.json from a
    # file the author might not even have to hand.
    if sys.argv[1] != "-":
        ex = convert_exercises(Path(sys.argv[1]))
        dest = root / "backend/internal/modules/exercise/exercises.generated.json"
        dest.write_text(json.dumps(ex, indent=2, ensure_ascii=False) + "\n")
        print(f"exercises: {len(ex)} -> {dest.relative_to(root)}")
    else:
        print("exercises: skipped")

    if len(sys.argv) > 2:
        tech, rulesets = convert_techniques(Path(sys.argv[2]))
        rdest = root / "backend/internal/modules/technique/ibjjf_rulesets.generated.json"
        rdest.write_text(json.dumps(rulesets, indent=2, ensure_ascii=False) + "\n")
        print(f"ibjjf rulesets: {len(rulesets)} -> {rdest.relative_to(root)}")
        # Techniques authored outside the spreadsheet (gap-fill for bottom
        # positions and advanced material). Merged here so re-importing the
        # sheet cannot silently delete them — which it would, since the sheet
        # is a full replacement rather than a patch.
        extra_path = root / "backend/internal/modules/technique/techniques.additions.json"
        if extra_path.exists():
            extra = json.loads(extra_path.read_text())
            known = {x["id"] for x in tech}
            dupes = [x["id"] for x in extra if x["id"] in known]
            if dupes:
                sys.exit(f"additions collide with sheet ids: {dupes}")
            tech.extend(extra)
            print(f"additions: {len(extra)} merged")
        dest = root / "backend/internal/modules/technique/techniques.generated.json"
        dest.parent.mkdir(parents=True, exist_ok=True)
        dest.write_text(json.dumps(tech, indent=2, ensure_ascii=False) + "\n")
        print(f"techniques: {len(tech)} -> {dest.relative_to(root)}")


if __name__ == "__main__":
    main()
