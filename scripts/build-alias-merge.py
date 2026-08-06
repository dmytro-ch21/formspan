#!/usr/bin/env python3
"""Build the technique alias-merge list from a curriculum document.

RETIRED, kept as the record of how the 2026-08 alias merge was built. It cannot
run as written: the spreadsheet it existed to work around was retired, and
techniques.additions.json — which it reads to tell sheet-owned rows from
repo-owned ones — was deleted with it. Every row is repo-owned now, so the
distinction it is built on no longer exists. The output it produced is
committed at docs/content/technique-alias-merge.csv.


    python3 scripts/build-alias-merge.py <curriculum.md>

Writes docs/content/technique-alias-merge.csv — the aliases to paste into the
authoring spreadsheet's `aliases` column, one row per technique that gains any.

WHY A SPREADSHEET MERGE AND NOT A JSON EDIT. techniques.json is a build
artifact: `scripts/import-exercise-catalog.py` regenerates it from the sheet as
a FULL REPLACEMENT, and `cmd/exportcontent` refuses to write a sheet-owned id
into techniques.additions.json. So an alias added to a seeded row by editing
JSON survives exactly until the next re-import, then vanishes with nothing
reporting a fault. Only rows this repo owns (the additions file) can be edited
here, and those already carry their aliases from authoring — hence this script
emits ONLY sheet-owned rows.

HOW A CURRICULUM LINE IS READ. Bullets of the form
`* Name (aka Alias One, Alias Two) — Gi / No-Gi`; the parenthetical is the
alias source, everything else is dropped.

HOW A LINE FINDS ITS ROW. Exact fold-match against a catalog name or an
existing alias, plus the hand-curated HAND table for everything else — the
scanner's near-misses are deliberately NOT trusted here. A line that resolves
to neither is reported as unmapped rather than guessed at, because an alias on
the wrong row is worse than a missing one: it is invisible until a search
answers with the wrong technique.

Aliases are dropped when they are too generic to disambiguate, already exist
anywhere in the catalog (a duplicate resolves ambiguously), contain a `;` or
`,` (the sheet cell splits on both), or name a DIFFERENT technique the library
already has. The last class is the dangerous one and is listed explicitly in
SKIP_ALIAS with the row each would have collided with.
"""
import csv
import json
import re
import sys
import unicodedata
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SRC = ROOT / "backend/internal/modules/technique"
OUT = ROOT / "docs/content/technique-alias-merge.csv"

DASHES = re.compile(r"[-‐-―−]+")


def fold(v):
    v = unicodedata.normalize("NFD", v)
    v = "".join(c for c in v if not (0x300 <= ord(c) <= 0x36F))
    v = v.replace("'", "'")
    return re.sub(r"\s+", " ", DASHES.sub(" ", v)).lower().strip()


