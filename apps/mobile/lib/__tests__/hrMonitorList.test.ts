import { readFileSync } from 'fs';
import { join } from 'path';

import {
  isPairedMonitorConnected,
  liveHRStatusLabel,
  pairedMonitorStatusLabel,
  type LiveHRState,
} from '../hrMonitor/heartRateProfile';
import { monitorRowA11yLabel, monitorRows, shortDeviceTag, signalWord } from '../hrMonitor/monitorList';

/**
 * W20/#986 — two identical Amazfit Helio Straps were indistinguishable in the
 * scan list, and the paired row printed the device name where the connection
 * state belongs.
 *
 * The two directions are tested equally hard: a collision must be separable,
 * and — the common case, which is the one that regresses silently — a scan
 * with no collision must stay a bare list of names.
 */

const IOS_A = '9A2F1C3D-4B5E-6789-ABCD-EF0123459F2A';
const IOS_B = '9A2F1C3D-4B5E-6789-ABCD-EF012345B71C';
const MAC_A = 'C4:1B:F0:12:34:56';
const MAC_B = 'C4:1B:F0:12:AB:CD';

describe('shortDeviceTag', () => {
  it('reads the same on an iOS UUID and an Android MAC', () => {
    expect(shortDeviceTag(IOS_A)).toBe('9F2A');
    expect(shortDeviceTag(MAC_A)).toBe('3456');
  });
  it('widens on request and lower-cases nothing back', () => {
    expect(shortDeviceTag(IOS_A, 6)).toBe('459F2A');
    expect(shortDeviceTag('ab:cd', 4)).toBe('ABCD');
  });
  it('is empty only when the id carries no alphanumerics at all', () => {
    expect(shortDeviceTag('::--::')).toBe('');
    expect(shortDeviceTag('7')).toBe('7');
  });
});

describe('signalWord', () => {
  it('three coarse buckets, on the dBm boundaries', () => {
    expect(signalWord(-45)).toBe('strong signal');
    expect(signalWord(-60)).toBe('strong signal');
    expect(signalWord(-61)).toBe('good signal');
    expect(signalWord(-80)).toBe('good signal');
    expect(signalWord(-81)).toBe('weak signal');
  });
  it('says nothing at all when the radio reported nothing', () => {
    expect(signalWord(null)).toBeNull();
    expect(signalWord(undefined)).toBeNull();
    expect(signalWord(Number.NaN)).toBeNull();
  });
});

describe('monitorRows — the common case stays clean', () => {
  it('a single monitor gets no detail line', () => {
    expect(monitorRows([{ id: IOS_A, name: 'Polar H10', rssi: -55 }])).toEqual([
      { id: IOS_A, name: 'Polar H10', detail: null },
    ]);
  });
  it('several monitors with DIFFERENT names all stay bare — no tag, no signal', () => {
    const rows = monitorRows([
      { id: IOS_A, name: 'Polar H10', rssi: -55 },
      { id: IOS_B, name: 'Amazfit Helio Strap', rssi: -72 },
      { id: MAC_A, name: 'Garmin HRM-Pro', rssi: -88 },
    ]);
    expect(rows.map((r) => r.detail)).toEqual([null, null, null]);
    expect(rows.map((r) => r.name)).toEqual(['Polar H10', 'Amazfit Helio Strap', 'Garmin HRM-Pro']);
  });
  it('an empty scan is an empty list', () => {
    expect(monitorRows([])).toEqual([]);
  });
});

