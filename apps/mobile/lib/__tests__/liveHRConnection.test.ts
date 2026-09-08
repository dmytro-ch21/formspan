import {
  __setBleManagerForTests,
  getLiveHR,
  startLiveHR,
  stopLiveHR,
} from '../hrMonitor/liveHR';

/**
 * N528/#958 — the CONNECTION lifecycle in `lib/hrMonitor/liveHR.ts`.
 *
 * This is the file that owns native handles, timers and a generation
 * counter, and it reached review with no coverage; `frontend-reviewer`
 * reproduced two real defects in it. Every test here was checked BOTH ways —
 * each fails against the unfixed code and passes against the fix (see the
 * mutation list in the N528 history entry).
 *
 * The tests assert ORDER, not just end state, and that is the whole point:
 * a first draft of this file asserted only the final status with a drain
 * loop that settled every pending call in lockstep, and it passed
 * identically with the bugs present and absent — a harness measuring
 * nothing, which is the exact failure this repo keeps a section about. What
 * separates fixed from broken here is *when* the app issues its next
 * connect relative to the previous disconnect being acknowledged, so that
 * is what gets asserted.
 */

type Pending<T> = { id: string; resolve: (v: T) => void; done: boolean };

function fakeDevice(id: string) {
  return {
    id,
    name: id,
    discoverAllServicesAndCharacteristics: async () => fakeDevice(id),
    monitorCharacteristicForService: () => ({ remove: () => {} }),
  };
}
type FakeDevice = ReturnType<typeof fakeDevice>;

/** A scripted peripheral: nothing resolves until the test says so, and every
 *  call the module makes is recorded in order. */
function fakeManager() {
  const connects: Pending<FakeDevice>[] = [];
  const cancels: Pending<unknown>[] = [];
  const events: string[] = [];
  const disconnectListeners = new Map<string, () => void>();

  return {
    connects,
    cancels,
    events,
    cancelledIds: () => cancels.map((c) => c.id),
    /** The peripheral goes out of range. */
    dropLink(id: string) {
      const l = disconnectListeners.get(id);
      if (!l) throw new Error(`nothing is listening for ${id}'s disconnect`);
      events.push(`link-dropped:${id}`);
      l();
    },
    settleConnect(id: string) {
      const hit = connects.find((c) => c.id === id && !c.done);
      if (!hit) throw new Error(`no pending connect for ${id}`);
      hit.done = true;
      hit.resolve(fakeDevice(id));
    },
    settleCancel(id: string) {
      const hit = cancels.find((c) => c.id === id && !c.done);
      if (!hit) throw new Error(`no pending cancel for ${id}`);
      hit.done = true;
      events.push(`cancel-acknowledged:${id}`);
      hit.resolve(undefined);
    },
    manager: {
      state: async () => 'PoweredOn',
      startDeviceScan: () => {},
      stopDeviceScan: () => {},
      connectToDevice: (id: string) => {
        events.push(`connect-issued:${id}`);
        return new Promise<FakeDevice>((resolve) => connects.push({ id, resolve, done: false }));
      },
      cancelDeviceConnection: (id: string) => {
        events.push(`cancel-issued:${id}`);
        return new Promise<unknown>((resolve) => cancels.push({ id, resolve, done: false }));
      },
      onDeviceDisconnected: (id: string, listener: () => void) => {
        disconnectListeners.set(id, listener);
        return {
          remove: () => {
            disconnectListeners.delete(id);
          },
        };
      },
      destroy: () => {},
    },
  };
}

/** Flush pending microtasks/continuations without settling anything. */
const tick = async (n = 3) => {
  for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r));
};

let ble: ReturnType<typeof fakeManager>;

beforeEach(() => {
  ble = fakeManager();
  __setBleManagerForTests(ble.manager, 40); // short cancel bound keeps these fast
});

afterEach(() => {
  __setBleManagerForTests(null);
});

const A = { id: 'A', name: 'Amazfit GTR 4' };
const B = { id: 'B', name: 'Polar H10' };

/** Bring the store to a live link on `device`. */
async function connect(device: { id: string; name: string }) {
  void startLiveHR(device);
  await tick();
  ble.settleConnect(device.id);
  await tick();
}