# Curriculum item name (as written) -> catalog technique name. ONLY entries a
# human confirmed; the scanner's near-misses are deliberately not here.
HAND = {
    "Rear Naked Choke": "Rear Naked Choke",
    "Armbar to Triangle": "Armbar–Triangle–Omoplata Chain",
    "Triangle to Armbar": "Armbar–Triangle–Omoplata Chain",
    "Triangle to Omoplata": "Armbar–Triangle–Omoplata Chain",
    "Body Lock Back Take": "Rear Body-Lock Ride",
    "Bow and Arrow Choke": "Bow-and-Arrow Choke",
    "Collar Choke from Back": "Sliding-Collar Choke from Back",
    "Body Triangle from Back": "Body-Triangle Back Control",
    "Seatbelt Control": "Seatbelt Back Control",
    "Armbar from Back": "Armbar from Back Control",
    "Triangle from Back": "Rear Triangle Choke",
    "Back Take from Turtle": "Chair-Sit Back Take from Turtle",
    "Back Escape (Sit to Guard)": "Back Escape by Turning into Guard",
    "Rear Wrist Control from Back": "Wrist Lock from Back Control",
    "Arm Drag to Back from Guard": "Closed-Guard Arm-Drag Back Take",
    "Arm Drag to Back from Closed Guard": "Closed-Guard Arm-Drag Back Take",
    "Armbar from Closed Guard": "Armbar from Closed Guard",
    "Cross Collar Choke from Guard": "Cross-Collar Choke from Closed Guard",
    "Ezekiel Choke from Guard": "Ezekiel Choke from Closed Guard Bottom",
    "Guillotine Choke from Guard": "Guillotine from Closed Guard",
    "Kimura from Closed Guard": "Kimura from Closed Guard",
    "Loop Choke from Guard": "Loop Choke from Closed Guard",
    "Omoplata from Closed Guard": "Omoplata from Closed Guard",
    "Triangle Choke from Closed Guard": "Triangle Choke from Closed Guard",
    "Elbow-Knee Guard Break": "Elbow-to-Knee Closed-Guard Break",
    "Knee-in Guard Break": "Knee-in-Tailbone Guard Break",
    "Standing Guard Break": "Standing Closed-Guard Break",
    # Deliberate overrides of a literal same-name row: the pendulum already
    # carries "Flower sweep" as an alias, and "Jeff Glover Sweep" is the
    # DEEP-half waiter, not the Waiter Guard row of the same name.
    "Flower Sweep": "Pendulum Sweep",
    "Hip Bump Sweep": "Hip-Bump Sweep",
    "Hip Bump to Kimura": "Hip-Bump to Kimura",
    "Scissor Sweep": "Scissor Sweep",
    "Lumberjack Sweep": "Lumberjack Sweep",
    "Push Sweep from Guard": "Knee-Push Sweep",
    "Armbar from Crucifix": "Armbar from Crucifix",
    "Crucifix Entry from Turtle": "Crucifix from Turtle",
    "Naked Choke from Crucifix": "Rear Naked Choke from Crucifix",
    "Breakfall (Rear)": "Backward Breakfall",
    "Forward Roll": "Forward Shoulder Roll",
    "Technical Stand-Up": "Technical Stand-Up",
    "Hip Escape (Shrimping)": "Hip-Escape Guard Recovery",
    "Granby Roll": "Granby Guard Recovery",
    "Granby Roll from Turtle": "Turtle Granby to Guard",
    "Sit-Out from Turtle": "Turtle Sit-Out to Guard",
    "Stand Up from Turtle": "Stand-Up from Turtle",
    "Double Unders Pass": "Double-Under Pass",
    "Knee Slice Pass": "Knee-Cut Pass",
    "Leg Drag Pass": "Leg-Drag Pass",
    "Long Step Pass": "Long-Step Pass",
    "Over-Under Pass": "Over-Under Pass",
    "Smash Pass": "Smash Pass",
    "Toreando Pass": "Toreando Pass",
    "X-Pass": "X Pass",
    "Cartwheel Pass": "Cartwheel Pass",
    "Headquarters Pass": "Headquarters Passing Position",
    "Backstep Through": "Headquarters Backstep Pass",
    "Body Lock Pass": "Body-Lock Pass",
    "Underhook Pass": "Underhook Knee-Cut Pass",
    "Knee Shield Recovery": "High Knee-Shield Recovery",
    "Z-Guard": "Knee-Shield Half Guard",
    "Old School Sweep": "Old-School Sweep",
    "Plan B Sweep": "Plan B Sweep",
    "Guillotine from Half Guard": "Guillotine from Half Guard",
    "Calf Slicer from Half Guard": "Calf Slicer from Half Guard",
    "Half Guard Underhook Sweep": "Half-Guard Underhook to Dogfight",
    "Half Guard to Back Take": "Dogfight Limp-Arm Back Take",
    "Kimura from Half Guard": "Half-Guard Kimura Sweep",
    "Deep Half Guard": "Deep Half Guard Control",
    "Deep Half Homer Simpson Sweep": "Homer Simpson Sweep",
    "Waiter Sweep": "Deep-Half Waiter Sweep",
    "Lockdown Half Guard": "Lockdown Half Guard",
    "Whip Up from Lockdown": "Lockdown Whip-Up",
    "Electric Chair from Lockdown": "Electric Chair Sweep",
    "Electric Chair from Half Guard": "Electric Chair Sweep",
    "Half Guard Pass (Over-Under)": "Knee-Shield Over-Under Pass",
    "Half Guard Pass (Smash)": "Knee-Shield Smash Pass",
    "Leg Weave Pass": "Knee-Shield Leg-Weave Pass",
    "Ashi Garami": "Butterfly Ashi Control",
    "Outside Ashi Garami": "Outside Ashi Control",
    "Saddle Position": "Cross Ashi / Saddle Control",
    "Straight Ankle Lock": "Straight Ankle Lock from Single-Leg X",
    "Belly Down Ankle Lock": "Belly-Down Straight Ankle Lock",
    "Toe Hold": "Toe Hold from Ashi Garami",
    "Heel Hook from 50/50": "Heel Hook from 50/50",
    "Heel Hook from Outside Ashi": "Outside Heel Hook from Outside Ashi",
    "Heel Hook from Saddle": "Inside Heel Hook from Saddle",
    "Kneebar": "Kneebar from Saddle",
    "High Mount": "High Mount Control",
    "Technical Mount": "Technical Mount Control",
    "Americana from Mount": "Americana from Mount",
    "Arm Triangle from Mount": "Arm-Triangle from Mount",
    "Armbar from Mount": "Armbar from Mount",
    "Cross Collar Choke from Mount": "Cross-Collar Choke from Mount",
    "Ezekiel Choke from Mount": "Ezekiel Choke from Mount",
    "Bow and Arrow Choke from Mount": "Bow-and-Arrow Choke from Technical Mount",
    "Wrist Lock from Mount": "Wrist Lock from Mount",
    "Triangle from Mount": "Mounted Triangle",
    "Mounted Triangle from Side": "Mounted Triangle",
    "Bridge and Roll (Upa Escape)": "Trap-and-Roll Mount Escape",
    "Elbow-Knee Escape": "Elbow–Knee Mount Escape",
    "Foot Drag Escape from Mount": "Heel-Drag Mount Escape",
    "North-South Position": "North–South Control",
    "North-South Choke (Top)": "North–South Choke",
    "North-South Choke": "North–South Choke",
    "Armbar from North-South": "Armbar from North–South",
    "Kimura from North-South": "Kimura from North–South",
    "Butterfly Guard": "Butterfly Guard Double-Underhooks",
    "Butterfly Sweep": "Basic Butterfly Sweep",
    "Arm Drag from Butterfly": "Butterfly Arm-Drag Back Take",
    "Half Butterfly Guard": "Half-Butterfly Guard Control",
    "Berimbolo": "De La Riva Berimbolo",
    "De La Riva Guard": "De La Riva Guard Control",
    "Reverse De La Riva Guard": "Reverse De La Riva Control",
    "Reverse De La Riva Sweep": "Reverse De La Riva Tripod Sweep",
    "Collar Sleeve Guard": "Collar-and-Sleeve Guard Control",
    "Worm Guard": "Worm Guard Control",
    "Worm Guard Sweep": "Worm Guard Sweep",
    "Lapel Guard Back Take": "Worm Guard Back Take",
    "Squid Guard": "Squid Guard Control",
    "Sit-Up Guard": "Sit-Up Guard Recovery",
    "Sit-Up Guard Arm Drag": "Sit-Up Guard Arm Drag",
    "Sit-Up Guard Single Leg": "Sit-Up Guard Single-Leg",
    "Spider Guard": "Spider Guard Control",
    "Spider Guard Omoplata": "Spider Guard Omoplata",
    "Spider Guard Triangle": "Spider Guard Triangle",
    "Spider Guard Sweep (Tripod)": "Spider Guard Tripod Sweep",
    "Lasso Guard Sweep": "Lasso Guard Sweep",
    "Shin-on-Shin Guard": "Shin-to-Shin Guard Control",
    "Single Leg X-Guard": "Single-Leg X Control",
    "X-Guard": "X-Guard Control",
    "X-Guard to Back": "X-Guard Back Take",
    "Ankle Lock from Single Leg X": "Straight Ankle Lock from Single-Leg X",
    "Side Control": "Crossface–Underhook Side Control",
    "Scarf Hold (Kesa Gatame)": "Kesa Gatame Control",
    "Reverse Scarf Hold": "Reverse Kesa Gatame",
    "Americana from Side Control": "Americana from Side Control",
    "Arm Triangle from Side Control": "Arm-Triangle from Side Control",
    "Armbar from Side Control": "Near-Side Armbar from Side Control",
    "Baseball Bat Choke from Side": "Baseball-Bat Choke from Side Control",
    "Paper Cutter Choke": "Paper-Cutter Choke",
    "Bread Cutter Choke": "Paper-Cutter Choke",
    "Kimura from Side Control": "Kimura from Side Control",
    "Wrist Lock from Side Control": "Wrist Lock from Side Control",
    "Side Control to Back": "Side-Control Back Take",
    "Back Take from Side Control": "Side-Control Back Take",
    "Side Control to Knee on Belly": "Side Control to Knee-on-Belly",
    "Side Control to Mount": "Side Control to Mount",
    "Side Control to North-South": "Side Control to North–South",
    "Side Control to Reverse Side Control": "Reverse Kesa Gatame",
    "Bridge and Roll from Side Control": "Bridge-and-Roll Side-Control Escape",
    "Elbow Push Escape from Side": "Elbow-Push Side-Control Escape",
    "Frame and Shrimp from Side": "Frame-and-Hip-Escape from Side Control",
    "Ghost Escape": "Ghost Escape",
    "Americana": "Americana from Side Control",
    "Armbar (Juji-Gatame)": "Armbar from Closed Guard",
    "Kimura": "Kimura from Closed Guard",
    "Omoplata": "Omoplata from Closed Guard",
    "Triangle Choke": "Triangle Choke from Closed Guard",
    "Arm Triangle Choke": "Arm-Triangle from Side Control",
    "Anaconda Choke": "Anaconda Choke",
    "Peruvian Necktie": "Peruvian Necktie",
    "D'Arce Choke": "D'Arce Choke from Side Control",
    "Baseball Bat Choke": "Baseball-Bat Choke from Side Control",
    "Loop Choke": "Loop Choke from Closed Guard",
    "Guillotine Choke (Standing)": "Standing Guillotine",
    "High Elbow Guillotine": "Guillotine from Front Headlock",
    "Twister": "Twister from Back Control",
    "Wrist Lock": "Wrist Lock from Side Control",
    "Straight Armlock (Ude Gatame)": "Straight Armbar from Side Control",
    "Shoulder Crunch": "Shoulder-Crunch Sweep from Closed Guard",
    "Ankle Pick": "Ankle Pick",
    "Double Leg Takedown": "Double-Leg Takedown",
    "Single Leg Takedown": "Outside Single-Leg",
    "Duck Under": "Duck-Under",
    "Fireman's Carry (Wrestling)": "Fireman's Carry Dump",
    "High Crotch Takedown": "High-Crotch Entry",
    "Knee Tap": "Knee Pick",
    "Lateral Drop": "Lateral Drop",
    "Snap Down": "Snapdown to Front Headlock",
    "Sprawl": "Sprawl Defense",
    "Sprawl Drill": "Sprawl Defense",
    "Arm Drag to Takedown": "Standing Arm Drag",
    "Arm Drag from Clinch": "Standing Arm Drag",
    "Front Headlock": "Front-Headlock Chin-Strap Control",
    "Front Headlock to Guillotine": "Standing Guillotine",
    "Russian Tie": "Russian Tie Two-on-One",
    "Two-on-One Wrist Control": "Russian Tie Two-on-One",
    "Body Lock to Mat Return": "Rear Body-Lock Mat Return",
    "Body Lock to Trip": "Body-Lock Outside Trip",
    "Inside Trip": "Body-Lock Inside Trip",
    "Outside Trip": "Body-Lock Outside Trip",
    "Overhook Control": "Closed-Guard Overhook Control",
    "Collar Tie": "Collar Tie with Elbow Control",
    "Shoulder Throw from Clinch": "Ippon Seoi Nage",
    "De Ashi Barai": "De Ashi Barai",
    "Ko-uchi Gari": "Ko Uchi Gari",
    "O-soto Gari": "O Soto Gari",
    "O-uchi Gari": "O Uchi Gari",
    "Sasae Tsurikomi Ashi": "Sasae Tsurikomi Ashi",
    "Ko-soto Gari": "Ko Soto Gake",
    "Harai Goshi": "Harai Goshi",
    "Koshi Guruma": "Koshi Guruma",
    "O-goshi": "O Goshi",
    "Uchi Mata": "Uchi Mata",
    "Ippon Seoi Nage": "Ippon Seoi Nage",
    "Kata Guruma": "Kata Guruma",
    "Sumi Gaeshi": "Standing Sumi Gaeshi",
    "Tani Otoshi": "Tani Otoshi",
    "Tomoe Nage": "Tomoe Nage",
    "Yoko Otoshi": "Yoko Otoshi",
    "Tai Otoshi": "Tai Otoshi",
    "Clock Choke": "Clock Choke",
    "Spiral Ride (No-Gi)": "Spiral Ride",
    "Seatbelt from Turtle": "Seatbelt Control from Turtle",
    "D'Arce Choke from Turtle": "D'Arce Choke from Front Headlock",
    "Guillotine from Turtle Top": "Guillotine from Front Headlock",
    "Anaconda Choke from Turtle": "Anaconda Choke",
    "Go Behind": "Front Headlock Go-Behind",
    "Stand-Up in Base": "Stand-Up from Turtle",
    "Switch Base": "Standing Switch from Turtle",
    "Rubber Guard": "Rubber Guard Mission Control",
    "Crab Ride": "Crab-Ride Control",
    "Truck Position": "Calf Slicer from the Truck",
    "50/50 Guard": "50/50 Guard Control",
    "K-Guard": "K Guard Control",
}

