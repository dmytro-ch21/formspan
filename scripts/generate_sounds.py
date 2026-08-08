#!/usr/bin/env python3
"""Synthesise VOLA's UI sound family from scratch.

The sounds are GENERATED, not sampled — this script is the source of truth the
way `assets/brand/*.svg` is for the visual identity. Edit the spec table at the
bottom and re-run; never hand-edit a .wav or .m4a, it will be overwritten.

    python3 scripts/generate_sounds.py            # render the family, write the bundle
    python3 scripts/generate_sounds.py --check    # verify the bundled files are current

Synthesised rather than downloaded, for two reasons that both outrank the sound
itself: there is no licence to track, attribute, or get wrong, and the files
come out tiny — they must be bundled locally so a rest timer works in a gym
basement with no signal, which rules out streaming them.

Why synthesis and not a sample pack: a family of UI sounds has to be *related*.
Every sound here is struck from the same five notes (F# major pentatonic) and
the same three voices, so two of them firing 200 ms apart still sound like one
instrument rather than two stock libraries colliding. That property is very
hard to buy and nearly free to synthesise.

WHAT MAKES A SOFT, EXPENSIVE-SOUNDING CHIME (the whole design, in one place)

1.  Inharmonic-but-consonant partials. Pure sine stacks sound synthetic and
    cheap; a physically accurate bell is clangy and sour. The usable middle is
    a near-harmonic series with a little stretch, plus two or three genuinely
    inharmonic partials up top that die inside 100 ms. Ear reads the stretch as
    "struck metal" and never gets long enough on the inharmonic ones to hear
    them as out of tune.

2.  Per-partial decay that falls with frequency. This is the single biggest
    lever between "physical object" and "organ". Real struck bodies radiate
    their high modes away first. Every voice below sets `dmul` < 1 on its upper
    partials for exactly this.

3.  A 4-8 ms raised-cosine attack, never an instantaneous one. A hard onset
    puts a click at the front — broadband energy the ear hears as cheap and
    plasticky. Eight milliseconds is still perceptually instant.

4.  A small downward pitch glide over the first ~30 ms. Struck bars and plates
    stiffen under the strike and settle; the ear expects it, and its absence is
    a large part of what makes naive synthesis sound fake.

5.  Nothing brittle up top. A gentle 12 dB/oct roll-off somewhere around
    7-9 kHz. Sounds that survive being played at 6am next to a sleeping person
    have no energy above 10 kHz to speak of.

6.  A short, damped convolution tail. 0.4 s on a tap, 1.4 s on the big
    moments. The high frequencies in the tail must decay ~3x faster than the
    lows or it sounds like a tiled bathroom instead of a room.

7.  Real headroom. Nothing is normalised past its intent level, and the loud
    end of the family stops at -4 dBFS.

MONO SAFETY: stereo width here comes only from *panning* partials, never from
delaying or phase-shifting them. A phone speaker sums to mono, and a Haas-widened
sound partially cancels when it does. Everything below survives the fold-down.

THIS REPLACED A STDLIB-ONLY GENERATOR, and the dependency is the reason the
sounds got better. The previous version summed five partials per note in a
Python loop, with no room, no filtering and no per-partial voicing — which is
measurable, not a matter of taste: the old `tick` had a 1880 Hz spectral
centroid against the shipped one's 1127, and the old sounds put 66-80% of their energy
into their 40 strongest bins against ~37% here. That gap is the difference
between a near-pure pitched tone (which the ear reads as a beep) and a struck
object in a room. Doing this without numpy means hand-rolling FFT convolution,
and the render goes from three seconds to minutes.

Nothing in CI or `pnpm run verify` imports this, so numpy is NOT a pipeline
dependency: the `Scripts (Python)` job runs `check-python-syntax.py`, which
`ast.parse`s and never imports, so this file is checked without a toolchain
even though it could not run.

**`--check` needs numpy and ffmpeg too.** It does not hash the checked-in files
against a stored manifest — it re-renders every sound and byte-compares, the
same way the script it replaced did. An earlier version of this docstring
claimed otherwise and it was simply untrue. `--check` also writes: the thirteen
un-bundled sounds land in `assets/audio/`, which is gitignored, so the tree
stays clean but the flag is not read-only.

Not wired into `verify` on purpose: it writes binary assets, and a check that
rewrites the tree it is checking will eventually show up in somebody's
`git status`. It is also never fatal — AAC is deterministic for one ffmpeg
build but not across builds, so a mismatch means "your ffmpeg differs" at least
as often as "the sound changed", and it reports rather than gates.
"""
# Without this, the `np.ndarray` annotations below are evaluated eagerly at
# import and the numpy guard is defeated: a machine with no numpy gets
# `AttributeError: 'NoneType' object has no attribute 'ndarray'` from the import
# itself, before argparse runs, instead of the intended message. The guard read
# as sufficient and was not — annotations are executable code by default.
from __future__ import annotations

