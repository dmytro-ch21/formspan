import {
  LIVE_HR_INITIAL,
  LIVE_HR_STALE_AFTER_MS,
  RECONNECT_DELAYS_MS,
  decodeBase64,
  isLiveReadingFresh,
  liveHRStatusLabel,
  parseHeartRateMeasurement,
  reconnectDelayMs,
  reduceLiveHR,
  type LiveHRState,
} from '../hrMonitor/heartRateProfile';

/**
 * N528/#958 — the Bluetooth Heart Rate Profile decoded, the live-state
 * machine, and the two numbers the screens depend on (zone, staleness), all
 * without a radio. The byte layouts are from HRS 1.0 §3.1.1 and were checked
 * against the Bluetooth SIG's own examples rather than against this parser.
 */

const bytes = (...b: number[]) => Uint8Array.from(b);

describe('parseHeartRateMeasurement', () => {
  it('UINT8 value, no contact info, no extras — the commonest frame', () => {
    expect(parseHeartRateMeasurement(bytes(0x00, 142))).toEqual({ bpm: 142, sensorContact: null, rrIntervalsMs: [] });
  });

  it('UINT16 value (flag bit 0), little-endian', () => {
    expect(parseHeartRateMeasurement(bytes(0x01, 0x2c, 0x01))?.bpm).toBe(300);
  });

  it('sensor contact: supported + detected, supported + not detected, unsupported', () => {
    expect(parseHeartRateMeasurement(bytes(0x06, 90))?.sensorContact).toBe(true);
    expect(parseHeartRateMeasurement(bytes(0x04, 90))?.sensorContact).toBe(false);
    expect(parseHeartRateMeasurement(bytes(0x00, 90))?.sensorContact).toBeNull();
  });

  it('energy expended (bit 3) is skipped, RR intervals (bit 4) are converted from 1/1024 s to ms', () => {
    // flags 0x18: EE present + RR present; bpm 100; EE 0x0102; RR 1024 (=1000 ms), 512 (=500 ms)
    const parsed = parseHeartRateMeasurement(bytes(0x18, 100, 0x02, 0x01, 0x00, 0x04, 0x00, 0x02));
    expect(parsed).toEqual({ bpm: 100, sensorContact: null, rrIntervalsMs: [1000, 500] });
  });

  it('a frame too short for what its flags claim is null, never a fabricated number', () => {
    expect(parseHeartRateMeasurement(bytes())).toBeNull();
    expect(parseHeartRateMeasurement(bytes(0x00))).toBeNull();
    expect(parseHeartRateMeasurement(bytes(0x01, 0x2c))).toBeNull(); // says 16-bit, has 8
    expect(parseHeartRateMeasurement(bytes(0x08, 100, 0x02))).toBeNull(); // says EE, has one byte of it
  });

  it('a trailing odd byte after RR pairs is ignored, not read as half an interval', () => {
    expect(parseHeartRateMeasurement(bytes(0x10, 100, 0x00, 0x04, 0x99))?.rrIntervalsMs).toEqual([1000]);
  });
});

describe('decodeBase64', () => {
  it('decodes what react-native-ble-plx hands over', () => {
    // "AI4=" is [0x00, 0x8e] — flags 0, 142 bpm.
    expect(Array.from(decodeBase64('AI4='))).toEqual([0x00, 0x8e]);
    expect(parseHeartRateMeasurement(decodeBase64('AI4='))?.bpm).toBe(142);
  });
  it('tolerates missing padding', () => {
    expect(Array.from(decodeBase64('AI4'))).toEqual([0x00, 0x8e]);
  });
});

describe('reconnectDelayMs', () => {
  it('walks the ladder and pins at the cap', () => {
    RECONNECT_DELAYS_MS.forEach((d, i) => expect(reconnectDelayMs(i)).toBe(d));
    expect(reconnectDelayMs(99)).toBe(RECONNECT_DELAYS_MS[RECONNECT_DELAYS_MS.length - 1]);
    expect(reconnectDelayMs(-3)).toBe(RECONNECT_DELAYS_MS[0]);
  });
  it('is monotonic — never quicker after more failures', () => {
    for (let i = 1; i < RECONNECT_DELAYS_MS.length; i++) expect(RECONNECT_DELAYS_MS[i]).toBeGreaterThan(RECONNECT_DELAYS_MS[i - 1]);
  });
});

describe('reduceLiveHR — the state machine', () => {
  const dev = { id: 'x', name: 'Amazfit GTR 4' };
  it('start → connecting; connected; reading proves the link and resets attempts', () => {
    let s = reduceLiveHR(LIVE_HR_INITIAL, { type: 'start', device: dev });
    expect(s.status).toBe('connecting');
    s = reduceLiveHR(s, { type: 'connected' });
    expect(s.status).toBe('connected');
    s = reduceLiveHR({ ...s, attempt: 3 }, { type: 'reading', bpm: 131, at: '2026-09-08T10:00:00.000Z' });
    expect(s).toMatchObject({ status: 'connected', bpm: 131, attempt: 0 });
  });
  it('dropped keeps the last number visible and counts the attempt; retry counts too; gave_up ends it', () => {
    let s: LiveHRState = { status: 'connected', device: dev, bpm: 131, at: 't', attempt: 0 };
    s = reduceLiveHR(s, { type: 'dropped' });
    expect(s).toMatchObject({ status: 'reconnecting', bpm: 131, attempt: 1 });
    s = reduceLiveHR(s, { type: 'retry' });
    expect(s.attempt).toBe(2);
    s = reduceLiveHR(s, { type: 'gave_up' });
    expect(s.status).toBe('disconnected');
  });
  it('stop and unsupported both return to a known state', () => {
    const s: LiveHRState = { status: 'connected', device: dev, bpm: 131, at: 't', attempt: 0 };
    expect(reduceLiveHR(s, { type: 'stop' })).toEqual(LIVE_HR_INITIAL);
    expect(reduceLiveHR(s, { type: 'unsupported' }).status).toBe('unsupported');
  });
});

describe('isLiveReadingFresh + status labels', () => {
  const at = new Date('2026-09-08T10:00:00.000Z');
  const connected: LiveHRState = { status: 'connected', device: { id: 'x', name: 'Polar H10' }, bpm: 140, at: at.toISOString(), attempt: 0 };
  it('fresh inside the stale window, stale past it, never fresh while not connected', () => {
    expect(isLiveReadingFresh(connected, new Date(at.getTime() + LIVE_HR_STALE_AFTER_MS))).toBe(true);
    expect(isLiveReadingFresh(connected, new Date(at.getTime() + LIVE_HR_STALE_AFTER_MS + 1))).toBe(false);
    expect(isLiveReadingFresh({ ...connected, status: 'reconnecting' }, at)).toBe(false);
  });
  it('a drop is a sentence, never silence', () => {
    expect(liveHRStatusLabel({ ...connected, status: 'reconnecting' })).toMatch(/disconnected — reconnecting/);
    expect(liveHRStatusLabel({ ...connected, status: 'disconnected' })).toMatch(/disconnected/);
    expect(liveHRStatusLabel(connected)).toBe('Polar H10');
    expect(liveHRStatusLabel(LIVE_HR_INITIAL)).toBe('');
  });
});
