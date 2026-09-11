import { RANGE_DAYS, buildTrend } from '@/lib/trendSeries';
import {
  LOOKBACK_SLACK_DAYS,
  SERVER_MAX_LIST_RANGE_DAYS,
  VO2MAX_FETCH_DAYS,
  healthSourceFor,
  healthSourceLabel,
  healthSyncSettingLabel,
  latestReadingOn,
  readingAgePhrase,
  vo2MaxEmptyCopy,
  vo2MaxReadingOrigin,
  VO2MAX_MIN_TREND_READINGS,
  vo2MaxRowDetail,
  vo2MaxTrendEmpty,
  vo2MaxRanges,
  vo2MaxRowVisible,
  vo2MaxScreenState,
  vo2MaxFetchWindow,
  vo2MaxStateCopy,
} from '@/lib/vo2MaxSource';

/**
 * W16/#945 — the VO₂max screens decide what to show in one pure place.
 *
 * Nothing rendered can pin this: no test in the repo renders either VO₂max
 * screen, and under `jest-expo` `Platform.OS` is always `ios`, which is the
 * one platform on which the original bug did NOT show. So the platform is a
 * parameter here and the Android branch — the one that was wrong — is
 * exercised directly.
 */
describe('healthSourceFor — which source this device has', () => {
  it('is HealthKit on iOS only when the module is linked', () => {
    expect(healthSourceFor('ios', true)).toBe('healthkit');
    // An iOS build without HealthKit linked has NO source — the only case
    // in which "not available on this device" was ever true.
    expect(healthSourceFor('ios', false)).toBeNull();
  });

  it('is Health Connect on Android regardless of the HealthKit flag', () => {
    // The bug: Android was being judged by an iOS-only check. The flag is
    // meaningless there and must not be consulted.
    expect(healthSourceFor('android', false)).toBe('health_connect');
    expect(healthSourceFor('android', true)).toBe('health_connect');
  });

  it('is nothing on a platform with no health store', () => {
    expect(healthSourceFor('web', true)).toBeNull();
    expect(healthSourceFor('windows', false)).toBeNull();
  });
});

describe('the labels name the source the athlete actually has', () => {
  it('reads Apple Health / Health Connect', () => {
    expect(healthSourceLabel('healthkit')).toBe('Apple Health');
    expect(healthSourceLabel('health_connect')).toBe('Health Connect');
  });

  it("points at a Settings toggle that exists under exactly that name", () => {
    // Verbatim the `label` props in app/settings.tsx — a sentence that sends
    // the athlete to a switch called something else is a broken instruction.
    expect(healthSyncSettingLabel('healthkit')).toBe('Sync with Apple Health');
    expect(healthSyncSettingLabel('health_connect')).toBe('Sync with Health Connect');
  });
});

