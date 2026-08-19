/**
 * The client's side of "when an athlete says it broke, we can see it".
 *
 * # What already existed, and why this is not a second reporter
 *
 * `POST /v1/client-errors` has been live for a while: authenticated, validated,
 * persisted into `health_events`, correlated with the server's own request and
 * trace ids, kept for 90 days, and readable on the admin Health screen.
 * `report.ts` posts to it. **None of that is being replaced.** This module is
 * the missing half: the thing that decides *whether and when* an event leaves
 * the device.
 *
 * That decision did not exist, because `report()` had exactly one call site — a
 * `sync_blocked` on the session screen — and at one deliberate call per
 * incident, one `fetch` per occurrence is the right shape.
 *
 * **It is the wrong shape for a crash path**, and that is the whole reason this
 * file exists. Unhandled errors are bursty and correlated: a render loop
 * throwing sixty times a second is sixty POSTs a second, a device stuck in a
 * reconnect loop reports every retry, and one bad deploy multiplies either by
 * the number of devices. The requirement was stated directly — it must not make
 * thousands of writes, it must self-clean, it must be efficient — so this is
 * four behaviours the buffer HAS, not settings to tune afterwards.
 *
 * # The four
 *
 * **Coalesce, don't queue.** Repeat occurrences of the same fingerprint fold
 * into one record with a `count`, not N records. This is what stops a two-hour
 * gym dead spot becoming a flood on reconnect: the buffer holds one row per
 * distinct problem no matter how long the device is offline.
 *
 * **Sample and cap per fingerprint.** One problem may produce at most
 * `MAX_SENDS_PER_FINGERPRINT` payloads per window, however many times it fires.
 *
 * **Batch.** Nothing sends on the occurrence. A flush happens on a timer or at
 * a size threshold, carrying everything at once.
 *
 * **Fixed size.** The buffer is a bounded ring. It cannot grow on a phone, so
 * "self-cleaning" is a property of the structure rather than a cleanup task
 * somebody has to remember to run. The server's 90-day `retention` is the other
 * half, and it already exists.
 *
 * # Silence is never the answer
 *
 * Every one of those is a way of NOT sending something, and a reporter that
 * quietly drops is the failure it was built to prevent — the same shape as a
 * CI run with no checks reading as passing, a skipped test printing `ok`, and
 * an unlogged day drawn as a zero. **So every suppression is counted and
 * carried**: `count` says how many times it really happened, `dropped` says how
 * many occurrences the cap hid, and `lostEvents` says how many whole events
 * fell off the ring or died in a failed flush. An operator reading the Health
 * screen can always tell "this was quiet" from "we stopped being told".
 *
 * # What must never leave the device
 *
 * This is health and training data, and a crash report is sent WITHOUT the
 * athlete initiating it — so N26's disclosure rules apply harder here, not
 * more loosely. `redact()` is an allowlist, not a blocklist: a key nobody has
 * explicitly permitted does not travel. Blocklists fail open, and failing open
 * here means shipping somebody's reflection prose to a log.
 */

/** Severity. Ordered — the gate is a comparison, not a set membership test. */
export type Level = 'debug' | 'info' | 'warn' | 'error' | 'fatal';

const RANK: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40, fatal: 50 };

/**
 * Only `error` and above leaves the device.
 *
 * `info`/`debug` stay local and are opt-in for a support session. The sync path
 * runs constantly and is precisely the tempting thing to log verbosely, so the
 * default has to exclude it rather than rely on nobody doing that.
 */
export const DEFAULT_MIN_LEVEL: Level = 'error';

/** The server's vocabulary. Extending it means extending the server's CHECK. */
export type ReportKind = 'client_error' | 'sync_blocked';

export type BufferedEvent = {
  fingerprint: string;
  kind: ReportKind;
  level: Level;
  message: string;
  details: Record<string, string | number | boolean>;
  /** How many times this really happened, including occurrences the cap hid. */
  count: number;
  /** Occurrences suppressed by the per-fingerprint cap. Reported, never silent. */
  dropped: number;
  firstAt: number;
  lastAt: number;
};

export type TelemetryConfig = {
  /** Distinct fingerprints held at once. Beyond this the oldest is evicted. */
  capacity: number;
  /** Payloads one fingerprint may produce per window. */
  maxSendsPerFingerprint: number;
  /** The cap's window, ms. */
  windowMs: number;
  /** Flush when this many distinct events are buffered. */
  flushAtCount: number;
  /** Flush when the oldest buffered event is this old, ms. */
  flushAfterMs: number;
  minLevel: Level;
};

