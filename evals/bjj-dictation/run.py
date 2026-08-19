#!/usr/bin/env python3
"""Run the dictation corpus against a model and score it.

    python3 evals/bjj-dictation/run.py --model gpt-5.6-luna
    python3 evals/bjj-dictation/run.py --model gpt-5.4-nano --out results/nano.json
    python3 evals/bjj-dictation/run.py --dry-run          # build everything, call nothing

THIS SPENDS MONEY. Every non-dry run is ~33 live calls. The key is read from
`backend/.env` (never printed, never written to a result file).

Stdlib only, matching `scripts/*.py`: one POST is one `urllib.request`, and the
alternative is a dependency on a machine that only ever needs to run this by
hand. Not wired into `verify` or CI for the obvious reason.

WHAT IS SCORED AND WHAT IS NOT. The three metrics in the README, in its order:
invention rate first, then tag F1, then scalar exactness. `note` and `body_note`
are NOT scored — they are free text, and an automated comparison of them would
be measuring paraphrase rather than extraction. Read them in the result file.

THE APP'S OWN POST-PROCESSING RUNS BEFORE SCORING, and this is the part worth
understanding before trusting a number. The spec has the model emit a
`technique_id` that Go then validates against the catalog: an unknown id is
moved to `unresolved`, never guessed at and never silently dropped, and a
resolved tag's category and position are DERIVED from the catalog entry rather
than taken from the model. So the same happens here. Scoring the raw response
would grade the model on fields the app never lets it choose, and would count a
hallucinated id as a wrong id rather than as what the athlete actually sees,
which is an unresolved phrase.
"""

import argparse
import importlib.util
import json
import os
import ssl
import sys
import time
import urllib.error
import urllib.request
from collections import Counter
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent.parent
sys.path.insert(0, str(HERE))

import prompt as P  # noqa: E402  (after sys.path)

CASES = HERE / "cases.json"
TECHNIQUES = ROOT / "backend" / "internal" / "modules" / "technique" / "techniques.json"
POSITIONS = ROOT / "backend" / "internal" / "modules" / "technique" / "positions.json"
ENV_FILE = ROOT / "backend" / ".env"
SCALARS = ("kind", "gi", "rounds", "round_minutes", "session_rpe")