describe('vo2MaxScreenState — readings first, gates only when there is nothing to show', () => {
  const base = { loading: false, hasReadings: false, source: 'health_connect' as const, sourceAvailable: true, syncOn: true };

  it('shows the chart whenever readings exist, whatever the gates say', () => {
    // THE decision this ticket is about. Every gate below is set to the
    // value that would otherwise hide the screen, and none of them may.
    expect(vo2MaxScreenState({ ...base, hasReadings: true })).toBe('chart');
    expect(vo2MaxScreenState({ ...base, hasReadings: true, source: null })).toBe('chart');
    expect(vo2MaxScreenState({ ...base, hasReadings: true, sourceAvailable: false })).toBe('chart');
    expect(vo2MaxScreenState({ ...base, hasReadings: true, syncOn: false })).toBe('chart');
  });

  it('renders nothing while the first fetch is still settling — even with readings', () => {
    expect(vo2MaxScreenState({ ...base, loading: true })).toBe('loading');
    expect(vo2MaxScreenState({ ...base, loading: true, hasReadings: true })).toBe('loading');
  });

  it('says there is no source only when there genuinely is none', () => {
    expect(vo2MaxScreenState({ ...base, source: null })).toBe('no_source');
  });

  it('distinguishes a source this device cannot use from one that is switched off', () => {
    // An Android phone with no Health Connect provider: a true sentence
    // about the device, not about the athlete's settings.
    expect(vo2MaxScreenState({ ...base, sourceAvailable: false })).toBe('source_unavailable');
    // A usable source with the toggle off: point at the toggle.
    expect(vo2MaxScreenState({ ...base, syncOn: false })).toBe('sync_off');
  });

  it('keeps the spinner while an availability or sync read is still unanswered', () => {
    // `null` means "still asking". Review caught the first version falling
    // through to "nothing read yet" here, which then flipped to a different
    // sentence once the bridge replied — a screen that changes its mind is
    // worse than one that waits a moment. Monotonic: spinner until known.
    expect(vo2MaxScreenState({ ...base, sourceAvailable: null })).toBe('loading');
    expect(vo2MaxScreenState({ ...base, syncOn: null })).toBe('loading');
    // ...but only for the reads this source actually needs: HealthKit has no
    // async availability question, so a null there must not stall iOS.
    expect(vo2MaxScreenState({ ...base, source: 'healthkit', sourceAvailable: null })).toBe('empty');
  });

  it('shows the chart for readings ANYWHERE on the account, not only in the selected window', () => {
    // The reviewer's catch: the first version derived hasReadings from
    // `!series.empty`, which is also set for 'none-in-range' — fourteen
    // months of readings, a six-month default window, toggle off → the gate
    // fired and hid the chart AND the range picker. `hasReadings` is now the
    // server's answer over the whole fetch window; this pins that a caller
    // passing it correctly gets the chart even with every gate against it.
    expect(vo2MaxScreenState({ ...base, hasReadings: true, syncOn: false, sourceAvailable: false })).toBe('chart');
  });

  it('lets a FAILED fetch speak for itself rather than through a gate', () => {
    // Nothing is known when the fetch failed, so no gate may assert a grant
    // or a toggle state. 'empty' routes to the screen's own "Couldn't load"
    // sentence on the chart path.
    expect(vo2MaxScreenState({ ...base, fetchFailed: true, syncOn: false })).toBe('empty');
    expect(vo2MaxScreenState({ ...base, fetchFailed: true, source: null })).toBe('empty');
    // Readings still win over a failed re-fetch (stale data beats no data).
    expect(vo2MaxScreenState({ ...base, fetchFailed: true, hasReadings: true })).toBe('chart');
  });

  it('is empty when everything is on and nothing has been read', () => {
    expect(vo2MaxScreenState(base)).toBe('empty');
  });

  it('checks the gates in the order an athlete can act on them', () => {
    // No source outranks unavailable, which outranks sync-off: the first
    // is about the build, the second about the device, the third about a
    // setting — and only the last is something the athlete can change.
    expect(vo2MaxScreenState({ ...base, source: null, sourceAvailable: false, syncOn: false })).toBe('no_source');
    expect(vo2MaxScreenState({ ...base, sourceAvailable: false, syncOn: false })).toBe('source_unavailable');
  });
});

describe('vo2MaxStateCopy — true whenever it is on screen', () => {
  it('names the source the device has, never the other vendor', () => {
    expect(vo2MaxStateCopy('sync_off', 'health_connect')).toContain('Sync with Health Connect');
    expect(vo2MaxStateCopy('sync_off', 'health_connect')).not.toContain('Apple');
    expect(vo2MaxStateCopy('sync_off', 'healthkit')).toContain('Sync with Apple Health');
    expect(vo2MaxStateCopy('source_unavailable', 'health_connect')).toContain("Health Connect isn't available");
  });

  it('has nothing to say for the states that show data or nothing', () => {
    expect(vo2MaxStateCopy('chart', 'healthkit')).toBeNull();
    expect(vo2MaxStateCopy('loading', 'healthkit')).toBeNull();
    expect(vo2MaxStateCopy('empty', 'healthkit')).toBeNull();
  });

  it('keeps the original sentence for the one case it was always true in', () => {
    expect(vo2MaxStateCopy('no_source', null)).toBe("VO2max reading isn't available on this device.");
  });
});

