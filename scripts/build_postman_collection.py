#!/usr/bin/env python3
"""Generate a Postman collection from contracts/public.openapi.yaml.

    python3 scripts/build_postman_collection.py

Generated rather than hand-written on purpose: the spec is the contract, and a
hand-maintained collection drifts from it silently — you find out when a
request 404s against a route renamed months ago. Re-run this after any contract
change instead of editing the JSON.

Python rather than Node so it needs no dependency the repo doesn't already
have; a build script isn't worth a root package.

What it adds on top of a plain conversion:
  - Collection-level bearer auth, so every request inherits {{token}}.
  - A {{baseUrl}} variable with local and staging both written down.
  - Runnable example bodies, so a POST is more than an empty shell.
  - Client-generated UUIDs via Postman's {{$guid}}, because create is
    idempotent on a caller-supplied id — that is what makes the mobile
    client's offline retries safe, and a collection that omits it teaches
    the wrong thing.
"""

import json
import pathlib
import re
import sys

try:
    import yaml
except ImportError:
    sys.exit("PyYAML is required: pip install pyyaml")

ROOT = pathlib.Path(__file__).resolve().parent.parent
SPEC = ROOT / "contracts/public.openapi.yaml"
OUT = ROOT / "contracts/vola.postman_collection.json"

STAGING = "https://apivola-fitness-platform-staging.up.railway.app/v1"


def folder_for(p: str) -> str:
    """Group by product area, so the collection reads like the app not the router."""
    if p.startswith("/admin"):
        return "Admin"
    if p.startswith("/sessions/suggestions"):
        return "Progression"
    if p.startswith("/records"):
        return "Records"
    if p.startswith("/sessions/history"):
        return "History"
    if p.startswith("/sessions"):
        return "Sessions"
    if p.startswith("/workouts"):
        return "Workouts"
    if p.startswith(("/exercises", "/techniques")):
        return "Catalog"
    if p.startswith("/profile") or p == "/me":
        return "Profile & auth"
    if p.startswith("/activities"):
        return "Activities"
    return "Service"


def working_set(exercise, position, reps, weight, rir=None, set_type="working"):
    return {
        "exercise_id": exercise,
        "position": position,
        "set_type": set_type,
        "reps": reps,
        "weight_kg": weight,
        "rir": rir,
        "rpe": None,
        "completed": True,
        "notes": "",
    }


# Bodies the spec doesn't spell out concretely enough to just hit Send on.
#
# `{{$guid}}` is Postman's per-send UUID, so each send creates a new row.
# Replace it with a fixed value and send twice to watch the idempotent create.
BODIES = {
    "POST /profile": {
        "display_name": "Test Athlete",
        "date_of_birth": "1992-04-18",
        "sex": "female",
    },
    "PATCH /profile": {"running_enabled": True},
    "POST /activities": {
        "id": "{{$guid}}",
        "kind": "bjj_session",
        "occurred_at": "{{$isoTimestamp}}",
        "notes": "Rolled 6 rounds",
        "details": {"rounds": 6},
    },
    "POST /workouts": {
        "id": "{{$guid}}",
        "name": "Lower A",
        "sport": "strength",
        "goal": "hypertrophy",
        "visibility": "private",
        "notes": "",
    },
    "PUT /workouts/{workoutID}/items": {
        "items": [
            {
                "exercise_id": "back-squat",
                "position": 0,
                "target_sets": 3,
                "target_reps": 8,
                "target_weight_kg": 100,
                "target_seconds": None,
                "target_distance_m": None,
                "notes": "",
            }
        ]
    },
    "POST /sessions": {
        "id": "{{$guid}}",
        "sport": "strength",
        "name": "Lower A",
        "started_at": "{{$isoTimestamp}}",
        # A warm-up plus two working sets: the warm-up is here deliberately,
        # because it must count toward no working-volume measure.
        "sets": [
            working_set("back-squat", 0, 8, 60, set_type="warmup"),
            working_set("back-squat", 1, 8, 100, rir=2),
            working_set("back-squat", 2, 8, 100, rir=2),
        ],
    },
    "PUT /sessions/{sessionID}/sets": {
        "sets": [working_set("back-squat", 0, 8, 100, rir=2)]
    },
    "POST /sessions/{sessionID}/finish": {},
    "PUT /records/pinned": {"exercise_ids": ["back-squat", "bench-press"]},
    "PUT /profile/exercise-units/{exerciseID}": {"unit_system": "imperial"},
}

# Query values worth pre-filling so a request is runnable as-is.
QUERY_DEFAULTS = {
    "exercise_ids": "back-squat,bench-press",
    "goal": "hypertrophy",
    "sport": "strength",
    "scope": "mine",
    "tz": "Europe/Berlin",
    "limit": "20",
    "offset": "0",
    "from": "{{sevenDaysAgo}}",
    "to": "{{today}}",
}

ORDER = [
    "Service",
    "Profile & auth",
    "Catalog",
    "Workouts",
    "Sessions",
    "Progression",
    "Records",
    "History",
    "Activities",
    "Admin",
]

