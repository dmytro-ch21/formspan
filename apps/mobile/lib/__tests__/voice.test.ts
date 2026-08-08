import { CUE_TEXT, cuesForTransition, pickVoice, type VoiceLike } from '../voice';

/**
 * The guided workout's spoken cues.
 *
 * The two pure parts, and they are the two that are easy to get subtly wrong and
 * impossible to notice: a run that says "rest now" on the way INTO a work
 * interval still makes noises at the right times, and a voice ranking that
 * quietly picks a German narrator still speaks.
 */

describe('what gets said at each transition', () => {
  it('confirms a finished set before saying what is next', () => {
    // "Set completed" is the event the athlete is waiting to hear; what comes
    // next is a second sentence, and expo-speech queues rather than interrupts.
    expect(cuesForTransition('work', 'rest')).toEqual(['setComplete', 'rest']);
    expect(cuesForTransition('work', 'ready')).toEqual(['setComplete', 'getReady']);
  });

  it('announces the end of the whole run', () => {
    expect(cuesForTransition('work', null)).toEqual(['setComplete', 'workoutComplete']);
  });

  it('says nothing at all for a run that never started', () => {
    expect(cuesForTransition(null, null)).toEqual([]);
  });

  it('names the arrival, not the departure, for every other step', () => {
    expect(cuesForTransition('rest', 'ready')).toEqual(['getReady']);
    expect(cuesForTransition('ready', 'work')).toEqual(['startExercise']);
    // Starting a run: there is no transition into step 0, so the hook asks for
    // the arrival cue with a null `from`.
    expect(cuesForTransition(null, 'ready')).toEqual(['getReady']);
    expect(cuesForTransition(null, 'work')).toEqual(['startExercise']);
  });

  it('never says a set completed unless one did', () => {
    // The one thing that would be a lie rather than a mistake.
    for (const from of ['rest', 'ready', null] as const) {
      for (const to of ['rest', 'ready', 'work', null] as const) {
        expect(cuesForTransition(from, to)).not.toContain('setComplete');
      }
    }
  });

  it('has words for every cue it can emit', () => {
    // Derived from the transitions rather than hard-coded, so adding a cue with
    // no text fails here instead of speaking "undefined" mid-workout.
    const emitted = new Set(
      (['work', 'rest', 'ready', null] as const).flatMap((from) =>
        (['work', 'rest', 'ready', null] as const).flatMap((to) => cuesForTransition(from, to)),
      ),
    );
    for (const cue of emitted) expect(CUE_TEXT[cue]).toBeTruthy();
  });
});

describe('picking a voice', () => {
  const v = (over: Partial<VoiceLike> & { identifier: string }): VoiceLike => ({ ...over });

  it('will not read English cues in another language', () => {
    // The one mismatch that is worse than the system default.
    const german = [v({ identifier: 'de.Anna', name: 'Anna', language: 'de-DE' })];
    expect(pickVoice(german)).toBeNull();
  });

  it('prefers a voice it recognises as female', () => {
    const voices = [
      v({ identifier: 'com.apple.voice.compact.en-US.Fred', name: 'Fred', language: 'en-US' }),
      v({ identifier: 'com.apple.voice.compact.en-US.Samantha', name: 'Samantha', language: 'en-US' }),
    ];
    expect(pickVoice(voices)).toBe('com.apple.voice.compact.en-US.Samantha');
  });

  it('reads the Android identifier convention too', () => {
    // Android encodes the register in the identifier rather than the name.
    const voices = [
      v({ identifier: 'en-us-x-iom-local', name: 'en-us-x-iom-local', language: 'en-US' }),
      v({ identifier: 'en-us-x-tpf-local', name: 'en-us-x-tpf-local', language: 'en-US' }),
    ];
    expect(pickVoice(voices)).toBe('en-us-x-tpf-local');
  });

  it('takes the better-quality one when both are female', () => {
    const voices = [
      v({ identifier: 'a.karen', name: 'Karen', language: 'en-AU', quality: 'Default' }),
      v({ identifier: 'b.ava', name: 'Ava', language: 'en-US', quality: 'Enhanced' }),
    ];
    expect(pickVoice(voices)).toBe('b.ava');
  });

  it('falls back to the system default rather than to a second guess', () => {
    // Neither platform exposes gender, so the match is by name and is exactly
    // as fragile as it sounds. When it does not match, the phone's own setting
    // is a better answer than ours.
    const voices = [v({ identifier: 'x.fred', name: 'Fred', language: 'en-GB' })];
    expect(pickVoice(voices)).toBeNull();
    expect(pickVoice([])).toBeNull();
  });

  it('picks the same voice every launch', () => {
    // A cue set that changes voice between sessions reads as a bug.
    const voices = [
      v({ identifier: 'b.zoe', name: 'Zoe', language: 'en-US' }),
      v({ identifier: 'a.ava', name: 'Ava', language: 'en-US' }),
    ];
    expect(pickVoice(voices)).toBe(pickVoice([...voices].reverse()));
  });

  it('does not mistake a voice with no language for an English one', () => {
    expect(pickVoice([v({ identifier: 'mystery.samantha', name: 'Samantha' })])).toBeNull();
  });
});