describe('vo2MaxRowVisible — the You-tab row is data-first too', () => {
  it('shows the row on ANY device when the account has readings', () => {
    // Readings from a previous phone, or from the other platform on the same
    // account, are the athlete's regardless of what this handset can read.
    // This is the case the AC verifier caught the first version missing.
    expect(vo2MaxRowVisible({ hasReadings: true, source: null })).toBe(true);
    expect(vo2MaxRowVisible({ hasReadings: true, source: 'healthkit' })).toBe(true);
  });

  it('shows the row whenever the device has a source, so the screen can explain itself', () => {
    expect(vo2MaxRowVisible({ hasReadings: false, source: 'health_connect' })).toBe(true);
    expect(vo2MaxRowVisible({ hasReadings: false, source: 'healthkit' })).toBe(true);
  });

  it('hides it only with no readings AND no source', () => {
    // An iOS build with no HealthKit linked, for an athlete who has never
    // had a reading uploaded — the one case there is genuinely nothing.
    expect(vo2MaxRowVisible({ hasReadings: false, source: null })).toBe(false);
  });
});


/**
 * The fetch window — the two properties the server enforces and no rendered
 * test can see, because an absent server fails exactly like a refused one.
 */
describe('vo2MaxFetchWindow — what the samples endpoint will actually accept', () => {
  const RFC3339 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;
  const spanDays = (w: { from: string; to: string }) =>
    (Date.parse(w.to) - Date.parse(w.from)) / 86_400_000;

  it('emits RFC3339 with a time component on BOTH bounds', () => {
    // The You screen's first fetch sent `YYYY-MM-DD` and got a 400 from
    // `time.Parse(time.RFC3339, …)` on every call — swallowed, so the row's
    // "account has readings" branch was dead code behind a green test.
    const w = vo2MaxFetchWindow('2026-09-08');
    expect(w.from).toMatch(RFC3339);
    expect(w.to).toMatch(RFC3339);
    expect(w.to).toBe('2026-09-08T23:59:59Z');
  });

  it('never spans more than the server cap, tail included', () => {
    // `useVo2MaxTrend` asked for 365*3 + 14 days; the server caps at 400 and
    // refused every request the trend screen ever made. The `to` bound sits
    // at 23:59:59, so the span is a day less than whole days would suggest.
    const w = vo2MaxFetchWindow('2026-09-08');
    expect(spanDays(w)).toBeLessThan(SERVER_MAX_LIST_RANGE_DAYS);
    expect(spanDays(w)).toBeGreaterThan(SERVER_MAX_LIST_RANGE_DAYS - 3);
  });

  it('clamps a caller that asks for more than the cap allows', () => {
    // The old three-year request, made against the helper, is silently
    // narrowed rather than refused by the server.
    const w = vo2MaxFetchWindow('2026-09-08', 365 * 3);
    expect(spanDays(w)).toBeLessThan(SERVER_MAX_LIST_RANGE_DAYS);
  });

  it('adds the lookback slack on top of the requested window', () => {
    const w = vo2MaxFetchWindow('2026-09-08', 30);
    expect(w.from).toBe(`2026-${String(7).padStart(2, '0')}-${String(26).padStart(2, '0')}T00:00:00Z`);
    expect(30 + LOOKBACK_SLACK_DAYS).toBe(44);
  });

  it('keeps the default within the cap by construction', () => {
    expect(VO2MAX_FETCH_DAYS + LOOKBACK_SLACK_DAYS).toBeLessThan(SERVER_MAX_LIST_RANGE_DAYS);
  });
});


/**
 * F34/#955 — the range chips may not promise a window the fetch cannot fill.
 *
 * `All` was on this screen and means "back to the athlete's first reading";
 * the samples endpoint caps a query at `SERVER_MAX_LIST_RANGE_DAYS`, so it
 * showed about thirteen months under a label saying everything. The offered
 * set is DERIVED from the fetch window now, which is what these pin — the
 * arithmetic, not the constant, exactly as `vo2MaxFetchWindow`'s own tests do.
 */
