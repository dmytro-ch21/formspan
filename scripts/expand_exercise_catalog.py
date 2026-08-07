#!/usr/bin/env python3
"""Author the RepDB gap-list into VOLA's exercise catalog.

WHAT THIS IS AND IS NOT. The RepDB manifest is a COVERAGE LIST — slug, name,
category, nothing else. Muscles, equipment, load type and movement pattern are
in their commercially licensed half and are not copied here; they are derived
from the movement itself by the ordered rule table below. So this file is the
authoring, and the manifest is only the list of what to author.

WHY RULES RATHER THAN HAND-WRITING 317 ROWS: the mapping is genuinely
determinate for most of them — a barbell curl works the biceps whoever writes
it down — and a rule table is auditable in a way 317 hand-typed rows are not.
Where it is NOT determinate the rule table says so: `UNMATCHED` rows are
reported rather than silently defaulted, because a plausible-looking wrong
muscle is worse than an absent one. Nothing here invents an exercise; every row
corresponds to a real movement named in the manifest.

Read the output's `--report` before trusting it. Every row is derived, and
derived content that nobody read is how a catalog fills with confident errors.
"""
import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]

# NOT AUTHORED, deliberately. The catalog's own `sport: running` family (run,
# treadmill-run, treadmill-walk, …) already owns these activities, and the
# activity envelope is the recording surface for an outdoor run or walk. The
# first pass imported them anyway — as sport=strength — creating exactly the
# "two ways to record a run" the gap analysis had warned against. Gym cardio
# MACHINES (elliptical, rower, air bike) stay: the catalog already models
# `stationary-bike` as a strength-sport locomotion exercise, so those follow
# house precedent rather than contradicting it.
DROP = {
    # Activity envelope / running-sport territory (see note above).
    "Running", "Walking", "Treadmill Running",

    # Outright duplicates of shipped rows under a different spelling or word
    # order. The matcher missed them because it derived equipment from the
    # NAME on the RepDB side but from the structured field on ours, so every
    # bodyweight row whose name does not say "bodyweight" mismatched its own
    # twin. Found by a stemmed nearest-neighbour pass over the final set.
    "Straight Bar Dips",              # = Straight-Bar Dip
    "Single Arm Tricep Pushdown",     # = Single-Arm Triceps Pushdown
    "Mountain Climbers",              # = Mountain Climber
    "Machine Hip Abduction",          # = Hip Abduction Machine
    "Machine Bicep Curl",             # = Machine Biceps Curl
    "Machine Back Extension",         # = Back Extension Machine
    "Isometric Neck Lateral Flexion", # = Neck Lateral Flexion Isometric
    "Burpees",                        # = Burpee
    "Bench Dips",                     # = Bench Dip

    # Same movement as a shipped row in everything but wording — adding them
    # would put two ids on one exercise, permanently, in every logged set.
    "Single-Arm Dumbbell Overhead Tricep Extension",  # = Single-Arm Dumbbell Triceps Extension
    "Dumbbell Tricep Extension",      # = Dumbbell Overhead Triceps Extension
    "Overhead Tricep Extension",      # implement variants exist on both sides; generic adds ambiguity
    "Kettlebell Single Leg Deadlift", # = Single-Leg Kettlebell Romanian Deadlift
    "Seated Smith Machine Shoulder Press",  # Smith shoulder press is seated; = existing
    "Smith Machine Squat",            # = Smith Machine Back Squat
    "T-Bar Row",                      # = T-Bar Landmine Row
    "Cable Chest Press",              # = Standing Cable Chest Press
    "Kneeling Hip Flexor Stretch",    # = Hip Flexor Stretch (kneeling IS the standard form)
    "Kettlebell Sumo High Pull",      # = Kettlebell High Pull
    "Battle Rope Double Slam",        # = Battle Rope Slams
    "Bilateral Dumbbell Wrist Curl",  # = Dumbbell Wrist Curl (bilateral is the default form)
    "Rear Delt Fly",                  # cable/DB variants exist on both sides; generic adds ambiguity
    "Standing Calf Raise",            # bodyweight/DB/barbell variants in this set already cover it
    "Seated Calf Raise",              # = Seated Calf Raise Machine for the gym movement
    "Machine Calf Raise",             # seated/standing machine variants already shipped
    "Lat Pulldown",                   # = Machine Lat Pulldown
    "Hip Adduction",                  # = Hip Adduction Machine

    # REVIEW ROUND 2 — the sixth defect class: duplicates across synonym
    # boundaries the stemmed matcher could not see. The in-line dupe check had
    # quietly rebuilt a WEAKER normaliser than the one already fixed ("ups" is
    # three letters, so the >3-char stemmer never touched it), which is how 19
    # plural twins of shipped rows sailed through. Found by the backend
    # reviewer; every claim verified against the base catalog before acting.
    #
    # Plural twins of shipped singular rows:
    "Archer Pull Ups",                # = archer-pull-up
    "Archer Push Ups",                # = archer-push-up
    "Assisted Pull Ups",              # = assisted-pull-up
    "Chin-Ups",                       # = chin-up
    "Clap Push-Ups",                  # = clap-push-up
    "Close Grip Push Ups",            # = close-grip-push-up
    "Crunches",                       # = crunch
    "Diamond Push Ups",               # = diamond-push-up
    "Handstand Push Ups",             # = handstand-push-up
    "Knee Push Ups",                  # = knee-push-up
    "Neutral Grip Pull Ups",          # = neutral-grip-pull-up
    "Pike Push Ups",                  # = pike-push-up
    "Pseudo Planche Push Ups",        # = pseudo-planche-push-up
    "Reverse Crunches",               # = reverse-crunch
    "Scapular Pull Ups",              # = scapular-pull-up
    "Sit-Ups",                        # = sit-up
    "Step Ups",                       # = step-up
    "V Ups",                          # = v-up
    "Wide Grip Pull Ups",             # = wide-grip-pull-up
    # Brand-vs-generic: the catalog already names this equipment "Suspension":
    "TRX Row",                        # = suspension-row
    "TRX Chest Press",                # = suspension-chest-press
    "TRX Bicep Curl",                 # = suspension-biceps-curl
    "TRX Hamstring Curl",             # = suspension-hamstring-curl
    "TRX Triceps Extension",          # = suspension-triceps-extension
    "TRX Squat",                      # = suspension-squat
    "TRX Pistol Squat",               # = suspension-pistol-squat
    "TRX Face Pull",                  # = suspension-face-pull
    "TRX Y-Fly",                      # = suspension-y-raise
    # Word-order and synonym twins:
    "Single-Arm Dumbbell Row",        # = one-arm-dumbbell-row
    "One-Arm Lat Pulldown",           # = single-arm-lat-pulldown
    "One-Arm Landmine Press",         # = single-arm-landmine-press
    "One Arm Kettlebell Swing",       # = single-arm-kettlebell-swing
    "One-Arm Kettlebell Bottoms-Up Press",  # = bottoms-up-kettlebell-press (one-arm by nature)
    "One-Arm Single-Leg Kettlebell Romanian Deadlift",  # = single-leg-kettlebell-romanian-deadlift
    "Machine Assisted Dips",          # = assisted-dip
    "Hack Squat",                     # = hack-squat-machine (barbell-hack-squat covers the lift)
    "Barbell Deadlift",               # = conventional-deadlift
    "Pec Deck",                       # = pec-deck-fly
    "Machine Chest Fly",              # = pec-deck-fly (and a within-batch twin of Pec Deck)
    "Side Lunge",                     # = lateral-lunge
    "Lunge",                          # = forward-lunge (forward IS the standard form)
    "Rings Inverted Row",             # = ring-row within this very batch
    # Generic rows re-creating the ambiguity this list exists to prevent —
    # implement variants already exist on both sides:
    "Preacher Curl",
    "Reverse Curl",
    "Skull Crusher",
    "Lying Tricep Extension",         # also a within-batch twin of Skull Crusher
    "Single Leg Romanian Deadlift",
    "Suitcase Carry",                 # two suitcase carries already shipped
    "Dumbbell Shoulder Press",        # seated/standing/single-arm all shipped
    "Kettlebell Squat",               # kettlebell-goblet-squat is the standard form
}

