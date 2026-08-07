#!/usr/bin/env python3
"""Generate VOLA's timer sounds.

The four sounds in `apps/mobile/assets/sounds/` are SYNTHESISED, not sourced,
and this script is why they are checked in as a recipe rather than as four
opaque binaries somebody would later be afraid to touch. Re-run it to change
the tuning; the output is deterministic.

Synthesised rather than downloaded for two reasons that both matter more than
the sound itself. There is no licence to track, attribute, or get wrong — a
free-sound-library clip carries terms into the app binary. And the files come
out tiny: these must be bundled locally so they work in a gym basement with no
signal, which rules out streaming them.

**Why they sound like bells.** A struck bell is not a sine wave. Its partials
sit at INHARMONIC ratios (not 2x, 3x, 4x), and the high ones die away faster
than the low ones, which is what the ear reads as "metal" rather than "beep".
Both properties are in `bell()` and neither is decoration: harmonic ratios with
uniform decay is precisely the sound of a cheap alarm clock.

Usage:
    python3 scripts/generate_sounds.py            # writes the .m4a files
    python3 scripts/generate_sounds.py --check    # verifies they are current
"""

from __future__ import annotations

import argparse
import hashlib
import math
import shutil
import struct
import subprocess
import sys
import tempfile
import wave
from pathlib import Path

SAMPLE_RATE = 44100

REPO_ROOT = Path(__file__).resolve().parent.parent
OUT_DIR = REPO_ROOT / "apps" / "mobile" / "assets" / "sounds"

# Inharmonic partials of a struck bell, as (frequency ratio, amplitude, decay
# multiplier). The 2.76 and 5.4 ratios are what stop this sounding like an
# organ; the rising decay multipliers are what stop it sounding like a synth
# pad, because in real metal the high partials shed energy first.
BELL_PARTIALS = (
    (1.00, 1.00, 1.0),
    (2.00, 0.45, 1.6),
    (2.76, 0.30, 2.2),
    (4.07, 0.18, 3.0),
    (5.43, 0.10, 4.0),
)


def bell(freq: float, seconds: float, gain: float = 1.0, decay: float = 3.2) -> list[float]:
    """One struck note, as floating-point samples."""
    n = int(SAMPLE_RATE * seconds)
    out = [0.0] * n
    for ratio, amp, decay_mult in BELL_PARTIALS:
        w = 2.0 * math.pi * freq * ratio
        k = decay * decay_mult
        for i in range(n):
            t = i / SAMPLE_RATE
            out[i] += amp * math.exp(-k * t) * math.sin(w * t)
    # A 4ms fade-in. Without it the waveform starts at full amplitude and the
    # discontinuity is audible as a click on every single play — the cheapest
    # possible way to make a considered sound feel unconsidered.
    attack = int(SAMPLE_RATE * 0.004)
    for i in range(min(attack, n)):
        out[i] *= i / attack
    return [s * gain for s in out]


def mix(*layers: tuple[list[float], float]) -> list[float]:
    """Overlay samples at offsets in seconds."""
    total = max(int(off * SAMPLE_RATE) + len(buf) for buf, off in layers)
    out = [0.0] * total
    for buf, off in layers:
        start = int(off * SAMPLE_RATE)
        for i, s in enumerate(buf):
            out[start + i] += s
    return out


def normalise(samples: list[float], peak: float) -> list[float]:
    """Scale to a fixed peak so the four sounds sit at a consistent loudness."""
    high = max((abs(s) for s in samples), default=0.0)
    if high == 0:
        return samples
    return [s * (peak / high) for s in samples]


def write_wav(path: Path, samples: list[float]) -> None:
    with wave.open(str(path), "w") as f:
        f.setnchannels(1)
        f.setsampwidth(2)
        f.setframerate(SAMPLE_RATE)
        clipped = (max(-1.0, min(1.0, s)) for s in samples)
        f.writeframes(b"".join(struct.pack("<h", int(s * 32767)) for s in clipped))


# Note frequencies. A major triad, so the multi-note sounds resolve rather than
# merely stop.
E5, A5, CS6, E6, A6 = 659.26, 880.00, 1108.73, 1318.51, 1760.00


def rest_done() -> list[float]:
    """Rest is over: two notes rising. Says "go" without being an alarm."""
    return normalise(mix((bell(A5, 2.2), 0.0), (bell(CS6, 2.0, 0.85), 0.13)), 0.82)


def work_done() -> list[float]:
    """A timed set finished. One warm, lower bell — deliberately NOT the rest
    sound, because the two mean opposite things and you are not looking at the
    phone when either fires."""
    return normalise([s for s in bell(E5, 2.6, decay=2.6)], 0.82)


def session_done() -> list[float]:
    """The workout is over. Three notes, ascending, unhurried."""
    return normalise(
        mix((bell(A5, 2.4), 0.0), (bell(CS6, 2.4, 0.9), 0.16), (bell(E6, 2.6, 0.8), 0.32)),
        0.85,
    )


def tick() -> list[float]:
    """The last few seconds. Short, soft and high — it has to register at the
    edge of attention without becoming the thing you notice."""
    return normalise(bell(A6, 0.11, decay=26.0), 0.30)


SOUNDS = {
    "rest-done": rest_done,
    "work-done": work_done,
    "session-done": session_done,
    "tick": tick,
}


def encode(wav_path: Path, m4a_path: Path) -> None:
    """WAV -> AAC. A 2.5s bell is ~220KB as WAV and ~20KB as 64kbps mono AAC,
    and these ship inside the app binary."""
    subprocess.run(
        ["ffmpeg", "-y", "-loglevel", "error", "-i", str(wav_path),
         "-c:a", "aac", "-b:a", "64k", "-ac", "1", str(m4a_path)],
        check=True,
    )


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true", help="verify without writing")
    args = parser.parse_args()

    if not shutil.which("ffmpeg"):
        print("ffmpeg is required (brew install ffmpeg)", file=sys.stderr)
        return 1

    OUT_DIR.mkdir(parents=True, exist_ok=True)
    stale: list[str] = []

    with tempfile.TemporaryDirectory() as tmp:
        for name, render in SOUNDS.items():
            wav = Path(tmp) / f"{name}.wav"
            fresh = Path(tmp) / f"{name}.m4a"
            write_wav(wav, render())
            encode(wav, fresh)
            target = OUT_DIR / f"{name}.m4a"

            if args.check:
                # AAC encoding is deterministic for a given ffmpeg build, but
                # NOT across builds — so a hash mismatch here means "your
                # ffmpeg differs", not necessarily "the sound changed". Report
                # it, do not fail the build on it; that is why this is not
                # wired into `verify` the way the icon check is.
                if not target.exists() or hashlib.sha256(target.read_bytes()).hexdigest() != \
                        hashlib.sha256(fresh.read_bytes()).hexdigest():
                    stale.append(name)
            else:
                target.write_bytes(fresh.read_bytes())
                print(f"{target.relative_to(REPO_ROOT)}  {target.stat().st_size // 1024}KB")

    if args.check:
        print("differs from this machine's ffmpeg: " + ", ".join(stale) if stale else "all current")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