describe('vo2MaxRanges — only windows this screen actually fetches', () => {
  const keys = () => vo2MaxRanges().map((r) => r.key);

  it('does not offer All — the label F34 removed', () => {
    // The whole ticket in one assertion: an unbounded label on a capped fetch.
    expect(keys()).not.toContain('All');
  });

  it('does not offer Plan either', () => {
    // Unchanged from W16: a nutrition/weight phase this metric has nothing to
    // do with. Kept here so the two exclusions cannot drift apart silently.
    expect(keys()).not.toContain('Plan');
  });

  it('makes 1Y the longest preset, and keeps every shorter one', () => {
    expect(keys()).toEqual(['1W', '1M', '3M', '6M', '1Y']);
  });

  it('offers nothing wider than the hook fetches', () => {
    // The property, not the list: every offered window has to fit inside what
    // `useVo2MaxTrend` asks the server for, or the chart is truncated under a
    // name that promises more. This is what F34 fixed, stated generally.
    for (const key of keys()) {
      expect(RANGE_DAYS[key as keyof typeof RANGE_DAYS]).toBeLessThanOrEqual(VO2MAX_FETCH_DAYS);
    }
  });

  it('DROPS a preset if the fetch window ever shrinks below it', () => {
    // Proves the list is derived rather than hand-written — the mutation that
    // would otherwise pass silently. If the server cap were lowered to a
    // quarter, `1Y` and `6M` would be the same lie `All` was.
    expect(vo2MaxRanges(100).map((r) => r.key)).toEqual(['1W', '1M', '3M']);
    expect(vo2MaxRanges(0).map((r) => r.key)).toEqual([]);
  });

  it('would ADMIT a wider preset if the cap were raised (option 3), untouched', () => {
    // The ticket's option (3) — a per-metric cap raise — needs no edit here:
    // a wider entry in `RANGES` with a `RANGE_DAYS` span would simply pass the
    // same filter. Pinned so a future raiser knows this file already follows.
    expect(vo2MaxRanges(10_000).map((r) => r.key)).toEqual(['1W', '1M', '3M', '6M', '1Y']);
  });
});

describe('vo2MaxEmptyCopy — never invites a range that does not exist', () => {
  it('offers a wider range only while there IS one', () => {
    // F34's second half. With `All` gone, `1Y` is the widest: telling an
    // athlete whose readings are all older than a year to "try a wider one"
    // is the same over-promise as the label this ticket removed.
    const empty = { kind: 'none-in-range', totalReadings: 3 } as const;
    expect(vo2MaxEmptyCopy(empty, 'healthkit', true)).toContain('Try a wider one');
    expect(vo2MaxEmptyCopy(empty, 'healthkit', false)).not.toContain('Try a wider one');
    expect(vo2MaxEmptyCopy(empty, 'healthkit', false)).toContain('than this screen reaches');
  });

  it('says how many readings are held either way, and pluralises', () => {
    expect(vo2MaxEmptyCopy({ kind: 'none-in-range', totalReadings: 1 }, null, true)).toContain('1 reading ');
    expect(vo2MaxEmptyCopy({ kind: 'none-in-range', totalReadings: 2 }, null, false)).toContain('2 readings ');
  });

  it('leaves the failed-fetch sentence alone, and keeps W16\'s source rule for none', () => {
    // The widest-range flag must not leak into copy that has nothing to do
    // with ranges — a failed fetch says the same thing at every width.
    for (const wider of [true, false]) {
      expect(vo2MaxEmptyCopy({ kind: 'unavailable' }, 'healthkit', wider)).toBe(
        "Couldn't load your VO2max trend. It'll be here when the connection is back.",
      );
      // W16: names the source THIS device reads from, never the other vendor.
      expect(vo2MaxEmptyCopy({ kind: 'none' }, 'health_connect', wider)).toContain('Health Connect');
      expect(vo2MaxEmptyCopy({ kind: 'none' }, 'health_connect', wider)).not.toContain('Apple');
      // No source: names no store at all rather than one this device lacks.
      expect(vo2MaxEmptyCopy({ kind: 'none' }, null, wider)).not.toMatch(/Apple|Health Connect/);
    }
  });
});