DESCRIPTION = f"""Generated from `contracts/public.openapi.yaml` by
`scripts/build_postman_collection.py`. Re-run it after any contract change
rather than editing this file — a hand-maintained collection drifts from the
spec silently.

## Setup

1. Set `baseUrl` on the collection:
   - local:   `http://localhost:8080/v1`
   - staging: `{STAGING}`
2. Set `token` to a Clerk session JWT. Every route except `/healthz` returns
   401 without one.

### Getting a token

The API verifies Clerk-issued JWTs via JWKS, so there is no password grant to
call. Easiest path: sign in to the web app, open DevTools -> Application ->
Cookies and copy the `__session` value. It is short-lived, so expect to
refresh it.

`GET /me` is the quickest check that a token works — it echoes back the
subject the API resolved you to.

## Conventions

- Every route is prefixed `/v1` (already in `baseUrl`).
- Errors are `{{"error": {{"code": "...", "message": "..."}}}}`. Branch on
  `code`; messages are not part of the contract.
- JSON is snake_case; timestamps are RFC3339.
- Weights are **always kilograms on the wire**. `unit_system` is display only.
- Create is idempotent on a **client-supplied id** — that is what makes the
  mobile client's offline sync retries safe. The bodies here use `{{{{$guid}}}}`
  for a fresh row each send; swap in a fixed id and send twice to see the
  idempotency.
- Warm-up sets and sets with `completed: false` count toward no working-volume
  measure. The `POST /sessions` body includes a warm-up on purpose.
"""


def main() -> None:
    spec = yaml.safe_load(SPEC.read_text())
    folders: dict[str, list] = {}

    for path, ops in spec["paths"].items():
        for method, op in ops.items():
            if method not in ("get", "post", "put", "patch", "delete"):
                continue

            key = f"{method.upper()} {path}"
            query = []
            for q in op.get("parameters", []):
                if q.get("in") != "query":
                    continue
                name = q["name"]
                desc = (q.get("description") or "").strip().split("\n")[0]
                query.append(
                    {
                        "key": name,
                        "value": QUERY_DEFAULTS.get(name, ""),
                        # Only pre-fill what makes the request runnable; the
                        # rest are present but off, so the URL isn't a wall of
                        # empty params.
                        "disabled": not (q.get("required") or name in QUERY_DEFAULTS),
                        "description": desc,
                    }
                )

            # Path params become Postman :variables, which it surfaces in its
            # own editor rather than burying inside the URL string.
            postman_path = re.sub(r"\{(\w+)\}", r":\1", path)
            path_vars = [
                {
                    "key": m,
                    "value": "back-squat" if m == "exerciseID" else "",
                    "description": f"Path parameter: {m}",
                }
                for m in re.findall(r"\{(\w+)\}", path)
            ]

            request = {
                "method": method.upper(),
                "header": [],
                "url": {
                    "raw": "{{baseUrl}}" + postman_path,
                    "host": ["{{baseUrl}}"],
                    "path": postman_path.lstrip("/").split("/"),
                    "query": query,
                    "variable": path_vars,
                },
                "description": (op.get("description") or "").strip(),
            }

            if key in BODIES:
                request["header"].append(
                    {"key": "Content-Type", "value": "application/json"}
                )
                request["body"] = {
                    "mode": "raw",
                    "raw": json.dumps(BODIES[key], indent=2),
                    "options": {"raw": {"language": "json"}},
                }

            # /healthz is the only public route.
            if path == "/healthz":
                request["auth"] = {"type": "noauth"}

            folders.setdefault(folder_for(path), []).append(
                {"name": op.get("summary") or key, "request": request}
            )

    collection = {
        "info": {
            "name": "VOLA API (v1)",
            "description": DESCRIPTION,
            "schema": "https://schema.getpostman.com/json/collection/v2.1.0/collection.json",
        },
        "auth": {
            "type": "bearer",
            "bearer": [{"key": "token", "value": "{{token}}", "type": "string"}],
        },
        "variable": [
            {
                "key": "baseUrl",
                "value": "http://localhost:8080/v1",
                "description": f"Local. Staging: {STAGING}",
            },
            {
                "key": "token",
                "value": "",
                "description": "Clerk session JWT — see the collection description.",
            },
        ],
        "event": [
            {
                # Dates for the history and listing ranges, so those requests
                # run without hand-editing an ISO date every time.
                "listen": "prerequest",
                "script": {
                    "type": "text/javascript",
                    "exec": [
                        "const iso = (d) => d.toISOString().slice(0, 10);",
                        "const now = new Date();",
                        "pm.collectionVariables.set('today', iso(now));",
                        "pm.collectionVariables.set('sevenDaysAgo', iso(new Date(now - 7 * 864e5)));",
                    ],
                },
            }
        ],
        "item": [
            {"name": f, "item": folders[f]} for f in ORDER if f in folders
        ],
    }

    OUT.write_text(json.dumps(collection, indent=2) + "\n")
    total = sum(len(v) for v in folders.values())
    print(f"wrote {OUT.relative_to(ROOT)} — {total} requests in {len(folders)} folders")


if __name__ == "__main__":
    main()
