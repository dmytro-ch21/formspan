#!/usr/bin/env python3
"""Fail if the server's estimate deadline stops being SHORTER than the client's.

Two deadlines bound one request, in two languages, and the ORDER between them is
the property — not their values:

  - `estimateTimeout` in `backend/internal/modules/nutrition/estimate_handler.go`
  - `SLOW_REQUEST_TIMEOUT_MS` in `apps/mobile/lib/authedFetch.ts`, which is what
    the estimate and identify routes are given

Unlike `check-rate-parity` and `check-grip-parity`, which demand the two copies
be EQUAL, this one demands they differ and in which direction. Equal is the
failure.

# Why it exists

N92 (#433) was a phone reporting "can't reach server" while photographing a food
label on a working connection. The cause it closed is that a client which gives
up first receives **no status and no body**, and therefore has nothing to say
except that it could not reach the server. Every other outcome on that route
carries copy the app can render as itself; silence is the one that cannot.

The server deadline exists so the server always wins that race and the athlete
always gets a status. **If the server's deadline is >= the client's, that is
untrue again** — and nothing else in the build would notice, because both
numbers are individually reasonable, both suites stay green, and the symptom
only appears on a slow provider day on somebody's phone.

It nearly shipped that way: N92's constant was written at 45s before N55 (#448)
gave the client a deadline, and N55 set the client's to 45s. The rebase turned a
deliberate margin into an exact tie, and no test anywhere had an opinion.

# Why the margin has to be wide, not nominal

**The two clocks do not start together.** The client's starts when it begins
writing the request; the server's starts when the handler runs, which is after
the body has arrived. A photo upload on gym wifi shifts the server's window
several seconds later, so a server deadline one second under the client's still
loses. `MIN_MARGIN_MS` is that shift plus room.

# What this cannot promise

It reads the two literals syntactically — stdlib only, no Go toolchain, no Node,
matching its sibling checks. So it compares the CONSTANTS, not which constant a
given call site actually passes. If a screen stops passing
`SLOW_REQUEST_TIMEOUT_MS` and falls back to `DEFAULT_TIMEOUT_MS` (30s), this
script still passes while the client's real budget drops below the server's.
`authedFetch.ts`'s own doc comment records which routes get the slow budget and
why; keep them in step by reading it, not by trusting this.
"""

import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

GO = ROOT / "backend/internal/modules/nutrition/estimate_handler.go"
TS = ROOT / "apps/mobile/lib/authedFetch.ts"

#: How far under the client the server must sit.
#:
#: Ten seconds, and it is the upload shift above rather than a round number: a
#: multi-second body write on gym wifi is spent entirely out of this margin
#: before the handler's clock has started at all.
MIN_MARGIN_MS = 10_000

GO_RE = re.compile(
    r"^const\s+estimateTimeout\s*=\s*(\d+)\s*\*\s*time\.(Second|Millisecond)\s*$",
    re.MULTILINE,
)
TS_RE = re.compile(
    r"^export\s+const\s+SLOW_REQUEST_TIMEOUT_MS\s*=\s*([\d_]+)\s*;\s*$",
    re.MULTILINE,
)

GO_UNIT_MS = {"Second": 1000, "Millisecond": 1}


def fail(msg: str) -> None:
    print(f"check-timeout-parity: {msg}", file=sys.stderr)
    sys.exit(1)


def main() -> None:
    for path in (GO, TS):
        if not path.exists():
            fail(f"{path.relative_to(ROOT)} does not exist")

    go_match = GO_RE.search(GO.read_text())
    if not go_match:
        # A parser that silently found nothing would pass this check forever,
        # which is the failure mode every check in this repo is written against.
        fail(
            f"could not find `const estimateTimeout = N * time.Second` in "
            f"{GO.relative_to(ROOT)}. It was renamed, moved or reformatted — fix "
            f"this parser rather than deleting the check; the ordering it "
            f"guards is what stops N92 recurring."
        )
    server_ms = int(go_match.group(1)) * GO_UNIT_MS[go_match.group(2)]

    ts_match = TS_RE.search(TS.read_text())
    if not ts_match:
        fail(
            f"could not find `export const SLOW_REQUEST_TIMEOUT_MS = N;` in "
            f"{TS.relative_to(ROOT)}. Same instruction as above."
        )
    client_ms = int(ts_match.group(1).replace("_", ""))

    margin = client_ms - server_ms
    if margin < MIN_MARGIN_MS:
        verb = "ties with" if margin == 0 else ("exceeds" if margin < 0 else "is under")
        fail(
            f"the server's estimate deadline {verb} the client's by too little.\n"
            f"  server  estimateTimeout          = {server_ms} ms  ({GO.relative_to(ROOT)})\n"
            f"  client  SLOW_REQUEST_TIMEOUT_MS  = {client_ms} ms  ({TS.relative_to(ROOT)})\n"
            f"  margin  = {margin} ms, need >= {MIN_MARGIN_MS} ms\n\n"
            f"The server must answer BEFORE the phone gives up, or the athlete gets\n"
            f"no status at all and the app can only say it could not reach the\n"
            f"server — which is the exact failure N92 (#433) was reported for. The\n"
            f"margin is wide because the two clocks do not start together: the\n"
            f"client's starts when it begins writing the request, the server's when\n"
            f"the handler runs, so the upload is spent out of this gap.\n\n"
            f"Lower the server's, or raise the client's. Do not lower MIN_MARGIN_MS\n"
            f"to make this pass."
        )

    print(
        f"check-timeout-parity: server {server_ms} ms < client {client_ms} ms "
        f"(margin {margin} ms, need {MIN_MARGIN_MS} ms) — the server answers first"
    )


if __name__ == "__main__":
    main()