describe('monitorRows — a shared name is separated', () => {
  it('two straps of the same model get a tag and a signal word, and nothing else does', () => {
    const rows = monitorRows([
      { id: IOS_A, name: 'Amazfit Helio Strap', rssi: -48 },
      { id: 'AA:BB:CC:DD:EE:FF', name: 'Polar H10', rssi: -70 },
      { id: IOS_B, name: 'Amazfit Helio Strap', rssi: -85 },
    ]);
    expect(rows[0].detail).toBe('9F2A · strong signal');
    expect(rows[1].detail).toBeNull();
    expect(rows[2].detail).toBe('B71C · weak signal');
    // Discovery order is preserved — rows must not move under a finger.
    expect(rows.map((r) => r.id)).toEqual([IOS_A, 'AA:BB:CC:DD:EE:FF', IOS_B]);
  });
  it('MACs separate on the same rule', () => {
    const rows = monitorRows([
      { id: MAC_A, name: 'HRM', rssi: null },
      { id: MAC_B, name: 'HRM', rssi: null },
    ]);
    expect(rows.map((r) => r.detail)).toEqual(['3456', 'ABCD']);
  });
  it('the tag widens to 6 rather than printing the same thing twice', () => {
    // Last 4 collide ("1234"); last 6 separates them.
    const rows = monitorRows([
      { id: 'AA:BB:CC:12:34', name: 'HRM' },
      { id: 'AA:BB:DD:12:34', name: 'HRM' },
    ]);
    expect(rows.map((r) => r.detail)).toEqual(['CC1234', 'DD1234']);
  });
  it('widens to 8 when 6 still collides', () => {
    // Last 4 and last 6 both collide ("3344" / "223344"); last 8 separates.
    const rows = monitorRows([
      { id: 'AA:BB:11:22:33:44', name: 'HRM' },
      { id: 'AA:CC:99:22:33:44', name: 'HRM' },
    ]);
    expect(rows.map((r) => r.detail)).toEqual(['11223344', '99223344']);
  });
  it('falls back to the whole id when no tag width separates them', () => {
    const rows = monitorRows([
      { id: 'a1-aabbccddeeff', name: 'HRM' },
      { id: 'a2-aabbccddeeff', name: 'HRM' },
    ]);
    expect(rows.map((r) => r.detail)).toEqual(['A1AABBCCDDEEFF', 'A2AABBCCDDEEFF']);
  });
  it('two rows are ALWAYS tellable apart, even when no tag width separates them', () => {
    const rows = monitorRows([
      { id: '::--::', name: 'HRM' },
      { id: '::__::', name: 'HRM' },
    ]);
    expect(rows.map((r) => r.detail)).toEqual(['#1', '#2']);
  });
  it('three of a kind all get distinct tags', () => {
    const rows = monitorRows([
      { id: IOS_A, name: 'HRM' },
      { id: IOS_B, name: 'HRM' },
      { id: MAC_A, name: 'HRM' },
    ]);
    expect(new Set(rows.map((r) => r.detail)).size).toBe(3);
    expect(rows.every((r) => r.detail !== null)).toBe(true);
  });
});

describe('monitorRowA11yLabel', () => {
  it('speaks the detail when there is one, and only the name when there is not', () => {
    expect(monitorRowA11yLabel({ id: 'x', name: 'Polar H10', detail: null })).toBe('Use Polar H10');
    expect(monitorRowA11yLabel({ id: 'x', name: 'Amazfit Helio Strap', detail: '9F2A · strong signal' })).toBe(
      'Use Amazfit Helio Strap, 9F2A · strong signal',
    );
  });
});