# The catalog names this equipment family "Suspension", not the brand. The
# surviving strap rows follow house naming rather than introducing a second
# family for one piece of equipment.
RENAME = {
    "TRX Lunge": "Suspension Lunge",
    "TRX Plank": "Suspension Plank",
    "TRX Side Plank": "Suspension Side Plank",
}
CATALOG = ROOT / "backend/internal/modules/exercise/exercises.json"
GAPLIST = Path(sys.argv[1]) if len(sys.argv) > 1 else ROOT / "scripts/exercise-gaplist.txt"

# ── vocabularies, all taken from the catalog rather than invented ───────────
# movement_pattern and load_type are VALIDATED by the seed (seed.go); an
# unknown value fails the build. Muscles and equipment are not validated, so
# the discipline has to come from here — the catalog's own dominant spellings:
# "quadriceps" not "quads" (114 vs 1), "shoulders" not "delts" (80 vs 9).

EQUIP = [
    ("smith machine", ["smith-machine"]),
    ("stability ball", ["bodyweight", "specialty"]),
    ("medicine ball", ["medicine-ball"]),
    ("plate-loaded", ["plate-loaded-machine"]),
    ("plate loaded", ["plate-loaded-machine"]),
    ("hex bar", ["barbell"]),
    ("ez-bar", ["barbell"]),
    ("ez bar", ["barbell"]),
    ("v-bar", ["cable-stack"]),
    ("battle rope", ["battle-ropes"]),
    ("jump rope", ["jump-rope"]),
    ("landmine", ["landmine-attachment", "barbell"]),
    ("kettlebell", ["kettlebell"]),
    ("dumbbell", ["dumbbells"]),
    ("barbell", ["barbell"]),
    ("cable", ["cable-stack"]),
    ("banded", ["resistance-band"]),
    ("band ", ["resistance-band"]),
    ("trx", ["suspension-trainer"]),
    ("suspension", ["suspension-trainer"]),
    ("ring", ["specialty"]),
    ("sled", ["weighted-sled"]),
    ("plate", ["free-weights"]),  # a weight plate is a free weight, not a bar
    # Multi-word machines BEFORE the generic "machine" entry, which otherwise
    # claims "rowing machine" and "stair climber machine" as selectorized.
    ("treadmill", ["treadmill"]),
    ("elliptical", ["elliptical"]),
    ("stair climber", ["stair-climber"]),
    ("stationary bike", ["upright-bike"]),
    ("air bike", ["upright-bike"]),
    ("rowing machine", ["rower"]),
    ("machine", ["selectorized"]),
    ("pulldown", ["cable-stack"]),
    ("ab wheel", ["specialty"]),
    ("lying leg curl", ["selectorized", "plate-loaded-machine"]),
    ("rope climb", ["specialty"]),
    ("bodyweight", ["bodyweight"]),
    ("captain's chair", ["specialty"]),
    # pec deck / hack squat / leg press / t-bar name a machine or bar without
    # saying "machine" or "barbell" — the first pass defaulted them all to
    # bodyweight, which is how a Pec Deck became a bodyweight exercise.
    ("pec deck", ["selectorized"]),
    ("hack squat", ["plate-loaded-machine"]),
    ("leg press", ["selectorized", "plate-loaded-machine"]),
    ("t bar", ["barbell"]),
    ("wall", ["bodyweight"]),
    ("doorway", ["bodyweight"]),
    # NO "bench" mapping. A bench is furniture, not an implement — mapping it
    # to bodyweight made "Paused Bench Press" a bodyweight-reps exercise.
]