/**
 * N524/#939 — an empty chart says what WRITES a reading, rather than counting
 * how many are missing.
 *
 * The reporter's account had one VO₂max sample ever, from a strap that never
 * writes the metric, and the screen said "1 of 2 readings needed for a trend
 * line" — an invitation to keep checking back on a screen that could not fill.
 * These pin the three properties the fix rests on: the cause is stated in
 * both no-trend states, nothing invites a wait, and nothing judges the
 * athlete's device (HealthKit cannot tell the app which devices write it).
 */
describe('vo2MaxEmptyCopy — no-trend states explain the mechanism, never a wait (N524)', () => {
  const SOURCES = ['healthkit', 'health_connect', null] as const;
  const oneReading = { kind: 'too-few', have: 1, need: 2 } as const;
  const none = { kind: 'none' } as const;
  // 2026-08-21 is the reporter's one real reading; 2026-09-11 is 21 days on.
  const threeWeeks = { on: '2026-08-21', today: '2026-09-11' };

  /** Anything that tells the athlete to wait, or implies the number is filling. */
  const WAIT = /\byet\b|keep (checking|waiting)|check back|come back|will appear|appears here|soon|filling|on its way|give it time|needed for a trend line/i;
  /** A verdict about the athlete's own hardware — an inference the app cannot back. */
  const DEVICE_VERDICT = /your (device|watch|wearable|strap|monitor)\b[^.]*\b(doesn't|does not|can't|cannot|won't|will not|never|isn't|is not)\b/i;
  /** A vendor name that is not the store's own or the one watch that writes it on iOS. */
  const OTHER_BRAND = /\b(amazfit|zepp|garmin|polar|whoop|fitbit|oura|coros|suunto|samsung|wahoo|helio)\b/i;
  /** Shame or pressure: a nudge to train differently, or to buy something. */
  const PRESSURE = /\byou (need|should|must|have) to\b|\bbuy\b|\bupgrade\b|\bpurchase\b|train (more|harder|differently)|\bfail/i;

  it('the one-reading case explains what writes a reading, not only the count', () => {
    for (const source of SOURCES) {
      const copy = vo2MaxEmptyCopy(oneReading, source, true, threeWeeks);
      expect(copy).toContain("VOLA can't measure VO2max itself");
      expect(copy).toContain(vo2MaxReadingOrigin(source));
      // The count survives as the reason there is no line, scoped to the range.
      expect(copy).toContain('1 VO2max reading in this range — a trend line needs 2.');
    }
  });

  it('sets the explanation apart from the count, as its own paragraph', () => {
    // Review: one centred 437-character block lost its scanning edge.
    for (const empty of [none, oneReading]) {
      const [lead, origin] = vo2MaxEmptyCopy(empty, 'healthkit', true, threeWeeks).split('\n\n');
      expect(lead).not.toContain("can't measure");
      expect(origin).toBe(vo2MaxReadingOrigin('healthkit'));
    }
  });

  it('the one-reading case is no longer the bare count it was', () => {
    // THE regression: restoring W16's count-only sentence must fail here.
    const copy = vo2MaxEmptyCopy(oneReading, 'healthkit', true, threeWeeks);
    expect(copy).not.toBe('1 of 2 readings needed for a trend line.');
    expect(copy.length).toBeGreaterThan(120);
  });

  it('the zero-readings case explains it too, and no longer says "yet"', () => {
    for (const source of SOURCES) {
      const copy = vo2MaxEmptyCopy(none, source, true);
      expect(copy).toContain("VOLA can't measure VO2max itself");
      expect(copy).toContain('VOLA has no VO2max reading from the past year.');
    }
  });

  it('"the past year" is what the fetch actually covers', () => {
    // `none` means no reading over the fetch window, so the sentence may only
    // claim a year while the window reaches at least that far back.
    expect(VO2MAX_FETCH_DAYS).toBeGreaterThanOrEqual(365);
  });

  it('never invites the athlete to wait, in either no-trend state, on any source', () => {
    for (const source of SOURCES) {
      for (const empty of [none, oneReading, { kind: 'too-few', have: 3, need: 5 } as const]) {
        for (const latest of [null, threeWeeks, { on: '2026-09-10', today: '2026-09-11' }]) {
          expect(vo2MaxEmptyCopy(empty, source, true, latest)).not.toMatch(WAIT);
        }
      }
    }
  });

  it('says that with a device that never writes one, no new reading will arrive', () => {
    // The sentence the reporter needed — stated about the CLASS of device, so
    // it is true whatever they wear.
    for (const source of ['healthkit', 'health_connect'] as const) {
      const copy = vo2MaxEmptyCopy(oneReading, source, true, threeWeeks);
      expect(copy).toMatch(/Many other wearables and chest straps never write one/);
      expect(copy).toMatch(/no new reading will arrive/);
    }
  });

  it('never delivers a verdict about the athlete\'s own device', () => {
    for (const source of SOURCES) {
      for (const empty of [none, oneReading]) {
        const copy = vo2MaxEmptyCopy(empty, source, true, threeWeeks);
        expect(copy).not.toMatch(DEVICE_VERDICT);
        expect(copy).not.toMatch(OTHER_BRAND);
      }
    }
  });

  it('names Apple Watch only where it writes the metric — the HealthKit source', () => {
    expect(vo2MaxReadingOrigin('healthkit')).toContain('Apple Watch estimates it on outdoor walks, runs and hikes');
    expect(vo2MaxReadingOrigin('health_connect')).not.toContain('Apple');
    expect(vo2MaxReadingOrigin(null)).not.toContain('Apple');
  });

  it('states a fact, with no shame or pressure framing', () => {
    for (const source of SOURCES) {
      for (const empty of [none, oneReading]) {
        expect(vo2MaxEmptyCopy(empty, source, true, threeWeeks)).not.toMatch(PRESSURE);
      }
    }
  });

  it('points at the permission under the name the store gives it — and only where a store exists', () => {
    // An empty HealthKit read looks identical to a declined grant, so a
    // device that SHOULD write one gets the one check that can explain it.
    expect(vo2MaxReadingOrigin('healthkit')).toContain('check VOLA can read Cardio Fitness from Apple Health');
    // Health Connect's permission label has not been read off a device, so the
    // copy names the store and not a string the athlete might not find.
    expect(vo2MaxReadingOrigin('health_connect')).toContain('check VOLA can read it from Health Connect');
    // No store on this device: there is no permission to check, so no instruction.
    expect(vo2MaxReadingOrigin(null)).not.toMatch(/check VOLA/);
    expect(vo2MaxReadingOrigin(null)).toContain('this device has none VOLA can read from');
  });

  it('makes the newest reading\'s age legible in the one-reading case', () => {
    expect(vo2MaxEmptyCopy(oneReading, 'healthkit', true, threeWeeks)).toContain(
      'The latest is from 21 Aug, 3 weeks ago.',
    );
    // Yesterday and three weeks ago are different news, and must read differently.
    const yesterday = vo2MaxEmptyCopy(oneReading, 'healthkit', true, { on: '2026-09-10', today: '2026-09-11' });
    expect(yesterday).toContain('The latest is from yesterday.');
    expect(yesterday).not.toBe(vo2MaxEmptyCopy(oneReading, 'healthkit', true, threeWeeks));
  });

  it('drops the age rather than inventing one when the newest day is unknown', () => {
    for (const latest of [null, { on: null, today: '2026-09-11' }]) {
      const copy = vo2MaxEmptyCopy(oneReading, 'healthkit', true, latest);
      expect(copy).not.toContain('latest');
      expect(copy).toContain("VOLA can't measure VO2max itself");
    }
  });

  it('gives none-in-range the age too, but not the origin — readings exist, the range is the step', () => {
    const empty = { kind: 'none-in-range', totalReadings: 1 } as const;
    expect(vo2MaxEmptyCopy(empty, 'healthkit', true, threeWeeks)).toBe(
      'Nothing in this range — you have 1 reading further back, the latest from 21 Aug, 3 weeks ago. Try a wider one.',
    );
    expect(vo2MaxEmptyCopy(empty, 'healthkit', false, { on: '2025-08-20', today: '2026-09-11' })).toBe(
      'Nothing in this range — you have 1 reading further back than this screen reaches, the latest from 20 Aug 2025, over a year ago.',
    );
    expect(vo2MaxEmptyCopy(empty, 'healthkit', true, threeWeeks)).not.toContain("can't measure");
  });
});