describe('pairedMonitorStatusLabel — a state, never the device name', () => {
  const dev = { id: IOS_A, name: 'Amazfit Helio Strap' };
  const base: LiveHRState = { status: 'off', device: null, bpm: null, at: null, attempt: 0 };

  it('names the connection state for every status', () => {
    expect(pairedMonitorStatusLabel(base)).toBe('Not connected');
    expect(pairedMonitorStatusLabel({ ...base, status: 'connecting', device: dev })).toBe('Connecting…');
    expect(pairedMonitorStatusLabel({ ...base, status: 'connected', device: dev })).toBe('Connected');
    expect(pairedMonitorStatusLabel({ ...base, status: 'reconnecting', device: dev })).toBe(
      'Disconnected — reconnecting…',
    );
    expect(pairedMonitorStatusLabel({ ...base, status: 'disconnected', device: dev })).toBe('Disconnected');
    expect(pairedMonitorStatusLabel({ ...base, status: 'unsupported' })).toBe('Bluetooth not available');
  });

  it('never returns the device name, in any state', () => {
    for (const status of ['off', 'unsupported', 'connecting', 'connected', 'reconnecting', 'disconnected'] as const) {
      const label = pairedMonitorStatusLabel({ ...base, status, device: dev }, dev.id);
      expect(label).not.toContain(dev.name);
      expect(label).not.toBe('');
    }
  });

  it('a link held for some OTHER device does not read as this row being connected', () => {
    const other = { id: IOS_B, name: 'Polar H10' };
    expect(pairedMonitorStatusLabel({ ...base, status: 'connected', device: other }, dev.id)).toBe('Not connected');
    expect(pairedMonitorStatusLabel({ ...base, status: 'connected', device: dev }, dev.id)).toBe('Connected');
    // Without an id to compare against, the live state is taken at face value.
    expect(pairedMonitorStatusLabel({ ...base, status: 'connected', device: other })).toBe('Connected');
  });

  it('the mismatch guard fires in EVERY connectable state, not just connected', () => {
    const other = { id: IOS_B, name: 'Polar H10' };
    for (const status of ['connecting', 'connected', 'reconnecting', 'disconnected'] as const) {
      expect(pairedMonitorStatusLabel({ ...base, status, device: other }, dev.id)).toBe('Not connected');
    }
    // `unsupported` is about the binary, not about any one device, so it wins.
    expect(pairedMonitorStatusLabel({ ...base, status: 'unsupported', device: other }, dev.id)).toBe(
      'Bluetooth not available',
    );
  });

  it('the row icon and the row words cannot disagree', () => {
    const other = { id: IOS_B, name: 'Polar H10' };
    for (const status of ['off', 'unsupported', 'connecting', 'connected', 'reconnecting', 'disconnected'] as const) {
      for (const device of [null, dev, other]) {
        for (const id of [undefined, dev.id, null]) {
          const state: LiveHRState = { ...base, status, device };
          expect(isPairedMonitorConnected(state, id)).toBe(pairedMonitorStatusLabel(state, id) === 'Connected');
        }
      }
    }
  });

  it('the in-session chip still says the device name — the two labels are different on purpose', () => {
    const connected: LiveHRState = { status: 'connected', device: dev, bpm: 140, at: null, attempt: 0 };
    expect(liveHRStatusLabel(connected)).toBe(dev.name);
    expect(pairedMonitorStatusLabel(connected, dev.id)).toBe('Connected');
  });
});

/**
 * W20/#986 — a WIRING invariant, checked at the source level for the same
 * reason `hrReportWiring.test.ts` does it: no unit test can see across files,
 * and the defect this ticket is about was exactly a call site reaching for the
 * wrong label. The pure functions can be perfect and the screen can still call
 * `liveHRStatusLabel` in the paired row, which is the bug as filed.
 */
describe('the pairing screen is wired to the row label, not the chip label', () => {
  const source = readFileSync(
    join(__dirname, '..', '..', 'components', 'settings', 'HRMonitorPairing.tsx'),
    'utf8',
  );

  it('the paired row uses `pairedMonitorStatusLabel` and never the chip label', () => {
    expect(source).toContain('pairedMonitorStatusLabel(live, remembered.id)');
    expect(source).not.toContain('liveHRStatusLabel');
  });

  it('the row icon asks the shared predicate rather than reading the status itself', () => {
    expect(source).toContain('isPairedMonitorConnected(live, remembered.id)');
    expect(source).not.toContain("live.status === 'connected'");
  });

  it('the scan list renders `monitorRows`, so a same-name collision is separated', () => {
    expect(source).toContain('monitorRows(found)');
    expect(source).toContain('monitorRowA11yLabel(row)');
  });
});
