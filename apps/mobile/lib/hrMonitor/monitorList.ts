/**
 * W20/#986 — telling two identical straps apart in the scan list.
 *
 * The athlete owns two Amazfit Helio Straps. Both advertise the same name, so
 * the scan list showed "Amazfit Helio Strap" twice with nothing between them
 * and picking one was a coin toss.
 *
 * THE RULE, decided in the ticket: a scan row shows the advertised name and
 * NOTHING ELSE — unless another row in the same scan advertises the same
 * name, in which case every row in that group earns a second line built from
 *
 *   1. a short id tag, and
 *   2. the signal strength, when the radio reported one.
 *
 * Why both, and why conditional:
 *
 * - The id is the ONLY thing that genuinely differs between two units of the
 *   same model, and it is stable, so the choice is repeatable: the row you
 *   picked is the row you will see paired. It is also unreadable — nothing
 *   on the strap prints it — so on its own it says "these are two devices"
 *   and not "this is the one in my hand".
 * - Signal strength is the part the athlete can ACT on: hold the one you want
 *   against the phone, walk the other one out of the room, scan again. It is
 *   not an identifier (it moves, and two straps on the same desk read alike),
 *   which is why it never appears without the tag.
 * - Conditional because the common case is ONE monitor, and a hex tag on a
 *   lone "Polar H10" is clutter that answers a question nobody asked. A row
 *   is plain until its name is ambiguous.
 *
 * The tag is the last 4 alphanumerics of the platform id, upper-cased. That
 * id is a CoreBluetooth UUID on iOS (`...-9F2A`) and a MAC on Android
 * (`C4:1B:F0:12:34:56`), so stripping the separators and taking the tail
 * reads the same on both: a 4-character hex tag. If two colliding devices
 * happen to share that tail it widens (4 → 6 → 8 → whole id) rather than
 * printing two identical tags, and an id with no alphanumerics at all falls
 * back to an ordinal, so two rows are ALWAYS tellable apart.
 *
 * Pure on purpose: `liveHR.ts` owns Bluetooth, this owns what the list says.
 */

/** What a scan reports. Structural, so this file never imports `liveHR.ts`
 *  (which pulls in `react-native`) and stays a pure-logic test. */
export type ScannedMonitor = { id: string; name: string; rssi?: number | null };

/** One row of the scan list. `detail` is `null` for an unambiguous name. */
export type MonitorRow = { id: string; name: string; detail: string | null };

const TAG_WIDTHS = [4, 6, 8] as const;

/**
 * The short, readable form of a platform device id: the last `chars`
 * alphanumerics, upper-cased. Empty when the id carries none.
 */
export function shortDeviceTag(id: string, chars = 4): string {
  const clean = id.replace(/[^a-zA-Z0-9]/g, '').toUpperCase();
  if (clean === '') return '';
  return clean.slice(-Math.max(1, chars));
}

/**
 * BLE RSSI in dBm as a word. Thresholds are the usual reading of the scale
 * (-60 and better is a device in the same room and close; past -80 it is
 * across the room or through a body) — deliberately three coarse buckets,
 * because this is "which of these two is nearer", not a measurement.
 */
export function signalWord(rssi: number | null | undefined): string | null {
  if (typeof rssi !== 'number' || !Number.isFinite(rssi)) return null;
  if (rssi >= -60) return 'strong signal';
  if (rssi >= -80) return 'good signal';
  return 'weak signal';
}

/**
 * The scan list as rendered: name always, a disambiguating detail only for
 * rows whose name is shared with another row of the same scan. Input order
 * is preserved — rows must not move under a finger that is already reaching
 * for one.
 */
export function monitorRows(found: readonly ScannedMonitor[]): MonitorRow[] {
  const byName = new Map<string, ScannedMonitor[]>();
  for (const d of found) {
    const group = byName.get(d.name);
    if (group) group.push(d);
    else byName.set(d.name, [d]);
  }

  /** Per ambiguous name: the tag each of its devices gets. */
  const tags = new Map<string, string>();
  for (const group of byName.values()) {
    if (group.length < 2) continue;
    let chosen: string[] | null = null;
    for (const width of TAG_WIDTHS) {
      const candidate = group.map((d) => shortDeviceTag(d.id, width));
      if (candidate.every((t) => t !== '') && new Set(candidate).size === group.length) {
        chosen = candidate;
        break;
      }
    }
    // Nothing short enough separated them: the whole id does, since a scan
    // reports each id once. An id with no alphanumerics at all (never seen
    // from CoreBluetooth or Android, but the promise above is "always") has
    // nothing to print, so that group falls back to ordinals.
    if (!chosen) {
      const full = group.map((d) => shortDeviceTag(d.id, d.id.length || 1));
      chosen =
        full.every((t) => t !== '') && new Set(full).size === group.length
          ? full
          : group.map((_, i) => `#${i + 1}`);
    }
    group.forEach((d, i) => tags.set(d.id, chosen![i]));
  }

  return found.map((d) => {
    const tag = tags.get(d.id);
    if (tag == null) return { id: d.id, name: d.name, detail: null };
    const signal = signalWord(d.rssi);
    return { id: d.id, name: d.name, detail: signal ? `${tag} · ${signal}` : tag };
  });
}

/** What a screen reader hears for one row — the same information, spoken. */
export function monitorRowA11yLabel(row: MonitorRow): string {
  return row.detail ? `Use ${row.name}, ${row.detail}` : `Use ${row.name}`;
}