def _validator():
    """Reuse `family_of` and `to_tag_category` from the validator.

    Imported rather than reimplemented. They are already a copy of the
    TypeScript in `bjjSession.ts`; a second copy here would be the third, and
    the whole reason the validator exists is that a derived field getting out
    of step scores a correct model as wrong with nothing noticing.
    """
    path = ROOT / "scripts" / "check-dictation-evals.py"
    spec = importlib.util.spec_from_file_location("check_dictation_evals", path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


V = _validator()


def env_files() -> list[Path]:
    """`backend/.env`, and the PRIMARY checkout's copy when run from a worktree.

    A worktree never has one: `backend/.env` is gitignored, so it exists only in
    the tree it was created in. CLAUDE.md records the same trap costing a mobile
    build its Clerk key, silently, because a missing value is an empty string
    rather than an error. Here it is only a confusing "key is not set" in a tree
    that plainly has the repo in it — so resolve the main checkout rather than
    make the next person work it out.
    """
    paths = [ENV_FILE]
    dotgit = ROOT / ".git"
    if dotgit.is_file():  # a worktree: `.git` is a file pointing at the real dir
        text = dotgit.read_text().strip()
        if text.startswith("gitdir:"):
            gitdir = Path(text.split(":", 1)[1].strip())
            # .../<primary>/.git/worktrees/<name>  ->  .../<primary>
            for parent in gitdir.parents:
                if parent.name == ".git":
                    paths.append(parent.parent / "backend" / ".env")
                    break
    return paths


def api_key(env_var: str) -> str:
    """From the process env, else an env file. Never printed, never stored."""
    if os.environ.get(env_var):
        return os.environ[env_var]
    for path in env_files():
        if not path.exists():
            continue
        for line in path.read_text().splitlines():
            k, _, v = line.partition("=")
            if k.strip() == env_var:
                return v.strip().strip("'\"")
    sys.exit(
        f"{env_var} is not set, and not in " +
        " or ".join(str(p) for p in env_files())
    )


# ---------------------------------------------------------------- the call


def tls_context() -> "ssl.SSLContext":
    """A verifying context that works on a python.org build with no certs.

    The macOS python.org installer ships an `Install Certificates.command` that
    many machines never run, leaving OpenSSL pointed at an
    `etc/openssl/cert.pem` inside the framework that does not exist — so every
    HTTPS call fails with CERTIFICATE_VERIFY_FAILED and reads like a network
    fault. macOS keeps a real bundle at /etc/ssl/cert.pem, so fall back to it.

    Verification is never disabled. An eval runner that silently stopped
    checking certificates to get past a local setup problem would be a worse
    bug than the one it worked around.
    """
    ctx = ssl.create_default_context()
    if ctx.cert_store_stats()["x509_ca"] == 0:
        system_bundle = Path("/etc/ssl/cert.pem")
        if not system_bundle.exists():
            sys.exit(
                "no CA certificates available: the default store is empty and "
                "/etc/ssl/cert.pem does not exist. On a python.org build, run "
                "'Install Certificates.command' from the Python 3.x folder in "
                "/Applications."
            )
        ctx.load_verify_locations(cafile=str(system_bundle))
    return ctx


TLS = tls_context()


def call_openai(model: str, system: str, user: str, schema: dict, key: str) -> dict:
    body = {
        "model": model,
        "messages": [
            {"role": "system", "content": system},
            {"role": "user", "content": user},
        ],
        "response_format": {
            "type": "json_schema",
            "json_schema": {"name": "session_draft", "strict": True, "schema": schema},
        },
    }
    req = urllib.request.Request(
        "https://api.openai.com/v1/chat/completions",
        data=json.dumps(body).encode(),
        headers={"Authorization": f"Bearer {key}", "Content-Type": "application/json"},
    )
    last = ""
    for attempt in range(4):
        try:
            with urllib.request.urlopen(req, timeout=180, context=TLS) as r:
                resp = json.loads(r.read())
            break
        except urllib.error.HTTPError as e:
            detail = e.read().decode()[:400]
            # 429 and 5xx are worth another go; a 400 is our request and never
            # gets better by repeating it.
            if e.code not in (429, 500, 502, 503, 504) or attempt == 3:
                return {"error": f"HTTP {e.code}: {detail}"}
            last = f"HTTP {e.code}"
            time.sleep(2 ** attempt)
        except (urllib.error.URLError, TimeoutError) as e:
            if attempt == 3:
                return {"error": f"{type(e).__name__}: {e}"}
            last = str(e)
            time.sleep(2 ** attempt)
    else:
        return {"error": f"gave up after retries: {last}"}

    choice = (resp.get("choices") or [{}])[0]
    msg = choice.get("message", {})
    # Refusal is a FIELD on the message here, not a stop reason. Code ported
    # from the Anthropic shape without reading the API treats it as an empty
    # response and reports an outage.
    if msg.get("refusal"):
        return {"error": "refused", "refusal": msg["refusal"], "usage": resp.get("usage")}
    if choice.get("finish_reason") == "length":
        # Deterministic on retry — same input, same truncation, same bill.
        return {"error": "truncated", "usage": resp.get("usage")}
    try:
        draft = json.loads(msg.get("content") or "")
    except json.JSONDecodeError as e:
        return {"error": f"unparseable JSON: {e}", "usage": resp.get("usage")}
    return {"draft": draft, "usage": resp.get("usage"), "model": resp.get("model")}


# ------------------------------------------------------- the app's own pass


def postprocess(draft: dict, techniques: dict, families: list[str]) -> dict:
    """What Go does to the response before the athlete ever sees it."""
    out = dict(draft)
    tags, unresolved = [], list(draft.get("unresolved") or [])
    for tag in draft.get("tags") or []:
        t = dict(tag)
        tid = t.get("technique_id")
        if tid and tid not in techniques:
            # An id that does not exist. Not dropped, not guessed at: it becomes
            # a phrase the athlete resolves with the normal picker.
            unresolved.append(
                {"phrase": tid, "category": t.get("category"), "event": t.get("event")}
            )
            t["technique_id"] = None
            t["invented_id"] = tid
        elif tid:
            lib = techniques[tid]
            t["category"] = V.to_tag_category(lib["category"])
            t["position"] = V.family_of(lib.get("position", ""), families)
        if not isinstance(t.get("count"), int) or t["count"] < 1:
            t["count"] = 1
        tags.append(t)
    out["tags"], out["unresolved"] = tags, unresolved
    return out


# ------------------------------------------------------------- the scoring


def _filled(draft: dict, path: str) -> bool:
    """Is the field `must_not` names non-empty in this draft?"""
    if path == "tags":
        return bool(draft.get("tags"))
    if path.startswith("tags[") and "]." in path:
        idx = int(path[len("tags["):path.index("]")])
        field = path.split("].", 1)[1]
        tags = draft.get("tags") or []
        return idx < len(tags) and tags[idx].get(field) not in (None, "")
    return draft.get(path) not in (None, "")


def _tuples(tags: list[dict]) -> Counter:
    """Tags as a multiset, expanded by count so repeats are comparable."""
    c = Counter()
    for t in tags:
        key = (t.get("category"), t.get("event"), t.get("position") or "", t.get("technique_id"))
        c[key] += max(1, int(t.get("count") or 1))
    return c


def score_case(case: dict, draft: dict) -> dict:
    exp = case["expect"]
    accept = case.get("accept", {})

    inventions = [p for p in case.get("must_not", []) if _filled(draft, p)]

    # "Producing a technique_id where the expectation lists `unresolved` counts
    # as an invention, not a miss." Compared per (category, event) so a model
    # that resolves MORE than the case says is resolvable is caught even when
    # it also gets the resolvable ones right.
    want_resolved = Counter(
        (t["category"], t["event"]) for t in exp.get("tags", []) if t.get("technique_id")
    )
    got_resolved = Counter(
        (t.get("category"), t.get("event")) for t in draft.get("tags", []) if t.get("technique_id")
    )
    for u in exp.get("unresolved", []):
        k = (u["category"], u["event"])
        if got_resolved[k] > want_resolved[k]:
            inventions.append(f"resolved a phrase the case leaves unresolved: {u['phrase']!r}")

    # A tolerance has to reach the tag multiset too, or `accept` silently covers
    # only the scalars and a value the corpus calls correct still fails F1.
    want_tags = [dict(t) for t in exp.get("tags", [])]
    for path, allowed in accept.items():
        if not path.startswith("tags["):
            continue
        idx = int(path[len("tags["):path.index("]")])
        field = path.split("].", 1)[1]
        got_tags = draft.get("tags") or []
        if idx < len(want_tags) and idx < len(got_tags):
            if got_tags[idx].get(field) in allowed:
                want_tags[idx][field] = got_tags[idx][field]

    want, got = _tuples(want_tags), _tuples(draft.get("tags", []))
    overlap = sum((want & got).values())
    precision = overlap / sum(got.values()) if got else (1.0 if not want else 0.0)
    recall = overlap / sum(want.values()) if want else 1.0

    scalars, scalar_ok = [], 0
    for f in SCALARS:
        if exp.get(f) is None:
            continue  # absence is metric 1's business, not this one
        ok = draft.get(f) == exp[f] or draft.get(f) in accept.get(f, [])
        scalars.append({"field": f, "want": exp[f], "got": draft.get(f), "ok": ok})
        scalar_ok += ok

    # Tolerances live in `accept`, never in the prose of `why`. A scorer that
    # reads a range out of an English sentence is guessing at the corpus.
    tag_notes = []
    for path, allowed in accept.items():
        if path.startswith("tags["):
            idx = int(path[len("tags["):path.index("]")])
            field = path.split("].", 1)[1]
            tags = draft.get("tags") or []
            got_v = tags[idx].get(field) if idx < len(tags) else None
            tag_notes.append({"path": path, "allowed": allowed, "got": got_v,
                              "ok": got_v in allowed})

    return {
        "id": case["id"],
        "inventions": inventions,
        "tag": {"precision": precision, "recall": recall,
                "want": sum(want.values()), "got": sum(got.values()), "overlap": overlap},
        "scalars": scalars,
        "scalar_ok": scalar_ok,
        "scalar_total": len(scalars),
        "tolerant": tag_notes,
        "draft": draft,
    }


def aggregate(results: list[dict]) -> dict:
    scored = [r for r in results if "error" not in r]
    n = len(scored)
    invented = sum(1 for r in scored if r["inventions"])
    tp = sum(r["tag"]["overlap"] for r in scored)
    got = sum(r["tag"]["got"] for r in scored)
    want = sum(r["tag"]["want"] for r in scored)
    p = tp / got if got else 0.0
    rc = tp / want if want else 0.0
    sc_ok = sum(r["scalar_ok"] for r in scored)
    sc_n = sum(r["scalar_total"] for r in scored)
    tol_ok = sum(1 for r in scored for t in r["tolerant"] if t["ok"])
    tol_n = sum(len(r["tolerant"]) for r in scored)
    return {
        "cases_scored": n,
        "cases_errored": len(results) - n,
        "invention_rate": invented / n if n else 0.0,
        "cases_with_invention": invented,
        "tag_precision": p,
        "tag_recall": rc,
        "tag_f1": (2 * p * rc / (p + rc)) if (p + rc) else 0.0,
        "scalar_exactness": sc_ok / sc_n if sc_n else None,
        "scalar_checked": sc_n,
        "tolerant_ok": f"{tol_ok}/{tol_n}" if tol_n else "n/a",
    }


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--model", default="gpt-5.6-luna")
    ap.add_argument("--out", default=None, help="result file (default results/<model>.json)")
    ap.add_argument("--only", default=None, help="comma-separated case ids or id prefixes")
    ap.add_argument("--dry-run", action="store_true", help="build everything, call nothing")
    args = ap.parse_args()

    corpus = json.loads(CASES.read_text())
    cases = corpus["cases"]
    if args.only:
        wanted = tuple(s.strip() for s in args.only.split(","))
        cases = [c for c in cases if c["id"].startswith(wanted)]
    techniques = {t["id"]: t for t in json.loads(TECHNIQUES.read_text())}
    families = V.parse_positions((ROOT / "apps" / "mobile" / "lib" / "bjjSession.ts").read_text())
    if not families:
        sys.exit("could not parse POSITIONS out of bjjSession.ts")

    system = P.system_prompt(list(techniques.values()))
    schema = P.draft_schema(families)

    print(f"model={args.model}  cases={len(cases)}  "
          f"system={len(system)} chars (~{len(system)//4} tokens)  families={len(families)}")
    if args.dry_run:
        print(P.user_prompt(cases[0]["dictation"]))
        print(f"[dry run] no calls made. {len(cases)} would have been.")
        return 0

    key = api_key("OPENAI_API_KEY")
    results, usage_total = [], Counter()
    for i, case in enumerate(cases, 1):
        r = call_openai(args.model, system, P.user_prompt(case["dictation"]), schema, key)
        u = r.get("usage") or {}
        usage_total["prompt"] += u.get("prompt_tokens", 0)
        usage_total["completion"] += u.get("completion_tokens", 0)
        usage_total["cached"] += (u.get("prompt_tokens_details") or {}).get("cached_tokens", 0)
        if "error" in r:
            print(f"  {i:>2}/{len(cases)} {case['id']:<34} ERROR {r['error'][:80]}")
            results.append({"id": case["id"], "error": r["error"]})
            continue
        draft = postprocess(r["draft"], techniques, families)
        s = score_case(case, draft)
        results.append(s)
        flag = "INVENTED" if s["inventions"] else "        "
        print(f"  {i:>2}/{len(cases)} {case['id']:<34} {flag} "
              f"tags {s['tag']['overlap']}/{s['tag']['want']}")

    summary = aggregate(results)
    summary["model"] = args.model
    summary["tokens"] = dict(usage_total)
    out = Path(args.out) if args.out else HERE / "results" / f"{args.model}.json"
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps({"summary": summary, "cases": results}, indent=2) + "\n")

    print("\n" + "=" * 62)
    print(f"  model             {args.model}")
    print(f"  invention rate    {summary['invention_rate']:.1%}  "
          f"({summary['cases_with_invention']}/{summary['cases_scored']} cases)")
    print(f"  tag F1            {summary['tag_f1']:.3f}  "
          f"(p {summary['tag_precision']:.3f} / r {summary['tag_recall']:.3f})")
    se = summary["scalar_exactness"]
    print(f"  scalar exactness  {se:.1%} of {summary['scalar_checked']}" if se is not None else
          "  scalar exactness  n/a")
    print(f"  tolerant fields   {summary['tolerant_ok']}")
    print(f"  tokens            {usage_total['prompt']} in "
          f"({usage_total['cached']} cached) / {usage_total['completion']} out")
    if summary["cases_errored"]:
        print(f"  ERRORS            {summary['cases_errored']}")
    try:
        shown = out.relative_to(ROOT)
    except ValueError:
        shown = out  # --out can point anywhere; a scratch path is not an error
    print(f"  written to        {shown}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