describe('readingAgePhrase — a date and an age, never one without the other', () => {
  const today = '2026-09-11';

  it('says today and yesterday in words', () => {
    expect(readingAgePhrase('2026-09-11', today)).toBe('from today');
    expect(readingAgePhrase('2026-09-10', today)).toBe('from yesterday');
  });

  it('counts days, then weeks, then months, then gives up at a year', () => {
    expect(readingAgePhrase('2026-09-09', today)).toMatch(/^from 9 \w+, 2 days ago$/);
    expect(readingAgePhrase('2026-08-29', today)).toMatch(/, 13 days ago$/);
    expect(readingAgePhrase('2026-08-28', today)).toMatch(/, 2 weeks ago$/);
    expect(readingAgePhrase('2026-07-14', today)).toMatch(/, 8 weeks ago$/);
    expect(readingAgePhrase('2026-07-13', today)).toMatch(/, 2 months ago$/);
    expect(readingAgePhrase('2025-10-17', today)).toMatch(/, 10 months ago$/);
    // Review: "12 months ago" the day before "over a year ago" read oddly.
    expect(readingAgePhrase('2025-10-16', today)).toMatch(/, almost a year ago$/);
    expect(readingAgePhrase('2025-09-12', today)).toMatch(/, almost a year ago$/);
    expect(readingAgePhrase('2025-09-11', today)).toMatch(/, over a year ago$/);
  });

  it('adds the year only when it is not this year', () => {
    expect(readingAgePhrase('2026-08-21', today)).toBe('from 21 Aug, 3 weeks ago');
    expect(readingAgePhrase('2025-08-21', today)).toBe('from 21 Aug 2025, over a year ago');
  });
});