# The classic implementless barbell lifts. Under the free-weights default these
# would be honest but wrong by house convention: the catalog's own pause-deadlift
# and box-squat rows say ["barbell"], and its olympic rows add the platform.
BARBELL_IMPLIED = {
    "bench pull", "behind the neck press", "box squat", "decline bench press",
    "good morning", "overhead squat", "pause deadlift", "pause squat",
    "paused bench press", "paused incline bench press", "paused overhead press",
    "pendlay row", "rack pull", "spoto press", "stiff leg deadlift",
    "sumo deadlift", "sumo squat", "thruster", "wide grip bench press",
    "front squat", "deficit deadlift", "floor press", "strict curl", "cheat curl",
}
OLY_IMPLIED = {"clean", "snatch", "clean and jerk", "split jerk", "push jerk", "muscle snatch",
               "hang clean", "hang power clean"}

# ── the rule table ──────────────────────────────────────────────────────────
# (regex over the folded name, pattern, detail, primary, secondary, load_type)
# ORDER MATTERS: first match wins, so the specific sits above the general.
# "kettlebell swing clean" must hit the clean rule before the swing rule.
R = [
    # --- SPECIFIC OVERRIDES, above everything they would otherwise be
    #     stolen by. Every one of these was a wrong row in a generated
    #     catalog, found by reading the output, not by reasoning about the
    #     table: a "curl" that is not an arm exercise, a "kickback" that is
    #     not a glute one, a "planche" that is a push-up.
    (r"reverse nordic", "isolation", "Knee Extension", ["quadriceps"], [], "reps"),
    (r"hamstring curl|nordic hamstring", "isolation", "Knee Flexion", ["hamstrings"], ["calves"], "reps"),
    (r"tricep kickback|triceps kickback", "isolation", "Elbow Extension", ["triceps"], [], "weight_reps"),
    (r"planche push", "horizontal_push", "Horizontal Push", ["chest"], ["front-delts", "triceps"], "reps"),
    (r"chin tuck", "isolation", "Cervical Flexion", ["neck-flexors"], [], "time"),
    # House convention: the catalog's own upright rows are vertical_pull, and
    # without this the `\brow\b` rule below filed the EZ-bar and Smith
    # variants under horizontal_pull/mid-back.
    (r"upright row", "vertical_pull", "Vertical Pull", ["shoulders", "traps"], ["biceps"], "weight_reps"),
    # A climb is a pull, not cardio. This sat in the conditioning regex and I
    # printed the resulting row in a spot-check without reacting to it.
    (r"rope climb", "vertical_pull", "Vertical Pull", ["lats", "biceps"], ["grip", "core"], "reps"),
    # The catalog's cable-glute-kickback is hinge/Hip Extension; the abduction
    # rule below exists for lateral band work and was wrongly claiming this.
    (r"glute kickback", "hinge", "Hip Extension", ["glutes"], ["hamstrings"], "reps"),
    (r"wall sit", "squat", "Isometric Squat", ["quadriceps"], ["glutes"], "time"),
    # A plyo push-up is an explosive PUSH-UP; the jump rule was claiming it
    # and handing it quadriceps.
    (r"plyo push", "horizontal_push", "Horizontal Push", ["chest"], ["triceps", "front-delts"], "reps"),
    # Front raises are shoulder flexion, not abduction — split from the
    # lateral-raise rule so the detail stops lying.
    (r"front raise", "isolation", "Shoulder Flexion", ["front-delts"], ["upper-chest"], "weight_reps"),
    (r"thruster", "vertical_push", "Squat + Press", ["shoulders", "quadriceps"], ["triceps", "glutes"], "weight_reps"),
    (r"lunge press|lunge and press", "lunge", "Lunge + Press", ["quadriceps", "glutes"], ["shoulders"], "weight_reps"),
    (r"side lying hip adduction", "isolation", "Hip Adduction", ["adductors"], [], "reps"),
    # Round-2 review fixes, each following the house row it was contradicting:
    (r"hack squat calf raise", "isolation", "Ankle Plantarflexion", ["calves"], [], "weight_reps"),
    (r"floor glute bridge press", "horizontal_push", "Horizontal Push", ["chest"], ["triceps", "glutes"], "weight_reps"),
    (r"close grip.*bench press", "horizontal_push", "Horizontal Push", ["triceps"], ["chest", "front-delts"], "weight_reps"),
    (r"side plank", "core", "Anti-Lateral Flexion", ["obliques"], ["glutes"], "time"),
    (r"overhead carry", "carry", "Overhead Carry", ["shoulders", "core"], ["traps", "grip"], "distance"),
    (r"reverse wrist curl", "isolation", "Wrist Extension", ["wrist-extensors"], ["forearms"], "weight_reps"),
    (r"clamshell", "isolation", "Hip External Rotation", ["glute-medius"], ["glutes"], "reps"),
    (r"plate pinch", "isolation", "Grip Hold", ["grip", "forearms"], [], "weight_reps"),
    (r"jefferson curl", "core", "Loaded Spinal Flexion", ["spinal-erectors", "hamstrings"], [], "weight_reps"),
    (r"planche", "core", "Isometric Hold", ["front-delts", "chest"], ["abdominals", "serratus"], "time"),
    (r"front lever|back lever", "core", "Isometric Hold", ["lats", "abdominals"], ["shoulders"], "time"),
    (r"human flag", "core", "Isometric Hold", ["obliques", "lats"], ["shoulders"], "time"),
    (r"ball pike", "core", "Trunk Flexion", ["abdominals"], ["hip-flexors", "shoulders"], "reps"),
    # House files the leg-press family as vertical_push/Press (machine axis,
    # not squat) — copy it rather than argue with it.
    (r"leg press", "vertical_push", "Press", ["quadriceps"], ["glutes"], "weight_reps"),
    (r"dead hang", "vertical_pull", "Isometric Hold", ["grip", "forearms"], ["lats"], "time"),

    # --- stretching and mobility (checked first: "banded lat stretch" is a
    #     stretch, not a pull) ---
    (r"\bstretch\b|\bpose\b|forward fold|spinal twist|standing side bend|downward|straddle|butterfly stretch|cobra|lizard|pigeon|cat stretch",
     "mobility", "Static Stretch", ["mobility"], [], "time"),

    # --- olympic ---
    (r"clean and jerk", "olympic", "Olympic Pull", ["glutes", "quadriceps"], ["shoulders", "traps"], "weight_reps"),
    (r"\bsnatch\b", "olympic", "Olympic Pull", ["glutes", "hamstrings"], ["traps", "shoulders", "core"], "weight_reps"),
    (r"\bclean\b", "olympic", "Olympic Pull", ["glutes", "quadriceps"], ["traps", "hamstrings", "core"], "weight_reps"),
    (r"split jerk|push jerk|\bjerk\b", "olympic", "Olympic Press", ["shoulders"], ["triceps", "quadriceps"], "weight_reps"),

    # --- carries ---
    (r"farmer|suitcase carry|overhead carry|\bcarry\b", "carry", "Carry", ["grip", "traps"], ["core", "legs"], "distance"),

    # --- locomotion / cardio ---
    (r"treadmill|elliptical|stair climber|stationary bike|air bike|rowing machine|\brunning\b|\bwalking\b",
     "locomotion", "Cyclical", ["cardiorespiratory"], ["legs"], "distance_time"),
    (r"jump rope|battle rope|burpee|jumping jack|high knees|mountain climber|bear crawl",
     "locomotion", "Conditioning", ["cardiorespiratory"], ["full-body"], "time"),

    # --- jumps / plyometrics ---
    (r"box jump|jump squat|plyo lunge", "jump", "Jump", ["quadriceps", "glutes"], ["calves"], "reps"),

    # --- core (before the pull/push rules: "hanging leg raise" is core) ---
    (r"plank", "core", "Anti-Extension", ["abdominals"], ["shoulders", "glutes"], "time"),
    (r"hollow body|l sit|l-sit|v-sit|dead hang|ring dead hang|bird dog|chin tuck|dragon flag|front lever|back lever|human flag|planche",
     "core", "Isometric Hold", ["abdominals"], ["shoulders", "lats"], "time"),
    (r"crunch|sit-up|sit up|jackknife|cocoon|flutter kick|scissor kick|toes to bar|v ups|v-ups|leg raise|knee raise|leg pull-in|hanging pike|ball pike|knee tuck",
     "core", "Trunk Flexion", ["abdominals"], ["hip-flexors"], "reps"),
    (r"pallof", "rotation", "Anti-Rotation", ["obliques"], ["core"], "reps"),
    (r"russian twist|windmill|side bend|wood ?chop", "rotation", "Rotation", ["obliques"], ["core"], "reps"),
    (r"superman|back extension|reverse plank|thoracic bridge|jefferson curl",
     "core", "Trunk Extension", ["spinal-erectors", "lower-back"], ["glutes"], "reps"),

    # --- hinge ---
    (r"romanian deadlift|\brdl\b|stiff leg|good morning|jefferson", "hinge", "Hip Hinge", ["hamstrings"], ["glutes", "lower-back"], "weight_reps"),
    (r"hip thrust|glute bridge|glute drive", "hinge", "Hip Extension", ["glutes"], ["hamstrings"], "weight_reps"),
    (r"deadlift|rack pull|swing|sumo high pull|kickstand", "hinge", "Hip Hinge", ["hamstrings", "glutes"], ["lower-back", "traps"], "weight_reps"),
    (r"nordic hamstring", "hinge", "Knee Flexion", ["hamstrings"], ["calves"], "reps"),
    (r"kickback|fire hydrant|clamshell|hip abduction|lateral walk|sumo walk|monster walk",
     "isolation", "Hip Abduction", ["glutes", "glute-medius"], [], "reps"),
    (r"hip adduction", "isolation", "Hip Adduction", ["adductors"], [], "weight_reps"),

    # --- squat / lunge ---
    (r"bulgarian|split squat|lunge|step up|cossack", "lunge", "Lunge", ["quadriceps", "glutes"], ["hamstrings"], "weight_reps"),
    (r"pistol squat|wall sit|heel-elevated squat|squat", "squat", "Squat", ["quadriceps"], ["glutes", "core"], "weight_reps"),
    (r"leg press", "squat", "Squat", ["quadriceps"], ["glutes"], "weight_reps"),
    (r"terminal knee extension|leg extension", "isolation", "Knee Extension", ["quadriceps"], [], "weight_reps"),
    (r"leg curl", "isolation", "Knee Flexion", ["hamstrings"], ["calves"], "weight_reps"),
    (r"calf raise", "isolation", "Ankle Plantarflexion", ["calves"], [], "weight_reps"),

    # --- vertical pull ---
    (r"pull-up|pull up|pullup|chin-up|chin up|muscle-up|muscle up|lat pulldown|pulldown",
     "vertical_pull", "Vertical Pull", ["lats"], ["biceps", "mid-back"], "reps"),

    # --- horizontal pull ---
    (r"face pull|rear delt row|rear delt fly|reverse fly|y-fly", "isolation", "Shoulder Horizontal Abduction", ["rear-delts"], ["mid-traps", "rhomboids"], "weight_reps"),
    (r"\brow\b|bench pull|inverted row", "horizontal_pull", "Horizontal Pull", ["mid-back", "lats"], ["biceps", "rear-delts"], "weight_reps"),
    (r"shrug", "isolation", "Scapular Elevation", ["traps"], ["forearms"], "weight_reps"),
    (r"pull apart|band pull", "isolation", "Shoulder Horizontal Abduction", ["rear-delts"], ["mid-traps"], "reps"),
    (r"straight-arm pulldown|straight arm pulldown|pullover", "isolation", "Shoulder Extension", ["lats"], ["chest", "triceps"], "weight_reps"),

    # --- vertical push ---
    (r"handstand push|pike push", "vertical_push", "Vertical Push", ["shoulders"], ["triceps", "upper-chest"], "reps"),
    (r"overhead press|shoulder press|push press|behind the neck press|thruster|\bohp\b|arnold|bottoms-up press|halo",
     "vertical_push", "Vertical Push", ["shoulders"], ["triceps", "upper-chest"], "weight_reps"),

    # --- horizontal push ---
    (r"\bdip\b|\bdips\b", "vertical_push", "Dip", ["lower-chest", "triceps"], ["front-delts"], "reps"),
    (r"push-up|push up|pushup", "horizontal_push", "Horizontal Push", ["chest"], ["triceps", "front-delts"], "reps"),
    (r"bench press|chest press|floor[a-z ]*press|spoto|svend press", "horizontal_push", "Horizontal Push", ["chest"], ["triceps", "front-delts"], "weight_reps"),
    (r"\bfly\b|pec deck|chest fly", "isolation", "Shoulder Horizontal Adduction", ["chest"], ["front-delts"], "weight_reps"),

    # --- arms ---
    (r"tricep|triceps|skull crusher|pushdown|overhead extension|kickback",
     "isolation", "Elbow Extension", ["triceps"], [], "weight_reps"),
    (r"wrist curl|wrist roller|plate pinch", "isolation", "Wrist Flexion", ["wrist-flexors", "forearms"], ["grip"], "weight_reps"),
    (r"reverse curl|hammer curl|preacher|spider curl|concentration curl|drag curl|cheat curl|strict curl|\bcurl\b",
     "isolation", "Elbow Flexion", ["biceps"], ["forearms", "brachialis"], "weight_reps"),

    # --- shoulders isolation ---
    (r"lateral raise|front raise|upright row|external rotation",
     "isolation", "Shoulder Abduction", ["shoulders"], ["traps"], "weight_reps"),

    # --- neck ---
    (r"neck", "isolation", "Cervical Flexion", ["neck-flexors", "lateral-neck"], [], "time"),

    # --- odds and ends ---
    (r"landmine press", "vertical_push", "Vertical Push", ["shoulders"], ["upper-chest", "triceps", "core"], "weight_reps"),
    (r"hip bridge", "hinge", "Hip Extension", ["glutes"], ["hamstrings"], "reps"),
    (r"ab wheel|rollout", "core", "Anti-Extension", ["abdominals"], ["lats", "shoulders"], "reps"),
    (r"heel-to-toe|heel to toe", "locomotion", "Gait", ["ankles"], ["core"], "time"),
    (r"medicine ball slam|slam", "rotation", "Power", ["core"], ["lats", "shoulders"], "reps"),
    (r"turkish get", "core", "Loaded Carry", ["core", "shoulders"], ["glutes"], "reps"),
]