describe('startLiveHR / stopLiveHR are serialized', () => {
  it('a background stop and an immediate foreground start do NOT overlap — the reconnect waits for the disconnect', async () => {
    // The sequence `orchestrator.ts` produces on a quick app switch: it
    // fires `void stopLiveHR()` on 'background' and `connectIfRemembered()`
    // on 'active', neither awaited. Overlapping them is what let a
    // late-resolving cancel switch off a link that had already come back.
    await connect(A);
    ble.events.length = 0;

    void stopLiveHR();
    void startLiveHR(A);
    await tick();

    // The reconnect must not have been issued yet — the disconnect is still
    // unacknowledged. This is the assertion that fails when the operations
    // are allowed to run concurrently.
    expect(ble.events).toEqual(['cancel-issued:A']);

    ble.settleCancel('A');
    await tick();
    ble.settleConnect('A');
    await tick();

    expect(ble.events).toEqual([
      'cancel-issued:A',
      'cancel-acknowledged:A',
      'connect-issued:A',
    ]);
    expect(getLiveHR().status).toBe('connected');
  });

  it('two starts racing before either connects issue their connects one at a time', async () => {
    void startLiveHR(A);
    void startLiveHR(B);
    await tick();

    // Only the first is in flight; B's connect cannot have been issued.
    expect(ble.events).toEqual(['connect-issued:A']);

    ble.settleConnect('A');
    await tick();
    ble.settleCancel('A'); // the swap releases A before taking B
    await tick();
    ble.settleConnect('B');
    await tick();

    expect(getLiveHR().device?.id).toBe('B');
    expect(getLiveHR().status).toBe('connected');
    expect(ble.cancelledIds()).toContain('A');
  });
});

describe('a disconnect the OS never acknowledges', () => {
  it('does not wedge live HR — a later monitor still connects', async () => {
    // Serializing introduced this risk and it has to be bounded: a BLE stack
    // that stops answering `cancelDeviceConnection` would otherwise block
    // every later connect for the life of the app.
    await connect(A);
    void stopLiveHR(); // A's cancel is never acknowledged, on purpose
    void startLiveHR(B);
    await new Promise((r) => setTimeout(r, 80)); // past the 40ms bound
    ble.settleConnect('B');
    await tick();

    expect(getLiveHR().device?.id).toBe('B');
    expect(getLiveHR().status).toBe('connected');
  });

  it('and when it finally answers, it must not switch off the link that replaced it', async () => {
    // The stalled `stopLiveHR` resumes long after a new link is live. Its
    // trailing "off" dispatch is only correct if nothing newer started —
    // otherwise the chip goes dark mid-session for no reason the athlete
    // can see.
    await connect(A);
    void stopLiveHR();
    void startLiveHR(B);
    await new Promise((r) => setTimeout(r, 80));
    ble.settleConnect('B');
    await tick();
    expect(getLiveHR().status).toBe('connected');

    ble.settleCancel('A'); // the OS finally answers, far too late
    await tick();

    expect(getLiveHR().status).toBe('connected');
    expect(getLiveHR().device?.id).toBe('B');
  });

});

describe('ordinary lifecycle', () => {
  it('stopLiveHR after a real connection switches the store off and releases the device', async () => {
    await connect(A);
    void stopLiveHR();
    await tick();
    ble.settleCancel('A');
    await tick();

    expect(getLiveHR().status).toBe('off');
    expect(ble.cancelledIds()).toContain('A');
  });

  it('starting the SAME monitor twice is idempotent — one connect, no churn', async () => {
    await connect(A);
    ble.events.length = 0;
    await startLiveHR(A);
    await tick();

    expect(ble.events).toEqual([]);
    expect(getLiveHR().status).toBe('connected');
  });
});

describe('a dropped link', () => {
  it('says so immediately and reconnects on its own, without the athlete touching anything', async () => {
    // The ticket's own criterion: "a dropped link reconnects without athlete
    // action and is visible ('monitor disconnected') rather than silent".
    await connect(A);
    ble.events.length = 0;

    ble.dropLink('A');
    await tick();
    // Visible at once — the number dims and the chip says why.
    expect(getLiveHR().status).toBe('reconnecting');
    expect(getLiveHR().bpm).toBe(getLiveHR().bpm); // last value is kept, not blanked

    // …and the app re-attempts on its own once the first backoff elapses.
    await new Promise((r) => setTimeout(r, 1_200));
    expect(ble.events).toContain('connect-issued:A');

    ble.settleConnect('A');
    await tick();
    expect(getLiveHR().status).toBe('connected');
  }, 10_000);

  it('a reconnect firing while the app is being backgrounded does not overlap the disconnect', async () => {
    // The reconnect timer is the one connect that does not start life inside
    // a queued operation, so it is the one that could overlap a stop.
    await connect(A);
    ble.dropLink('A');
    await tick();
    void stopLiveHR(); // athlete backgrounds the app mid-backoff
    await tick();
    expect(ble.events.filter((e) => e === 'connect-issued:A')).toHaveLength(1); // only the original

    ble.settleCancel('A');
    await new Promise((r) => setTimeout(r, 1_200));
    await tick();

    // The link is off and stayed off — no stray reconnect resurrected it.
    expect(getLiveHR().status).toBe('off');
  }, 10_000);
});