describe('latestReadingOn — the newest real reading, as a local day', () => {
  const today = '2026-09-11';

  it('is null for no readings', () => {
    expect(latestReadingOn([], today)).toBeNull();
  });

  it('picks the newest regardless of order', () => {
    const samples = [
      { measured_at: '2026-08-21T12:00:00Z' },
      { measured_at: '2026-09-02T12:00:00Z' },
      { measured_at: '2026-06-01T12:00:00Z' },
    ];
    expect(latestReadingOn(samples, today)).toBe('2026-09-02');
  });

  it('ignores a future-dated reading and an unparseable one, as buildTrend does', () => {
    const samples = [
      { measured_at: '2026-08-21T12:00:00Z' },
      { measured_at: '2026-10-01T12:00:00Z' },
      { measured_at: 'not a date' },
    ];
    expect(latestReadingOn(samples, today)).toBe('2026-08-21');
  });

  it('uses the local calendar day, the same mapping the trend hook uses', () => {
    // The suite runs under TZ=America/Los_Angeles: 03:00Z on the 22nd is
    // still the evening of the 21st there.
    expect(latestReadingOn([{ measured_at: '2026-08-22T03:00:00Z' }], today)).toBe('2026-08-21');
  });
});

describe('vo2MaxRowDetail — the You row keeps its place and stops promising a trend (N524)', () => {
  const today = '2026-09-11';

  it('keeps the feature description while the answer is unknown, or when there is a trend', () => {
    expect(vo2MaxRowDetail({ source: 'healthkit', readingCount: null, latestOn: null, today })).toBe(
      'Your cardio fitness trend, read from Apple Health',
    );
    expect(vo2MaxRowDetail({ source: 'health_connect', readingCount: 14, latestOn: '2026-09-10', today })).toBe(
      'Your cardio fitness trend, read from Health Connect',
    );
    expect(vo2MaxRowDetail({ source: null, readingCount: 2, latestOn: '2026-09-10', today })).toBe(
      'Your cardio fitness trend',
    );
  });

  it('says what the account holds when it is not a trend', () => {
    expect(vo2MaxRowDetail({ source: 'healthkit', readingCount: 0, latestOn: null, today })).toBe(
      'No reading from the past year',
    );
    expect(vo2MaxRowDetail({ source: 'healthkit', readingCount: 1, latestOn: '2026-08-21', today })).toBe(
      '1 reading, from 21 Aug, 3 weeks ago — too few for a trend',
    );
    expect(vo2MaxRowDetail({ source: 'healthkit', readingCount: 1, latestOn: null, today })).toBe(
      '1 reading — too few for a trend',
    );
  });

  it('never promises a trend to an account with fewer than two readings', () => {
    for (const readingCount of [0, 1]) {
      expect(vo2MaxRowDetail({ source: 'healthkit', readingCount, latestOn: '2026-08-21', today })).not.toMatch(
        /cardio fitness trend/,
      );
    }
  });
});


