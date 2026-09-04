import { HR_LIMITED_SAMPLE_THRESHOLD, hrCorroboration } from '../bjjSession';
import type { SessionMetrics } from '../biometric';

/**
 * N480/#825 — HR corroborates a BJJ session's RPE, never replaces it.
 *
 * Design doc §5.5: optical wrist HR is unreliable under grip, flexion and
 * contact — "grappling is the pathological case" — so session RPE stays the
 * primary internal-load metric for BJJ and heart rate only ever corroborates
 * it. `hrCorroboration` is the one function that decides whether — and how —
 * a session's HR-derived metrics reach the review screen at all, so these
 * tests are the guard against it drifting into showing HR with unwarranted
 * confidence or reading as a rival measurement to the athlete's own RPE.
 */

function metrics(overrides: Partial<SessionMetrics> = {}): SessionMetrics {
  return {
    session_id: 'sess-1',
    avg_hr_bpm: 142,
    max_hr_bpm: 168,
    trimp: 187.3,
    active_kcal: 410,
    hr_max_bpm: 190,
    hr_max_source: 'estimated',
    time_in_zones: {},
    hr_source: 'window',
    sample_count: 40,
    computed_at: '2026-09-01T12:00:00Z',
    rule_version: 1,
    ...overrides,
  };
}

describe('hrCorroboration', () => {
  it('shows nothing when there is no computed metrics row at all', () => {
    expect(hrCorroboration(null)).toEqual({ show: false });
  });

  it('shows nothing for hr_source "none" — no fabricated placeholder', () => {
    const m = metrics({ hr_source: 'none', avg_hr_bpm: null, max_hr_bpm: null, sample_count: 0 });
    expect(hrCorroboration(m)).toEqual({ show: false });
  });

  it('hr_source "none" wins even if avg/max were somehow non-null (defence in depth, checked independently)', () => {
    // Not a real backend state (Compute always forces 'none' to carry no
    // figures), but this guard has to stand on its own rather than riding on
    // the null check below it — otherwise it could be deleted with nothing
    // in this file able to tell.
    const m = metrics({ hr_source: 'none', sample_count: 0 });
    expect(hrCorroboration(m)).toEqual({ show: false });
  });

  it('shows nothing when a non-none source still carries no HR figures', () => {
    // Not expected from the backend (Compute forces 'none' whenever there are
    // no samples), but the function should not fabricate a value if it ever
    // happens — defence in depth, not a real backend state.
    const m = metrics({ avg_hr_bpm: null, max_hr_bpm: null });
    expect(hrCorroboration(m)).toEqual({ show: false });
  });

  it('shows a normal-confidence reading with the RPE-secondary framing, above the sample threshold', () => {
    const m = metrics({ hr_source: 'workout', sample_count: HR_LIMITED_SAMPLE_THRESHOLD });
    const result = hrCorroboration(m);
    expect(result).toEqual({
      show: true,
      confidence: 'normal',
      value: 'Avg 142 bpm · Max 168 bpm',
      caption: 'Corroborates your RPE above — not a replacement for it',
    });
  });

  it('never claims HR "confirms" or "validates" RPE — the caption always corroborates', () => {
    const result = hrCorroboration(metrics({ sample_count: 100 }));
    if (!result.show) throw new Error('expected a visible result');
    expect(result.caption.toLowerCase()).not.toMatch(/confirm|valid|overrid|replac(?!ement)/);
    expect(result.caption).toContain('Corroborates');
  });

  it('caveats sparse data instead of hiding it, below the threshold', () => {
    const m = metrics({ sample_count: HR_LIMITED_SAMPLE_THRESHOLD - 1 });
    const result = hrCorroboration(m);
    expect(result).toEqual({
      show: true,
      confidence: 'limited',
      value: 'Avg 142 bpm · Max 168 bpm',
      caption: 'Only 11 readings — limited data, treat as a hint',
    });
  });

  it('singularizes the reading count at exactly one sample', () => {
    const result = hrCorroboration(metrics({ sample_count: 1 }));
    if (!result.show) throw new Error('expected a visible result');
    expect(result.caption).toBe('Only 1 reading — limited data, treat as a hint');
  });

  it('renders only the figures that are present', () => {
    const result = hrCorroboration(metrics({ max_hr_bpm: null, sample_count: 50 }));
    if (!result.show) throw new Error('expected a visible result');
    expect(result.value).toBe('Avg 142 bpm');
  });

  it('the threshold boundary is exact: one below is limited, the threshold itself is normal', () => {
    const below = hrCorroboration(metrics({ sample_count: HR_LIMITED_SAMPLE_THRESHOLD - 1 }));
    const at = hrCorroboration(metrics({ sample_count: HR_LIMITED_SAMPLE_THRESHOLD }));
    if (!below.show || !at.show) throw new Error('expected both to be visible');
    expect(below.confidence).toBe('limited');
    expect(at.confidence).toBe('normal');
  });
});