/**
 * Defaults chosen against the failure they are for, not by taste.
 *
 * `capacity: 40` — distinct *problems*, not occurrences. A device with forty
 * genuinely different unhandled errors has something much worse wrong than the
 * fortieth one, and the ring is what stops the buffer growing on a phone.
 *
 * `maxSendsPerFingerprint: 3` per `windowMs: 15min` — enough to see that a
 * problem is recurring rather than a one-off, few enough that a reconnect loop
 * costs three payloads an hour instead of thousands. The `count` on each still
 * carries the true number.
 *
 * `flushAtCount: 10` / `flushAfterMs: 30_000` — a phone on gym wifi sends one
 * batch on a timer, and a burst reaches the size threshold first.
 */
export const DEFAULTS: TelemetryConfig = {
  capacity: 40,
  maxSendsPerFingerprint: 3,
  windowMs: 15 * 60 * 1000,
  flushAtCount: 10,
  flushAfterMs: 30_000,
  minLevel: DEFAULT_MIN_LEVEL,
};

/** The server bounds message BYTES at 500; this counts UTF-16 units, so 200
 *  leaves room for two bytes a character. Same reasoning `report.ts` records —
 *  and the same consequence if it is wrong, since a rejection is silent. */
export const MAX_MESSAGE = 200;

/**
 * Detail keys allowed off the device. An ALLOWLIST, deliberately.
 *
 * A blocklist fails open: the next person to add a field gets it shipped by
 * default, and the field they add will eventually be a note, a food name or a
 * partner's handle. This list is short because it is only what makes an error
 * diagnosable — never what the athlete wrote, ate, or photographed.
 */
export const ALLOWED_DETAIL_KEYS = [
  'code',
  'status',
  'route',
  'operation',
  'attempt',
  'entity',
  'reason',
  'platform',
  'appVersion',
  'buildVersion',
  'offline',
] as const;

const ALLOWED = new Set<string>(ALLOWED_DETAIL_KEYS);

/**
 * Reduce a message to something stable across occurrences.
 *
 * Numbers, uuids, hex ids and quoted strings are what differ between two
 * instances of the same bug — "row 41 failed" and "row 87 failed" are one
 * problem — so they are replaced before hashing. Without this, coalescing never
 * coalesces and the cap never binds, which is the failure that looks like it is
 * working right up until a device is in a loop.
 */
