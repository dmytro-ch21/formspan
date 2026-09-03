import { newSplitIndices, spokenDuration, spokenSplitAnnouncement } from '../runningVoice';
import type { Split } from '../running';

/**
 * L13/#779 — the pure "what to say and when" half of a run's spoken splits.
 *
 * `announce()` itself (the speaking, the preference check) is already covered
 * by `voice.test.ts` for the guided workout that built it; nothing here
 * re-tests that module. This file is only the two things specific to this
 * feature: turning a split into words, and deciding which splits are new.
 */

describe('spokenDuration', () => {
  it('says only seconds under a minute', () => {
    expect(spokenDuration(45)).toBe('45 seconds');
    expect(spokenDuration(1)).toBe('1 second');
    expect(spokenDuration(0)).toBe('0 seconds');
  });

  it('says only minutes on an exact minute boundary', () => {
    expect(spokenDuration(60)).toBe('1 minute');
    expect(spokenDuration(120)).toBe('2 minutes');
  });

  it('says both once a split runs past a minute', () => {
    expect(spokenDuration(312)).toBe('5 minutes 12 seconds');
    expect(spokenDuration(61)).toBe('1 minute 1 second');
  });

  it('rounds to the nearest second and never goes negative', () => {
    expect(spokenDuration(59.6)).toBe('1 minute');
    expect(spokenDuration(-5)).toBe('0 seconds');
  });
});

describe('spokenSplitAnnouncement', () => {
  const split = (duration_seconds: number): Split => ({ distance_m: 1000, duration_seconds });

  it('speaks the 1-based kilometer marker for a 0-based split index', () => {
    expect(spokenSplitAnnouncement(0, split(312))).toBe('Kilometer 1, 5 minutes 12 seconds.');
    expect(spokenSplitAnnouncement(4, split(300))).toBe('Kilometer 5, 5 minutes.');
  });
});

describe('newSplitIndices', () => {
  it('is empty when nothing new has completed', () => {
    expect(newSplitIndices(2, 2)).toEqual([]);
    expect(newSplitIndices(0, 0)).toEqual([]);
  });

  it('reports every index from the baseline up to, but not including, the new length', () => {
    expect(newSplitIndices(0, 3)).toEqual([0, 1, 2]);
    expect(newSplitIndices(2, 3)).toEqual([2]);
    expect(newSplitIndices(1, 4)).toEqual([1, 2, 3]);
  });

  it('clamps a negative baseline to 0 rather than announcing nothing forever', () => {
    expect(newSplitIndices(-1, 2)).toEqual([0, 1]);
  });

  it('never reports an index for a baseline already at or past the current length', () => {
    expect(newSplitIndices(5, 3)).toEqual([]);
  });
});