# A stretch has a TARGET, and the name always says what it is. The first pass
# used a blanket `["mobility"]`, which is not a muscle — `exerciseFacets.ts`
# groups the Library's filters by muscle, so all 39 stretches would have been
# unfilterable. The mobile suite caught it (`every primary muscle in the catalog
# belongs to a group`), which is the test doing exactly its job against a
# placeholder I should not have written.
#
# Values are from MUSCLE_GROUPS, not invented: anything outside that set is
# invisible to the same filter.
MOBILITY_TARGET = [
    ("knee to chest", ["lower-back"], ["glutes"]),
    ("adductor", ["adductors"], []),
    ("ankle", ["ankles"], ["calves"]),
    ("calf", ["calves"], ["soleus"]),
    ("chest", ["chest"], ["front-delts"]),
    ("figure 4", ["glutes"], ["hip-rotators"]),
    ("glute", ["glutes"], ["hip-rotators"]),
    ("hamstring", ["hamstrings"], ["calves"]),
    ("it band", ["hips"], ["glute-medius"]),
    ("lat", ["lats"], ["upper-back"]),
    ("rear delt", ["rear-delts"], ["mid-traps"]),
    ("tricep", ["triceps"], ["lats"]),
    ("hip flexor", ["hip-flexors"], ["quadriceps"]),
    ("wrist", ["wrist-flexors"], ["forearms"]),
    ("neck", ["lateral-neck"], ["upper-traps"]),
    ("quad", ["quadriceps"], ["hip-flexors"]),
    ("shoulder", ["shoulders"], ["chest"]),
    ("couch", ["hip-flexors"], ["quadriceps"]),
    ("bulgarian split", ["hip-flexors"], ["quadriceps"]),
    ("spinal twist", ["thoracic-spine"], ["obliques"]),
    ("cat stretch", ["thoracic-spine"], ["spinal-erectors"]),
    ("cobra", ["abdominals"], ["hip-flexors"]),
    ("downward", ["hamstrings"], ["calves", "lats"]),
    ("lizard", ["hip-flexors"], ["adductors"]),
    ("pigeon", ["glutes"], ["hip-rotators"]),
    ("butterfly", ["adductors"], []),
    ("straddle", ["adductors"], ["hamstrings"]),
    ("forward fold", ["hamstrings"], ["spinal-erectors"]),
    ("childs pose", ["lats"], ["thoracic-spine"]),
    ("side bend", ["obliques"], ["lats"]),
]