import argparse
import shutil
import struct
import subprocess
import sys
import tempfile
import wave
from pathlib import Path

# Guarded so a machine without numpy gets the one-line message in main() rather
# than a traceback out of an import. Every mode needs it — see the docstring.
try:
    import numpy as np
except ImportError:  # pragma: no cover
    np = None

SR = 48_000  # master rate; exports are resampled at the end
ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "assets" / "audio"                       # full family, gitignored
BUNDLE_DIR = ROOT / "apps" / "mobile" / "assets" / "sounds"

# Exactly the sounds the app plays, mapped to the filenames `lib/sounds.ts`
# already `require`s. Everything else in the family renders to assets/audio/ for
# auditioning and is deliberately NOT checked in — the script is the source of
# truth, and shipping the unused ones would bloat the binary for nothing.
# Wiring one up is: add it here, add the name to SOUND_NAMES, add the `require`
# to SOURCES.
#
# No counts in this comment on purpose. It said "four" while six were bundled,
# which is the third time a hard-coded number in this feature went stale — the
# other two being `toHaveLength(4)` in the sound tests and the note in
# .gitignore.
BUNDLE = {
    "rest-complete": "rest-done",
    "work-complete": "work-done",
    "session-complete": "session-done",
    "rest-tick": "tick",
    # The timer four above kept the filenames they shipped under; `pr` is new
    # so it just uses the family name.
    #
    # `set-logged` is deliberately NOT here. It was bundled and wired, then
    # pulled back out: at 20+ plays a session it was the one sound in the
    # family certain to grate, and a haptic says the same thing without
    # occupying the room. The recipe stays in S so it can still be auditioned —
    # being unbundled is not the same as being deleted.
    "pr": "pr",
    "notification": "notification",
    "streak": "streak",
    "success": "success",
}

# ---------------------------------------------------------------------------
# Notes — F# major pentatonic (F# G# A# C# D#), A4 = 440.
#
# Pentatonic because it has no minor 2nds and no tritone: ANY two notes in the
# set sound fine together. UI sounds overlap unpredictably (a set logged while
# a rest timer fires), and this is the cheapest possible insurance against the
# one-in-twenty collision that sounds like a mistake.
# ---------------------------------------------------------------------------
def _n(semis_from_a4: float) -> float:
    return 440.0 * (2.0 ** (semis_from_a4 / 12.0))


NOTE = {
    "F#3": _n(-15), "G#3": _n(-13), "A#3": _n(-11), "C#4": _n(-8), "D#4": _n(-6),
    "F#4": _n(-3),  "G#4": _n(-1),  "A#4": _n(1),   "C#5": _n(4),  "D#5": _n(6),
    "F#5": _n(9),   "G#5": _n(11),  "A#5": _n(13),  "C#6": _n(16), "D#6": _n(18),
    "F#6": _n(21),  "G#6": _n(23),  "A#6": _n(25),  "C#7": _n(28), "D#7": _n(30),
}