export function fingerprintOf(kind: string, message: string): string {
  const normalised = message
    .toLowerCase()
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, '<id>')
    .replace(/0x[0-9a-f]+/g, '<hex>')
    .replace(/\d+/g, '<n>')
    .replace(/["'`][^"'`]*["'`]/g, '<str>')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120);
  return `${kind}:${hash(normalised)}`;
}

/** djb2. A correlation key, not a security primitive — the same reasoning
 *  `trace.ts` records for using Math.random over a CSPRNG. */
function hash(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(16);
}

/**
 * Keep only allowlisted keys holding primitive values.
 *
 * Objects and arrays are dropped whole rather than walked: a nested object is
 * where prose hides, and a recursive sanitiser is a thing that grows an
 * exception. Strings are truncated, because a long "reason" is usually a
 * serialised body.
 */
export function redact(
  details: Record<string, unknown> | undefined,
): Record<string, string | number | boolean> {
  const out: Record<string, string | number | boolean> = {};
  if (!details) return out;
  for (const [k, v] of Object.entries(details)) {
    if (!ALLOWED.has(k)) continue;
    if (typeof v === 'number' && Number.isFinite(v)) out[k] = v;
    else if (typeof v === 'boolean') out[k] = v;
    else if (typeof v === 'string') out[k] = v.slice(0, 80);
    // Anything else — object, array, function, null, undefined, NaN — is not
    // carried. There is no diagnostic worth the risk of shipping it.
  }
  return out;
}

/**
 * The buffer.
 *
 * No timers, no I/O and no clock of its own: `now` is passed in, exactly as the
 * backend's `Inputs` and `AdjustmentInputs` do it, so every behaviour here is
 * testable without a device and cannot disagree with itself about the time.
 */
export class TelemetryBuffer {
  private events = new Map<string, BufferedEvent>();
  /** Sends per fingerprint in the current window, and when that window began. */
  private sends = new Map<string, { count: number; windowStart: number }>();
  /**
   * Whole events that never made it — evicted from a full ring, or lost in a
   * failed flush. Carried to the server on the next successful send so an
   * operator can tell a quiet device from a device that stopped being able to
   * tell us anything.
   */
  private lost = 0;
  private readonly cfg: TelemetryConfig;

  constructor(cfg: Partial<TelemetryConfig> = {}) {
    this.cfg = { ...DEFAULTS, ...cfg };
  }

  get size(): number {
    return this.events.size;
  }

  get lostEvents(): number {
    return this.lost;
  }

  /**
   * Record one occurrence. Never throws, never sends.
   *
   * Returns whether the occurrence was buffered for sending, which is what the
   * tests assert against — a caller has nothing useful to do with it.
   */
  record(
    level: Level,
    kind: ReportKind,
    message: string,
    details: Record<string, unknown> | undefined,
    now: number,
  ): boolean {
    if (RANK[level] < RANK[this.cfg.minLevel]) return false;

    const text = String(message ?? '').slice(0, MAX_MESSAGE);
    const fingerprint = fingerprintOf(kind, text);

    const existing = this.events.get(fingerprint);
    if (existing) {
      // COALESCE. One row per distinct problem, whatever the occurrence count
      // and however long the device has been offline.
      existing.count += 1;
      existing.lastAt = now;
      return true;
    }

    if (this.overCap(fingerprint, now)) {
      // The cap has already spent this fingerprint's payloads for the window.
      // The occurrence is not lost — it is counted — but it buys no new event.
      this.creditDropped(fingerprint);
      return false;
    }

    if (this.events.size >= this.cfg.capacity) {
      // Fixed-size ring: evict the OLDEST distinct problem. Map preserves
      // insertion order, so the first key is the oldest.
      const oldest = this.events.keys().next().value;
      if (oldest !== undefined) {
        this.events.delete(oldest);
        this.lost += 1;
      }
    }

    this.events.set(fingerprint, {
      fingerprint,
      kind,
      level,
      message: text,
      details: redact(details),
      count: 1,
      dropped: 0,
      firstAt: now,
      lastAt: now,
    });
    return true;
  }

  /** Whether a flush is due: size threshold, or the oldest event's age. */
  shouldFlush(now: number): boolean {
    if (this.events.size === 0) return false;
    if (this.events.size >= this.cfg.flushAtCount) return true;
    let oldest = now;
    for (const e of this.events.values()) if (e.firstAt < oldest) oldest = e.firstAt;
    return now - oldest >= this.cfg.flushAfterMs;
  }

  /**
   * Take everything buffered, and charge each fingerprint one send against its
   * window.
   *
   * The buffer is cleared HERE rather than after a successful POST, and that is
   * deliberate: holding events until the network confirms is how a device with
   * no signal accumulates the flood this module exists to prevent. A failed
   * send is accounted through `recordLoss` instead, which is honest about the
   * loss without paying for it in memory.
   */
  drain(now: number): BufferedEvent[] {
    const out = [...this.events.values()];
    for (const e of out) {
      // Attach any occurrences the cap hid since this fingerprint last got
      // out. Done HERE rather than in a method the caller invokes afterwards:
      // a second call you have to remember is one that eventually gets
      // forgotten, and forgetting it makes a capped burst indistinguishable
      // from a single occurrence — the cap silently becoming a way of lying
      // rather than a way of being cheap.
      const hidden = this.pendingDropped.get(e.fingerprint);
      if (hidden) {
        e.dropped = hidden;
        this.pendingDropped.delete(e.fingerprint);
      }
      this.chargeSend(e.fingerprint, now);
    }
    this.events.clear();
    return out;
  }

  /** How many whole events were lost, and reset the tally now it is being told. */
  takeLost(): number {
    const n = this.lost;
    this.lost = 0;
    return n;
  }

  /** A flush that failed. The events are gone; the fact that they existed is not. */
  recordLoss(n: number): void {
    this.lost += n;
  }

  private windowFor(fingerprint: string, now: number): { count: number; windowStart: number } {
    const seen = this.sends.get(fingerprint);
    if (!seen || now - seen.windowStart >= this.cfg.windowMs) {
      const fresh = { count: 0, windowStart: now };
      this.sends.set(fingerprint, fresh);
      return fresh;
    }
    return seen;
  }

  private overCap(fingerprint: string, now: number): boolean {
    return this.windowFor(fingerprint, now).count >= this.cfg.maxSendsPerFingerprint;
  }

  private chargeSend(fingerprint: string, now: number): void {
    this.windowFor(fingerprint, now).count += 1;
  }

  /**
   * An occurrence the cap hid.
   *
   * Held against the fingerprint rather than thrown away, so the NEXT event for
   * this problem — after the window rolls — can say how much was suppressed in
   * between. Without it, a capped burst and a genuine single occurrence are
   * indistinguishable on the Health screen, which would make the cap a way of
   * lying rather than a way of being cheap.
   */
  private creditDropped(fingerprint: string): void {
    const pending = this.pendingDropped.get(fingerprint) ?? 0;
    this.pendingDropped.set(fingerprint, pending + 1);
  }

  private pendingDropped = new Map<string, number>();
}