/**
 * N524 review — the fix above was, at first, a sentence nobody could see.
 *
 * Every test above feeds `vo2MaxEmptyCopy` a hand-built `{ kind: 'too-few' }`.
 * `buildTrend` never produces that for VO₂max, because it only reports
 * `too-few` when a smoother ran and `useVo2MaxTrend` passes none — so the
 * reporter's account (one reading, 21 days old) drew one unexplained dot at
 * the default range, and the copy tests were green about a state the screen
 * could not reach. These run the REAL `buildTrend` on that account, exactly as
 * `useVo2MaxTrend` calls it (no `smooth`), and follow it through to the
 * sentence the screen renders.
 */
describe('vo2MaxTrendEmpty — the no-trend state is reachable from real data', () => {
  const today = '2026-09-11';
  const reporter = [{ on: '2026-08-21', value: 45.2 }];
  const series = (readings: { on: string; value: number }[] | null, range: '1W' | '1M' | '3M' | '6M' | '1Y') =>
    buildTrend({ readings, today, range });

  it('documents WHY this exists: buildTrend alone reports nothing for one VO2max reading', () => {
    // If `trendSeries.ts` ever starts reporting this itself, this goes red and
    // the helper can be reconsidered — rather than silently doubling up.
    expect(series(reporter, '6M').empty).toBeNull();
    expect(series(reporter, '6M').readings).toHaveLength(1);
  });

  it("turns the reporter's one reading into too-few at every range that holds it", () => {
    for (const range of ['1M', '3M', '6M', '1Y'] as const) {
      expect(vo2MaxTrendEmpty(series(reporter, range))).toEqual({ kind: 'too-few', have: 1, need: 2 });
    }
  });

  it('leaves the states buildTrend already reports untouched', () => {
    expect(vo2MaxTrendEmpty(series(reporter, '1W'))).toEqual({ kind: 'none-in-range', totalReadings: 1 });
    expect(vo2MaxTrendEmpty(series([], '6M'))).toEqual({ kind: 'none' });
    expect(vo2MaxTrendEmpty(series(null, '6M'))).toEqual({ kind: 'unavailable' });
  });

  it('draws the chart once there are two readings in range', () => {
    const two = [...reporter, { on: '2026-09-01', value: 45.9 }];
    expect(vo2MaxTrendEmpty(series(two, '6M'))).toBeNull();
    expect(VO2MAX_MIN_TREND_READINGS).toBe(2);
  });

  it("renders the reporter's screen as an explanation with the reading's age, end to end", () => {
    // The trend screen's own composition, from the fetched sample to the text.
    const samples = [{ measured_at: '2026-08-21T15:00:00Z' }];
    const empty = vo2MaxTrendEmpty(series(reporter, '6M'));
    expect(empty).not.toBeNull();
    const copy = vo2MaxEmptyCopy(empty!, 'healthkit', true, { on: latestReadingOn(samples, today), today });
    expect(copy).toBe(
      '1 VO2max reading in this range — a trend line needs 2. The latest is from 21 Aug, 3 weeks ago.\n\n' +
        vo2MaxReadingOrigin('healthkit'),
    );
  });
});