# ---------------------------------------------------------------------------
# Voices.  partials: (ratio, amp, decay_mult, pan)
#
# `decay` on a voice, and `dmul` on a partial, are T60 in SECONDS — the time to
# fall 60 dB, i.e. to audible silence. NOT the exponential time constant; tau
# is T60/6.91 and is derived in strike(). Stating these as time constants is
# how the first pass produced a 2.6-second "tap": every number here reads as a
# duration you can hear, and it should stay that way.
# ---------------------------------------------------------------------------
VOICES = {
    # The signature voice. Soft glockenspiel / celeste. Slightly stretched
    # harmonics (3.01, 4.02) plus two inharmonic sparkles that are gone in
    # under 100 ms.
    "glass": {
        "partials": [
            (1.000, 1.000, 1.00, 0.00),
            (2.000, 0.420, 0.78, -0.22),
            (3.010, 0.180, 0.54, 0.26),
            (4.020, 0.090, 0.40, -0.30),
            (5.423, 0.048, 0.24, 0.34),
            (6.810, 0.026, 0.17, -0.36),
            (8.954, 0.013, 0.11, 0.30),
        ],
        "decay": 0.85, "attack": 0.005, "drop": 0.010, "chiff": 0.010, "lp": 8600,
    },
    # Tubular-bell-ish, for the sounds that have to carry across a room. The
    # 0.5 "hum" partial under the strike is what gives a bell its weight —
    # without it this reads as a toy.
    "bell": {
        "partials": [
            (0.500, 0.300, 1.35, 0.00),
            (1.000, 1.000, 1.00, 0.00),
            (1.995, 0.550, 0.84, -0.20),
            (2.990, 0.300, 0.60, 0.24),
            (4.160, 0.170, 0.44, -0.28),
            (5.430, 0.095, 0.30, 0.32),
            (6.790, 0.052, 0.21, -0.30),
            (8.210, 0.026, 0.14, 0.26),
        ],
        "decay": 1.05, "attack": 0.004, "drop": 0.014, "chiff": 0.016, "lp": 7800,
    },
    # Wooden bar. Real marimba modes sit near 1 : 3.9 : 10.4 and the upper two
    # die almost immediately, which is why a marimba reads as a *tap* and not
    # as a note. Used for every sound that should feel like touch, not signal.
    "marimba": {
        "partials": [
            (1.000, 1.000, 1.00, 0.00),
            (2.000, 0.120, 0.42, -0.16),
            (3.932, 0.300, 0.26, 0.20),
            (10.35, 0.085, 0.08, -0.22),
        ],
        "decay": 0.30, "attack": 0.003, "drop": 0.022, "chiff": 0.030, "lp": 6400,
    },
    # Pure sines, slow attack, long decay. Never heard on its own — it sits an
    # octave or two below the melody in the longer sounds and is most of what
    # separates "a moment happened" from "a button was pressed".
    "pad": {
        "partials": [
            (1.000, 1.000, 1.00, 0.00),
            (2.000, 0.300, 0.90, -0.18),
            (3.000, 0.110, 0.70, 0.22),
            (4.000, 0.055, 0.58, -0.20),
        ],
        "decay": 1.60, "attack": 0.045, "drop": 0.000, "chiff": 0.0, "lp": 5200,
    },
}


# ---------------------------------------------------------------------------
# DSP
# ---------------------------------------------------------------------------
def fft_filter(x: np.ndarray, curve) -> np.ndarray:
    """Zero-phase filter via the frequency domain.

    Zero-phase is technically non-causal and can pre-ring ahead of a sharp
    transient — but nothing here HAS a sharp transient (every attack is >= 3 ms
    by design), so we get the clean magnitude response with no smearing to pay
    for it.
    """
    n = len(x)
    size = 1 << (n - 1).bit_length()
    f = np.fft.rfftfreq(size, 1.0 / SR)
    return np.fft.irfft(np.fft.rfft(x, size) * curve(f), size)[:n]


def lowpass(fc, order=2):
    return lambda f: 1.0 / np.sqrt(1.0 + (f / fc) ** (2 * order))


def highpass(fc, order=2):
    return lambda f: (f / fc) ** order / np.sqrt(1.0 + (f / fc) ** (2 * order))


def bandpass(lo, hi):
    return lambda f: highpass(lo)(f) * lowpass(hi)(f)


def fft_convolve(x: np.ndarray, h: np.ndarray) -> np.ndarray:
    n = len(x) + len(h) - 1
    size = 1 << (n - 1).bit_length()
    return np.fft.irfft(np.fft.rfft(x, size) * np.fft.rfft(h, size), size)[:n]