UNILATERAL = re.compile(
    r"single[- ]arm|single[- ]leg|one[- ]arm|one arm|pistol|side[- ]lying|"
    r"suitcase|bulgarian|split squat|windmill|kickstand|concentration curl|"
    r"side plank|fire hydrant|"
    r"archer|cossack"
)


def fold(s: str) -> str:
    return re.sub(r"\s+", " ", s.replace("-", " ").replace("'", "")).lower().strip()


def slugify(name: str) -> str:
    s = fold(name).replace("+", " plus ")
    s = re.sub(r"[^a-z0-9]+", "-", s).strip("-")
    return s


def equipment_for(name: str):
    # WHOLE WORDS. Substring matching filed "Bench Hamstring Stretch" under
    # ring equipment ("hamstRING") — the same bug class the technique matcher
    # had with hyphens, wearing different clothes.
    f = " " + fold(name) + " "
    for pat, eq in EQUIP:
        if re.search(r"\b" + re.escape(fold(pat)) + r"s?\b", f):
            return list(eq)
    return None  # build() decides from the movement — see the policy there


def relax_hyphens(pattern: str) -> str:
    """Let a hyphen written in a rule match the space `fold` produced.

    Hyphens in a rule can NEVER match on their own: `fold` turns them into
    spaces before `classify` runs. Most rules happened to list both spellings
    and so hid it; "v-sit", "l-sit", "bottoms-up press" and "leg pull-in" did
    not, and fell through to UNMATCHED.

    CHARACTER-CLASS AWARE, because the naive `.replace("-", "[- ]")` turned
    `floor[a-z ]*press` into `floor[a[- ]z ]*press` — an unparseable pattern
    that took the whole script down. A hyphen inside `[...]` is a RANGE and
    must be left alone.
    """
    out, in_class, i = [], False, 0
    while i < len(pattern):
        c = pattern[i]
        if c == "\\" and i + 1 < len(pattern):
            out.append(pattern[i:i + 2])
            i += 2
            continue
        if c == "[":
            in_class = True
        elif c == "]":
            in_class = False
        out.append("[- ]" if (c == "-" and not in_class) else c)
        i += 1
    return "".join(out)


