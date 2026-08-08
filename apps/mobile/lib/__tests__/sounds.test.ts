/**
 * The sound module's decisions, none of which announce themselves when wrong.
 *
 * Every failure mode here is silent by construction — the module deliberately
 * swallows its own errors, because a bell that throws must never break the
 * timer it decorates. That is the right behaviour and it is also why these
 * assertions exist: with the catch in place, the only way to notice that
 * `playSound` stopped playing anything is to be standing in a gym.
 */

/*
  Imported above the `jest.mock` calls, which reads wrong and is right: babel
  hoists `jest.mock` above every import in the compiled output, so the manual
  ordering bought nothing and only tripped `import/first`. Safe because the
  factories' bodies do not touch the `mock*` bindings — only the closures they
  return do, and those run inside tests.
*/
import {
  initSounds,
  playSound,
  resetSounds,
  SOUND_NAMES,
  soundsEnabled,
  writeSoundsEnabled,
} from '../sounds';

type FakePlayer = { play: jest.Mock; seekTo: jest.Mock; remove: jest.Mock };

/**
 * Players in creation order, NOT keyed by source.
 *
 * jest-expo stubs every asset `require` to the same placeholder, so every
 * `.m4a` imports arrive here as an identical value — keying on the source
 * collapses them all into one player and the suite quietly stops testing what it
 * claims to. Creation order is the only thing that actually distinguishes
 * them under the stub.
 */
let mockPlayers: FakePlayer[] = [];
let mockAudioMode: Record<string, unknown> | null = null;

jest.mock('expo-audio', () => ({
  createAudioPlayer: () => {
    const player: FakePlayer = {
      play: jest.fn(),
      seekTo: jest.fn().mockResolvedValue(undefined),
      remove: jest.fn(),
    };
    mockPlayers.push(player);
    return player;
  },
  setAudioModeAsync: (mode: Record<string, unknown>) => {
    mockAudioMode = mode;
    return Promise.resolve();
  },
}));

const mockPrefs: Record<string, string> = {};
jest.mock('../prefs', () => ({
  PREF_SOUNDS: 'sounds_enabled',
  readPref: (_u: string, k: string) => Promise.resolve(mockPrefs[k] ?? null),
  writePref: (_u: string, k: string, v: string) => {
    mockPrefs[k] = v;
    return Promise.resolve();
  },
}));

/** Players that were actually asked to play. */
const played = () => mockPlayers.filter((p) => p.play.mock.calls.length > 0);

beforeEach(() => {
  resetSounds();
  mockPlayers = [];
  mockAudioMode = null;
  for (const k of Object.keys(mockPrefs)) delete mockPrefs[k];
});

describe('claiming the audio session', () => {
  it('rings with the ringer switch off', async () => {
    // The deliberate one. A phone on silent is the normal state for most
    // people, and a rest timer nobody can hear is not a rest timer. Safe only
    // because nothing here is unsolicited — every sound follows a countdown
    // the athlete started seconds earlier.
    await initSounds('u1');
    expect(mockAudioMode).toMatchObject({ playsInSilentMode: true });
  });

  it('ducks other audio rather than stopping it', async () => {
    // People train to their own music. `doNotMix` kills the track on every
    // rest and leaves them restarting Spotify between sets.
    await initSounds('u1');
    expect(mockAudioMode).toMatchObject({ interruptionMode: 'duckOthers' });
  });

  it('never asks for the microphone', async () => {
    // `allowsRecording: true` triggers the OS permission prompt. Asking for
    // the microphone as a side effect of wanting a bell would be indefensible.
    await initSounds('u1');
    expect(mockAudioMode).toMatchObject({ allowsRecording: false });
  });

  it('does not hold a background audio session', async () => {
    await initSounds('u1');
    expect(mockAudioMode).toMatchObject({ shouldPlayInBackground: false });
  });

  it('preloads every sound once', async () => {
    // Built up front because a decode on first play puts tens of milliseconds
    // between zero and the chime, which reads as the timer being wrong.
    await initSounds('u1');
    expect(mockPlayers).toHaveLength(SOUND_NAMES.length);
  });

  it('does not rebuild the players if called again', async () => {
    await initSounds('u1');
    await initSounds('u1');
    expect(mockPlayers).toHaveLength(SOUND_NAMES.length);
  });

  it('reads the preference on the SECOND call — the real launch sequence', async () => {
    // The bug this shipped with, found in review. `useAuth().userId` is
    // undefined on the first render and only real once Clerk resolves, so
    // every launch calls this twice. A single "already done" flag let the
    // first call claim the job and the second return early, so a muted
    // athlete got sounds back on every launch while Settings still showed
    // the toggle off. Nothing in the old suite called it with undefined.
    mockPrefs.sounds_enabled = '0';
    await initSounds(undefined);
    await initSounds('u1');
    expect(soundsEnabled()).toBe(false);
  });

  it('re-reads when a different athlete signs in', async () => {
    mockPrefs.sounds_enabled = '0';
    await initSounds('u1');
    expect(soundsEnabled()).toBe(false);
    delete mockPrefs.sounds_enabled;
    await initSounds('u2');
    expect(soundsEnabled()).toBe(true);
  });

  it('still builds the players when no one is signed in yet', async () => {
    await initSounds(undefined);
    expect(mockPlayers).toHaveLength(SOUND_NAMES.length);
  });
});