def make_ir(rt60: float, predelay: float = 0.011, seed: int = 7) -> np.ndarray:
    """A small, warm room as a stereo impulse response.

    Three bands, three decay rates: lows ring for the full RT60, mids for 75%
    of it, highs for 28%. That ratio is the difference between "a room" and "a
    tiled bathroom" — an undamped tail makes every sound above it feel cheap
    and far away.

    The first 18 ms of the diffuse tail is ramped in rather than starting at
    full amplitude, which is how real reverberation actually builds.

    INTER-CHANNEL CORRELATION IS FREQUENCY-DEPENDENT, and getting this wrong is
    what separates a room from a cheap stereo widener. Drawing independent
    noise for both channels — the obvious implementation, and the one this
    started as — decorrelates the low end too, which sounds phasey in
    headphones and drops several dB of body the moment a phone speaker folds it
    to mono. A real room is nearly mono below ~400 Hz (the wavelengths dwarf
    the spacing) and only genuinely diffuse up high. So: lows are the SAME
    noise in both channels, mids are mixed 0.75/0.66 shared-to-independent
    (unity energy, ~0.56 correlation), highs are fully independent.
    """
    rng = np.random.default_rng(seed)
    n = int(rt60 * SR)
    t = np.arange(n) / SR
    ir = np.zeros((2, n))

    shared = rng.standard_normal(n)
    low = fft_filter(shared, lowpass(400))  # identical in both channels

    for ch in range(2):
        indep = rng.standard_normal(n)
        mid = fft_filter(0.75 * shared + 0.66 * indep, bandpass(400, 2500))
        high = fft_filter(indep, highpass(2500))
        tail = (
            low * np.exp(-6.91 * t / (rt60 * 1.00))
            + mid * np.exp(-6.91 * t / (rt60 * 0.75))
            + high * 0.55 * np.exp(-6.91 * t / (rt60 * 0.28))
        )
        ir[ch] = tail * np.clip(t / 0.018, 0.0, 1.0)

    # A few early reflections in front of the diffuse tail. Without these the
    # tail sounds detached from the sound that caused it. The two channels get
    # different reflection PATTERNS rather than one uniformly delayed copy —
    # a constant offset between channels is a comb filter, which is audible as
    # hollowness the instant it folds to mono.
    for ch, taps in enumerate((
        ((6.3, 0.40), (11.1, -0.30), (17.2, 0.23), (23.4, -0.17)),
        ((7.9, 0.38), (12.6, -0.29), (18.7, 0.22), (24.1, -0.16)),
    )):
        for delay_ms, gain in taps:
            i = int(delay_ms * SR / 1000.0)
            if i < n:
                ir[ch][i] += gain

    pre = int(predelay * SR)
    ir = np.concatenate([np.zeros((2, pre)), ir], axis=1)
    return ir / np.max(np.abs(ir))


def strike(buf, t0, freq, voice_name, amp=1.0, decay=1.0,
           bright=1.0, shimmer=0.0, pan=0.0, seed=0):
    """Render one struck note into a stereo buffer, in place."""
    v = VOICES[voice_name]
    rng = np.random.default_rng(seed + int(freq))
    start = int(t0 * SR)
    if start >= buf.shape[1]:
        return

    span = buf.shape[1] - start
    t = np.arange(span) / SR
    base_decay = v["decay"] * decay

    for ratio, pamp, dmul, ppan in v["partials"]:
        t60 = base_decay * dmul
        if t60 < 0.012:
            continue
        tau = t60 / 6.91
        # Higher partials are attenuated further as `bright` drops — this
        # mimics a softer mallet, not a volume change.
        gain = pamp * (bright ** max(0.0, np.log2(max(ratio, 0.5))))
        if gain < 0.0009:
            continue

        f0 = freq * ratio
        if f0 > SR * 0.45:
            continue

        # Downward pitch glide over the first ~30 ms (see docstring, point 4).
        inst = f0 * (1.0 + v["drop"] * np.exp(-t / 0.030))
        phase = 2.0 * np.pi * np.cumsum(inst) / SR + rng.uniform(0, 2 * np.pi)
        wave_ = np.sin(phase) * np.exp(-t / tau)

        if shimmer > 0.0:
            # A second copy ~3 cents sharp, panned opposite. Beats at roughly
            # 1-2 Hz and reads as "alive" rather than as detuning.
            inst2 = inst * 1.00173
            ph2 = 2.0 * np.pi * np.cumsum(inst2) / SR + rng.uniform(0, 2 * np.pi)
            wave_ = wave_ + shimmer * np.sin(ph2) * np.exp(-t / tau)

        atk = max(1, int(v["attack"] * SR))
        env = np.ones(span)
        k = min(atk, span)
        env[:k] = 0.5 - 0.5 * np.cos(np.linspace(0.0, np.pi, k))
        wave_ *= env

        p = np.clip(ppan * 0.8 + pan, -1.0, 1.0)
        ang = (p + 1.0) * np.pi / 4.0
        buf[0][start:] += wave_ * gain * amp * np.cos(ang) * 1.41421
        buf[1][start:] += wave_ * gain * amp * np.sin(ang) * 1.41421

    # The "chiff": the noise of mallet-on-material, gone in 25 ms. Tiny, and
    # removing it is instantly audible as a loss of realism.
    if v["chiff"] > 0.0:
        nz = rng.standard_normal(span) * np.exp(-t / 0.012)
        nz = fft_filter(nz, bandpass(2600, 9000))
        m = np.max(np.abs(nz)) or 1.0
        for ch in range(2):
            buf[ch][start:] += (nz / m) * v["chiff"] * amp * 0.5