# Aliases NOT worth carrying even when the mapping is right: too generic to
# disambiguate, or they name the position rather than this technique.
SKIP_ALIAS = {
    "gi choke from back", "no gi crucifix choke", "no gi back pressure",
    "seated no gi guard", "no gi lockdown half guard", "no gi turtle top",
    "half guard pass", "butterfly guard pass", "spider guard pass",
    "x guard pass", "slx guard pass", "dlr pass", "guard armbar",
    "half guard", "knee shield", "open guard", "side mount", "cross side control",
    "lockdown", "defensive turtle", "leg entanglement", "ns position",
    "reverse side control", "sleeve guard", "c&s guard", "collar and sleeve",
    "dlr guard", "slx", "full x guard", "k guard", "k guard entry",
    "50/50", "fifty fifty position", "front headlock control", "whizzer",
    "neck tie", "wrestler's guard", "knee shield half guard",
    "10th planet lockdown", "half mount guard", "mariposa guard",
    "sitting guard with hooks", "aranha guard", "de la riva hook",
    "deep half", "dhg", "turtle top leg lock entry",
    # Curriculum akas that name a DIFFERENT technique the library already has.
    # Carrying them would make search answer with the wrong row, which is the
    # one failure mode worse than a missing alias.
    "far side armbar",        # "Far-Side Armbar from Side Control" is its own row
    "waiter sweep from guard",  # "Waiter Sweep" is its own row (Waiter Guard), and
                                # "Deep-Half Waiter Sweep" a second — neither is the lumberjack
    "granby roll escape",     # bridge-and-roll is not a granby; four granby rows exist
    "tekubi hishigi",         # judo's tekubi hishigi is a WRIST lock, not a toe hold
    # Caught by the review pass below: each names a row that already exists
    # under almost exactly that string, so the alias would answer for the
    # wrong one.
    "seatbelt from turtle",       # "Seatbelt Control from Turtle" is its own row
    "front headlock guillotine",  # "Guillotine from Front Headlock" is its own row
    "granby escape",              # "Granby Escape from Rear Ride" is its own row
    "switch from turtle",         # "Standing Switch from Turtle" is its own row
    "dogfight sweep",             # "Dogfight Knee-Tap Sweep" is the sweep; this row is the entry
    "half smash pass",            # "Knee-Shield Smash Pass" IS the half-guard smash, and
                                  # gains the synonymous "Smash Pass from Half" below
    "crab ride to twister",       # names the twister; "Twister from Back Control" is its own row
}