describe('playing', () => {
  it('rewinds before playing, so the second rest chimes too', async () => {
    // A player that has already run sits at the end of its buffer, and
    // `play()` there is silent. Without the rewind the FIRST rest of a session
    // chimes and none of the others do — which reads as the sounds working,
    // then randomly breaking.
    await initSounds('u1');
    playSound('restComplete');
    // Awaited internally, so the play lands a microtask later.
    await Promise.resolve();
    await Promise.resolve();
    expect(played()).toHaveLength(1);
    const p = played()[0];
    expect(p.seekTo).toHaveBeenCalledWith(0);
    expect(p.play).toHaveBeenCalledTimes(1);
    // The ORDER, not merely that both happened. Swapping the two lines in
    // `playSound` left the previous version of this test green, while on iOS
    // that swap is the difference between the second rest chiming and not.
    expect(p.seekTo.mock.invocationCallOrder[0]).toBeLessThan(p.play.mock.invocationCallOrder[0]);
  });

  it('plays each sound from its own player', async () => {
    await initSounds('u1');
    playSound('restComplete');
    playSound('workComplete');
    await Promise.resolve();
    await Promise.resolve();
    expect(played()).toHaveLength(2);
  });

  it('says nothing when the athlete has muted it', async () => {
    mockPrefs.sounds_enabled = '0';
    await initSounds('u1');
    playSound('restComplete');
    await Promise.resolve();
    expect(played()).toHaveLength(0);
  });

  it('is on when the preference was never written', async () => {
    // Absent means on, so the default costs no write — same convention as the
    // suggestion prefs.
    await initSounds('u1');
    expect(soundsEnabled()).toBe(true);
    playSound('restComplete');
    await Promise.resolve();
    await Promise.resolve();
    expect(played()).toHaveLength(1);
  });

  it('does not throw when a player failed to load', () => {
    // No `initSounds` at all: every player is missing. This is the offline /
    // corrupt-asset path, and it must degrade to silence rather than taking
    // the countdown down with it.
    expect(() => playSound('restComplete')).not.toThrow();
  });

  it('does not throw when the native player throws', async () => {
    await initSounds('u1');
    mockPlayers.forEach((p) =>
      p.play.mockImplementation(() => {
        throw new Error('audio session lost');
      }),
    );
    expect(() => playSound('restComplete')).not.toThrow();
    await new Promise((r) => setTimeout(r, 0));
  });

  it('does not leave an unhandled rejection when the rewind fails', async () => {
    // The previous version of this test could not fail: `playSound` returns
    // before the rejection exists, so `not.toThrow()` passed whether or not
    // the catch was there. An unhandled rejection is the actual symptom — a
    // redbox in dev, raised by a bell — so that is what is watched for.
    await initSounds('u1');
    const unhandled = jest.fn();
    process.on('unhandledRejection', unhandled);
    try {
      mockPlayers.forEach((p) => p.seekTo.mockRejectedValue(new Error('nope')));
      playSound('restComplete');
      await new Promise((r) => setTimeout(r, 0));
      expect(unhandled).not.toHaveBeenCalled();
      // And the failure is total: no play on a player that could not rewind.
      expect(played()).toHaveLength(0);
    } finally {
      process.off('unhandledRejection', unhandled);
    }
  });
});

describe('muting', () => {
  it('takes effect immediately, before the write lands', async () => {
    await initSounds('u1');
    const pending = writeSoundsEnabled('u1', false);
    // Not awaited: the athlete asked for silence, and making them wait on
    // storage to get it would be the wrong way round.
    playSound('restComplete');
    await Promise.resolve();
    expect(played()).toHaveLength(0);
    await pending;
  });

  it('persists so the next launch stays muted', async () => {
    await initSounds('u1');
    await writeSoundsEnabled('u1', false);
    expect(mockPrefs.sounds_enabled).toBe('0');

    resetSounds();
    mockPlayers = [];
    await initSounds('u1');
    expect(soundsEnabled()).toBe(false);
  });

  it('turns back on', async () => {
    await initSounds('u1');
    await writeSoundsEnabled('u1', false);
    await writeSoundsEnabled('u1', true);
    playSound('restComplete');
    await Promise.resolve();
    await Promise.resolve();
    expect(played()).toHaveLength(1);
  });
});