def finish(buf, rt60, wet, peak_db, lp_hz):
    """Room, tone-shaping, trim, level. Every sound ends up here."""
    ir = make_ir(rt60)
    out = np.zeros((2, buf.shape[1] + ir.shape[1] - 1))
    for ch in range(2):
        out[ch, : buf.shape[1]] = buf[ch]
        out[ch] += fft_convolve(buf[ch], ir[ch]) * wet

    for ch in range(2):
        out[ch] = fft_filter(out[ch], lowpass(lp_hz, order=2))   # nothing brittle
        out[ch] = fft_filter(out[ch], highpass(38, order=2))     # DC + rumble

    # Normalise BEFORE trimming, so the trim threshold is relative to this
    # sound's own peak. An absolute threshold trims a quiet sound late and a
    # loud one early — which is exactly backwards, and left the first pass with
    # half a second of inaudible tail welded onto every file.
    out /= np.max(np.abs(out)) or 1.0

    mag = np.max(np.abs(out), axis=0)
    live = np.where(mag > 10 ** (-58 / 20))[0]
    if len(live):
        out = out[:, : min(out.shape[1], live[-1] + int(0.025 * SR))]

    # Guarantee a true zero ending — a sound cut mid-cycle clicks on every
    # single playback.
    fade = min(int(0.022 * SR), out.shape[1])
    ramp = 0.5 + 0.5 * np.cos(np.linspace(0.0, np.pi, fade))
    out[:, -fade:] *= ramp

    return out * 10 ** (peak_db / 20.0)


# ---------------------------------------------------------------------------
# Output
# ---------------------------------------------------------------------------
def resample(x: np.ndarray, dst: int) -> np.ndarray:
    if dst == SR:
        return x
    n = int(round(x.shape[1] * dst / SR))
    src_t = np.arange(x.shape[1]) / SR
    dst_t = np.arange(n) / dst
    return np.stack([np.interp(dst_t, src_t, x[ch]) for ch in range(2)])