# Compiled once, which also means a malformed rule fails at import rather than
# part-way through a 337-row run.
RULES = [(re.compile(relax_hyphens(pat)), mp, d, pr, se, lo) for pat, mp, d, pr, se, lo in R]


def classify(name: str):
    f = fold(name)
    for rx, mp, detail, prim, sec, load in RULES:
        if rx.search(f):
            return mp, detail, list(prim), list(sec), load
    return None


def build(name: str, category: str):
    hit = classify(name)
    if hit is None:
        return None
    mp, detail, prim, sec, load = hit
    eq = equipment_for(name)
    f = fold(name)

    # EQUIPMENT POLICY for names that name no implement. The first pass
    # defaulted everything to bodyweight, then downgraded weight_reps to reps —
    # which turned Preacher Curl, Svend Press and every generic loaded lift
    # into a bodyweight-reps exercise. The movement decides:
    #   * olympic-implied  -> barbell + platform (house: olympic rows)
    #   * barbell-implied  -> barbell            (house: pause-deadlift, box-squat)
    #   * loaded movement  -> free-weights, load kept
    #   * everything else  -> bodyweight
    if eq is None:
        if f in OLY_IMPLIED:
            eq = ["barbell", "olympic-barbell-platform"]
        elif f in BARBELL_IMPLIED:
            eq = ["barbell"]
        elif f in {"lunge", "side lunge", "step ups"}:
            # Generic locomotor strength moves are bodyweight until a name
            # says otherwise — a plain Lunge is not a free-weights exercise.
            eq = ["bodyweight"]
        elif mp == "carry":
            # A carry with no named implement still needs something to carry.
            eq = ["free-weights"]
        elif load == "weight_reps":
            eq = ["free-weights"]
        else:
            eq = ["bodyweight"]

    # LOAD POLICY, from the read of the full output rather than first
    # principles. A loaded implement means the load is the number being
    # trained (a Dumbbell Side Bend is weight_reps however the rule spelled
    # it); no loaded implement means reps/time however ambitious the movement
    # (a TRX Row or Ring Row is graded in reps, not kilos). "Assisted" is
    # excluded from the upgrade — the band assists, it does not load.
    LOADED = {"dumbbells", "kettlebell", "barbell", "cable-stack", "free-weights",
              "plate-loaded-machine", "selectorized", "smith-machine",
              "landmine-attachment", "medicine-ball", "weighted-sled", "resistance-band"}
    has_load = any(e in LOADED for e in eq)
    if load == "reps" and has_load and mp not in ("mobility", "locomotion", "jump") and "assisted" not in f:
        load = "weight_reps"
    if load == "weight_reps" and not has_load:
        load = "reps"

    # "Weighted X" means the added load IS the number being trained. The first
    # pass left Weighted Dips as bare reps because its equipment was bodyweight.
    if "weighted" in f:
        load = "weight_reps"
        if eq == ["bodyweight"]:
            eq = ["bodyweight", "free-weights"]
    # Machine-assisted work is loaded (the assistance weight), matching the
    # catalog's own assisted-dip row; band assistance is not.
    if "assisted" in f and "band" not in f:
        eq = ["selectorized", "plate-loaded-machine"]
        load = "weight_reps"

    # Mobility rows carry the mobility-area tag, matching the catalog's own
    # stretch rows (e.g. Cobra Stretch).
    if mp == "mobility" and "mobility-area" not in eq:
        eq = eq + ["mobility-area"] if eq != ["free-weights"] else ["bodyweight", "mobility-area"]

    # Resolve the blanket mobility placeholder to the target the name states.
    if prim == ["mobility"]:
        f = fold(name)
        for key, p_m, s_m in MOBILITY_TARGET:
            if key in f:
                prim, sec = list(p_m), list(s_m)
                break
        else:
            # No body part named. Left for a human rather than guessed — a
            # stretch filed under the wrong muscle is worse than one a filter
            # does not surface, and the report makes it visible.
            prim, sec = [], []

    return {
        "id": slugify(name),
        "name": name,
        "sport": "strength",
        "movement_pattern": mp,
        "movement_pattern_detail": detail,
        "primary_muscles": prim,
        "secondary_muscles": sec,
        "equipment": eq,
        "load_type": load,
        "is_unilateral": bool(UNILATERAL.search(fold(name))),
        # Deliberately empty, matching 443 of the 504 rows already shipped.
        # Writing 317 instruction paragraphs from a coverage manifest would be
        # inventing content, and the field is optional everywhere it renders.
        "instructions": "",
        "media": [],
    }


def main():
    rows = []
    unmatched = []
    for line in GAPLIST.read_text().splitlines():
        if not line.strip():
            continue
        name, category = line.rsplit("|", 1)
        name = RENAME.get(name.strip(), name.strip())
        if name in DROP:
            print(f"  DROPPED    {name}", file=sys.stderr)
            continue
        r = build(name, category.strip())
        if r is None:
            unmatched.append(name.strip())
        else:
            rows.append(r)

    noMuscle = [r["name"] for r in rows if not r["primary_muscles"]]
    print(f"authored: {len(rows)}   unmatched (no rule): {len(unmatched)}   "
          f"no primary muscle: {len(noMuscle)}", file=sys.stderr)
    for n in noMuscle:
        print(f"  NO-MUSCLE  {n}", file=sys.stderr)
    for u in unmatched:
        print(f"  UNMATCHED  {u}", file=sys.stderr)
    json.dump(rows, sys.stdout, indent=2, ensure_ascii=False)


if __name__ == "__main__":
    main()