def parse_curriculum(path: Path):
    """(display name, [aka strings]) per bullet. Same shape rules as the scan."""
    items = []
    for raw in path.read_text().splitlines():
        line = raw.replace("'", "'").strip()
        if not (line.startswith("* ") or line.startswith("- ")):
            continue
        text = line[2:].strip()
        text = re.sub(r"\s[—-]\s*(Gi\s*/\s*No-Gi|No-Gi|Gi)\s*$", "", text).strip()
        m = re.search(r"\(aka ([^)]*)\)", text)
        akas = [a.strip() for a in m.group(1).split(",") if a.strip()] if m else []
        name = re.sub(r"\s*\(aka [^)]*\)", "", text).strip()
        if name and akas:
            items.append((name, akas))
    return items


def main():
    if not (SRC / "techniques.additions.json").exists():
        sys.exit(
            "build-alias-merge.py is RETIRED. It tells sheet-owned rows from "
            "repo-owned ones by reading techniques.additions.json, which was "
            "deleted when the spreadsheet was retired — every row is repo-owned "
            "now, so the distinction it is built on no longer exists.\n\n"
            "Its output is committed at docs/content/technique-alias-merge.csv.")
    if len(sys.argv) < 2:
        sys.exit(__doc__.strip().splitlines()[2].strip())
    curriculum = Path(sys.argv[1])
    catalog = json.loads((SRC / "techniques.json").read_text())
    ours = {t["id"] for t in json.loads((SRC / "techniques.additions.json").read_text())}
    sheet = [t for t in catalog if t["id"] not in ours]

    by_name = {t["name"]: t for t in sheet}
    by_fold = {}
    for t in sheet:
        by_fold.setdefault(fold(t["name"]), t)
        for a in t["aliases"]:
            by_fold.setdefault(fold(a), t)
    # Every alias in the WHOLE catalog (ours included) — an alias that already
    # exists anywhere must not be duplicated onto a second row, or the search
    # it was added for resolves ambiguously.
    taken = {}
    for t in catalog:
        taken.setdefault(fold(t["name"]), t["name"])
        for a in t["aliases"]:
            taken.setdefault(fold(a), t["name"])

    additions, unmapped, dropped = {}, [], []
    for name, akas in parse_curriculum(curriculum):
        target = None
        if name in HAND:
            target = by_name.get(HAND[name])
            if target is None:
                sys.exit(f"HAND maps {name!r} to unknown/ours-owned {HAND[name]!r}")
        elif fold(name) in by_fold:
            target = by_fold[fold(name)]
        if target is None:
            unmapped.append((name, akas))
            continue
        for a in akas:
            a = a.replace("\u2019", "'")
            f = fold(a)
            if f in SKIP_ALIAS:
                dropped.append((a, target["name"], "generic"))
            elif f in taken:
                dropped.append((a, target["name"], f"already on {taken[f]}"))
            elif "," in a or ";" in a:
                dropped.append((a, target["name"], "separator char"))
            else:
                additions.setdefault(target["id"], {"name": target["name"], "add": []})
                if f not in {fold(x) for x in additions[target["id"]]["add"]}:
                    additions[target["id"]]["add"].append(a)
                    taken[f] = target["name"]

    # Review pass: an alias whose tokens are all present in a DIFFERENT row's
    # name is the shape that put "Far Side Armbar" on the near-side row. Not
    # auto-dropped (many are legitimately looser than the name they sit on),
    # but every one is printed so a human sees it before the sheet edit.
    suspicious = []
    names = [(t["name"], set(fold(t["name"]).split())) for t in catalog]
    for tid, v in additions.items():
        tgt = set(fold(v["name"]).split())
        for a in v["add"]:
            at = set(fold(a).split())
            for nm, nt in names:
                if nm != v["name"] and at <= nt and not at <= tgt:
                    suspicious.append((a, v["name"], nm))
                    break

    rows = []
    for tid, v in sorted(additions.items()):
        cur = by_name[v["name"]]["aliases"]
        rows.append({
            "technique_id": tid, "name": v["name"],
            "current_aliases": cur, "add": v["add"],
            "new_cell": "; ".join(cur + v["add"]),
        })
    OUT.parent.mkdir(parents=True, exist_ok=True)
    with OUT.open("w", newline="") as fh:
        # LF, not the csv module's default CRLF — otherwise git normalises
        # every line on commit and the file churns on each regeneration.
        w = csv.writer(fh, lineterminator="\n")
        w.writerow(["technique_id", "name", "current_aliases",
                    "aliases_to_add", "aliases_new_cell"])
        for r in rows:
            w.writerow([r["technique_id"], r["name"], "; ".join(r["current_aliases"]),
                        "; ".join(r["add"]), r["new_cell"]])
    print(f"{len(rows)} sheet rows gain {sum(len(r['add']) for r in rows)} aliases")
    print(f"wrote {OUT.relative_to(ROOT)}")
    print(f"unmapped curriculum items with akas: {len(unmapped)}")
    print(f"dropped aliases: {len(dropped)}")
    if suspicious:
        print(f"\nREVIEW — alias fits another row's name better ({len(suspicious)}):")
        for a, on, other in suspicious:
            print(f"  {a!r} on {on!r} — also describes {other!r}")


if __name__ == "__main__":
    main()