def write_wav(path: Path, x: np.ndarray, rate: int, bits: int):
    path.parent.mkdir(parents=True, exist_ok=True)
    inter = np.clip(x.T.reshape(-1), -1.0, 1.0)
    with wave.open(str(path), "wb") as w:
        w.setnchannels(2)
        w.setsampwidth(bits // 8)
        w.setframerate(rate)
        if bits == 16:
            w.writeframes((inter * 32767.0).astype("<i2").tobytes())
        else:
            v = (inter * 8388607.0).astype("<i4")
            w.writeframes(b"".join(struct.pack("<i", int(s))[:3] for s in v))


# ---------------------------------------------------------------------------
# The family.
#
# `notes` is a list of (t0, note, voice, amp, decay, bright, shimmer, pan).
# `level` is the intent loudness in dBFS — deliberately NOT equal across the
# set. A tap that is as loud as a workout-complete fanfare is a design bug, so
# the family is levelled by role: touch is quiet, signal is loud, and the only
# sound allowed near the ceiling is the one that has to beat gym noise.
# ---------------------------------------------------------------------------
S = [
  dict(name="tap", desc="Generic UI tap / button press.",
       level=-19, rt60=0.35, wet=0.13, lp=7000,
       notes=[(0.000, "C#6", "marimba", 1.00, 0.85, 0.85, 0.0, 0.0)]),

  dict(name="select", desc="Selecting an item from a list, picking an exercise.",
       level=-17, rt60=0.40, wet=0.15, lp=7200,
       notes=[(0.000, "G#5", "marimba", 1.00, 1.00, 0.90, 0.0, 0.0),
              (0.000, "D#6", "marimba", 0.28, 0.70, 0.85, 0.0, 0.15)]),

  dict(name="toggle-on", desc="Switch, checkbox or filter turning on. Rises.",
       level=-16, rt60=0.45, wet=0.17, lp=8000,
       notes=[(0.000, "F#5", "glass", 0.75, 0.34, 0.90, 0.0, -0.12),
              (0.048, "C#6", "glass", 0.85, 0.36, 0.92, 0.0, 0.12)]),

  dict(name="toggle-off", desc="The same control turning off. Falls, and darker.",
       level=-17, rt60=0.42, wet=0.15, lp=5600,
       notes=[(0.000, "C#6", "glass", 0.80, 0.30, 0.72, 0.0, 0.12),
              (0.048, "F#5", "glass", 0.78, 0.34, 0.68, 0.0, -0.12)]),

  dict(name="set-logged", desc="A set recorded mid-workout. Unbundled — a set tick is a haptic now; this was too frequent to be a sound.",
       level=-14, rt60=0.55, wet=0.18, lp=7600,
       notes=[(0.000, "G#5", "marimba", 0.55, 0.90, 0.85, 0.0, -0.15),
              (0.030, "C#6", "marimba", 1.00, 1.05, 0.90, 0.0, 0.10),
              (0.030, "C#6", "glass", 0.30, 0.45, 0.80, 0.0, 0.10)]),

  dict(name="message", desc="Incoming message or friend request. Two soft notes, no urgency.",
       level=-12, rt60=0.70, wet=0.22, lp=8400,
       notes=[(0.000, "C#6", "glass", 0.85, 0.55, 0.95, 0.10, -0.14),
              (0.078, "D#6", "glass", 0.90, 0.65, 0.95, 0.10, 0.14)]),

  dict(name="success", desc="Confirmation for a deliberate, once-per-action send or accept. NOT saves — those autosave constantly.",
       level=-12, rt60=0.85, wet=0.24, lp=8600,
       notes=[(0.000, "A#5", "glass", 0.90, 0.75, 1.00, 0.12, -0.12),
              (0.090, "D#6", "glass", 0.95, 0.90, 1.00, 0.12, 0.12),
              (0.000, "A#3", "pad",   0.16, 0.60, 0.70, 0.0, 0.0)]),

  dict(name="start", desc="Session or timer beginning. Rising, warm, forward-leaning.",
       level=-11, rt60=0.90, wet=0.24, lp=8200,
       notes=[(0.000, "F#5", "glass", 0.80, 0.70, 0.92, 0.10, -0.14),
              (0.100, "C#6", "glass", 0.95, 0.95, 0.96, 0.10, 0.14),
              (0.000, "F#3", "pad",   0.22, 0.70, 0.70, 0.0, 0.0)]),

  dict(name="error", desc="Gentle no. Descending, dark, deliberately not a buzzer.",
       level=-13, rt60=0.60, wet=0.20, lp=2600,
       notes=[(0.000, "A#4", "bell", 0.80, 0.42, 0.42, 0.0, -0.10),
              (0.110, "F#4", "bell", 0.90, 0.55, 0.38, 0.0, 0.10)]),

  # Levelled and voiced against GYM NOISE, not against a quiet room — the one
  # sound in the family where "soft" had to be argued back down. The first pass
  # put it at -23 dBFS and 753 Hz: 10 dB below the sound it replaces AND an
  # octave darker. Quiet plus dark is the worst possible combination for
  # cutting through, and ~750 Hz is exactly where gym music sits. This fires in
  # the last three seconds of a rest to make you look up, and a tick nobody
  # hears is the same as no tick. So: up into a clearer band and 8 dB louder,
  # while staying 11 dB under the chime it precedes — which is what keeps it
  # subordinate rather than an alarm.
  dict(name="rest-tick", desc="Last-three-seconds countdown tick. Subordinate to the chime it precedes, but it still has to survive a noisy gym.",
       level=-15, rt60=0.28, wet=0.11, lp=6800,
       notes=[(0.000, "C#6", "marimba", 1.00, 0.60, 0.80, 0.0, 0.0)]),

  dict(name="rest-warning", desc="Ten seconds of rest left. One low note, easy to ignore if you're mid-set.",
       level=-13, rt60=0.80, wet=0.22, lp=5000,
       notes=[(0.000, "C#5", "bell", 1.00, 0.85, 0.55, 0.0, 0.0),
              (0.000, "C#4", "pad",  0.20, 0.55, 0.60, 0.0, 0.0)]),

  dict(name="rest-complete", desc="Rest over, go. The one sound that must beat gym noise — the loudest and brightest in the set.",
       level=-4, rt60=1.30, wet=0.26, lp=9000,
       notes=[(0.000, "C#6", "bell",  1.00, 1.10, 1.00, 0.08, -0.10),
              (0.160, "F#6", "bell",  0.85, 1.00, 1.00, 0.08, 0.10),
              (0.000, "F#4", "pad",   0.28, 0.85, 0.75, 0.0, 0.0)]),

  dict(name="work-complete", desc="A timed work interval ended. One note, low and warm — the opposite shape to rest-complete on purpose.",
       level=-7, rt60=1.15, wet=0.24, lp=5200,
       notes=[(0.000, "F#5", "bell", 1.00, 1.05, 0.62, 0.06, 0.00),
              (0.000, "F#3", "pad",  0.30, 0.95, 0.70, 0.0, 0.0)]),

  dict(name="notification", desc="The signature bell. NOT push — there is no push system; this fires in-app when MORE is found waiting than last time you looked.",
       level=-9, rt60=1.20, wet=0.26, lp=8400,
       notes=[(0.000, "C#6", "bell",  0.90, 1.05, 0.92, 0.10, 0.00),
              (0.022, "G#5", "glass", 0.45, 0.90, 0.90, 0.10, -0.20),
              (0.000, "C#4", "pad",   0.24, 0.90, 0.70, 0.0, 0.0)]),

  dict(name="session-complete", desc="Workout finished. Three notes resolving upward over a pad swell.",
       level=-6, rt60=1.45, wet=0.30, lp=8600,
       notes=[(0.000, "F#5", "glass", 0.85, 0.95, 0.95, 0.14, -0.16),
              (0.130, "A#5", "glass", 0.88, 1.05, 0.96, 0.14, 0.06),
              (0.260, "C#6", "glass", 1.00, 1.30, 1.00, 0.14, 0.16),
              (0.000, "F#3", "pad",   0.34, 1.15, 0.75, 0.0, 0.0),
              (0.260, "C#4", "pad",   0.20, 1.00, 0.70, 0.0, 0.0)]),

  dict(name="pr", desc="Personal record. Celebratory but restrained — an arpeggio and an octave shimmer, not a fanfare.",
       level=-6, rt60=1.50, wet=0.30, lp=9200,
       notes=[(0.000, "F#5", "glass", 0.78, 0.85, 0.95, 0.16, -0.20),
              (0.095, "G#5", "glass", 0.80, 0.90, 0.96, 0.16, -0.06),
              (0.190, "A#5", "glass", 0.85, 1.00, 0.98, 0.16, 0.08),
              (0.285, "C#6", "glass", 1.00, 1.35, 1.00, 0.16, 0.20),
              (0.310, "C#7", "glass", 0.22, 0.55, 1.00, 0.20, -0.10),
              (0.000, "F#3", "pad",   0.32, 1.20, 0.78, 0.0, 0.0)]),

  dict(name="streak", desc="The weekly streak carried forward — the first session of a new week, and only that one.",
       level=-8, rt60=1.10, wet=0.27, lp=8800,
       notes=[(0.000, "C#6", "glass", 0.85, 0.80, 0.96, 0.14, -0.16),
              (0.105, "D#6", "glass", 0.85, 0.85, 0.97, 0.14, 0.04),
              (0.210, "F#6", "glass", 0.92, 1.10, 1.00, 0.14, 0.18),
              (0.000, "F#4", "pad",   0.24, 0.85, 0.72, 0.0, 0.0)]),
]


def render(spec):
    # Allocate from the actual decays rather than a fixed guess, so a tap does
    # not carry three seconds of zeros through two FFT convolutions.
    tail = max(t0 + VOICES[v]["decay"] * dec * 1.15 + 0.12
               for t0, _, v, _, dec, _, _, _ in spec["notes"])
    buf = np.zeros((2, int(tail * SR)))
    for i, (t0, note, voice, amp, dec, bright, shim, pan) in enumerate(spec["notes"]):
        strike(buf, t0, NOTE[note], voice, amp=amp, decay=dec,
               bright=bright, shimmer=shim, pan=pan, seed=i * 101 + 7)
    return finish(buf, spec["rt60"], spec["wet"], spec["level"], spec["lp"])


def encode(wav: Path, m4a: Path) -> None:
    """WAV -> AAC. A 1.5s bell is ~260KB as WAV and ~18KB as AAC, and these ship
    inside the app binary.

    Kept on ffmpeg rather than macOS's afconvert so the script runs on Linux
    too. Stereo, unlike the mono this replaced: the width here is real (panned
    partials and a decorrelated room), a phone speaker folds it down to the
    same thing mono would have been, and headphones — which is how most people
    train — get the room back. It costs about 4KB a file.

    AAC's encoder padding would matter for a sound that must land on an exact
    frame; every one of these is triggered by a human action with tens of
    milliseconds of slack, so it does not.
    """
    m4a.parent.mkdir(parents=True, exist_ok=True)
    subprocess.run(
        ["ffmpeg", "-y", "-loglevel", "error", "-i", str(wav),
         "-c:a", "aac", "-b:a", "96k", str(m4a)],
        check=True,
    )


def main() -> int:
    ap = argparse.ArgumentParser(description="Render VOLA's UI sound family.")
    ap.add_argument("--only", help="render one sound by name")
    ap.add_argument("--check", action="store_true",
                    help="re-render and byte-compare the bundled .m4a files; "
                         "reports drift, never fails. Writes only to gitignored assets/audio/")
    args = ap.parse_args()

    if np is None:
        print("needs numpy — `pip3 install numpy`", file=sys.stderr)
        return 1
    if not shutil.which("ffmpeg"):
        print("ffmpeg is required (brew install ffmpeg)", file=sys.stderr)
        return 1

    specs = [s for s in S if not args.only or s["name"] == args.only]
    if not specs:
        print(f"no sound named {args.only!r}", file=sys.stderr)
        return 1

    stale: list[str] = []
    with tempfile.TemporaryDirectory() as tmp:
        print(f"{'sound':<19}{'dur':>7}{'peak':>8}{'size':>8}  bundled as")
        print("-" * 60)
        for spec in specs:
            name = spec["name"]
            x = render(spec)
            wav = OUT / f"{name}.wav"
            write_wav(wav, resample(x, 44_100), 44_100, 16)

            fresh = Path(tmp) / f"{name}.m4a"
            encode(wav, fresh)

            bundled = BUNDLE.get(name)
            if bundled:
                target = BUNDLE_DIR / f"{bundled}.m4a"
                if args.check:
                    # A mismatch here means "your toolchain differs" at least
                    # as often as "the sound changed": AAC is deterministic for
                    # a given ffmpeg build but not across builds, and the
                    # renders run through np.random.default_rng, so a numpy
                    # bump can move the bytes too.
                    # Reported, never fatal — which is why this is not in
                    # `verify` the way the icon check is.
                    if not target.exists() or target.read_bytes() != fresh.read_bytes():
                        stale.append(bundled)
                else:
                    target.parent.mkdir(parents=True, exist_ok=True)
                    target.write_bytes(fresh.read_bytes())
            else:
                # Not bundled: rendered for auditioning only, into the
                # gitignored assets/audio/. See BUNDLE.
                (OUT / "m4a").mkdir(parents=True, exist_ok=True)
                (OUT / "m4a" / f"{name}.m4a").write_bytes(fresh.read_bytes())

            peak = 20 * np.log10(np.max(np.abs(x)) or 1e-9)
            kb = fresh.stat().st_size / 1024
            print(f"{name:<19}{x.shape[1]/SR:>6.2f}s{peak:>7.1f}dB{kb:>7.0f}KB"
                  f"  {bundled + '.m4a' if bundled else '—'}")
        print("-" * 60)

    checked = [s for s in specs if s["name"] in BUNDLE]
    if args.check:
        if not checked:
            # --only naming an unbundled sound verifies nothing; saying
            # "all current" there would be a green light for an unrun check.
            print("nothing bundled in this run — no bundled sound was verified")
        elif stale:
            print("differs from this machine's toolchain: " + ", ".join(stale))
        else:
            print(f"all {len(checked)} bundled sounds current")
    else:
        print(f"{len(specs)} rendered, {len([s for s in specs if s['name'] in BUNDLE])} "
              f"bundled into {BUNDLE_DIR.relative_to(ROOT)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
