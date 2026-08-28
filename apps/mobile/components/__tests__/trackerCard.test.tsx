/**
 * The tracker card's render path, and specifically the two things N77 added to
 * it.
 *
 * **A component test rather than a logic one, deliberately, and the reason is
 * the ticket's own criterion.** `lib/__tests__/trackerModel.test.ts` already
 * proves `footLine` composes the right sentence and `glyphState` marks the
 * right glyphs — but a model function nothing renders is exactly the shape
 * #406 shipped: `lastLoggedAt` and `formatClock` were written, tested and
 * correct, and the card did not display either of them for a whole ticket. A
 * second opinion about the arithmetic here would be two tests disagreeing;
 * what is worth asserting is that the card is WIRED to the model at all.
 *
 * So every assertion below is about the render path and nothing else, and each
 * one fails if the corresponding line in `TrackerCard.tsx` is deleted.
 *
 * What this cannot tell you: whether the smaller fill actually reads as
 * "past your target" to a human eye at 26pt, or whether VoiceOver speaks these
 * labels in the order they are written. Both need a device. `L1` tracks that
 * gap and this ticket does not close it.
 */

import { StyleSheet } from 'react-native';
import { fireEvent, render, screen } from '@testing-library/react-native';

import { TrackerCard } from '../TrackerCard';
import type { Tracker, TrackerEntry } from '@/lib/trackerModel';

/** The shipped coffee preset, field for field. See `tracker/presets.go`. */
const coffee: Tracker = {
  id: 'cof',
  preset: 'coffee',
  name: 'Coffee',
  icon: '☕',
  color_key: 'coffee',
  unit: 'cup',
  increment: 1,
  target: null,
  render_style: 'auto',
  sort_order: 20,
  // Authored since N78 — `presets.go` carries the same literal. The noun used
  // to be derived from `unit`, and this fixture said "field for field" while
  // omitting the one field that decides what the card reads.
  count_noun: 'cup',
  provisioned: false,
  cutoff_minutes: null,
};

const water: Tracker = {
  id: 'wat',
  preset: 'water',
  name: 'Water',
  icon: '💧',
  color_key: 'water',
  unit: 'ml',
  increment: 250,
  target: 2000,
  render_style: 'glyphs',
  sort_order: 10,
  count_noun: 'cup',
  provisioned: true,
  cutoff_minutes: null,
};

/** Cups, one an hour, ending at the time the assertions read back. */
function taps(t: Tracker, n: number, lastAt = '2026-08-20T23:40:00.000Z'): TrackerEntry[] {
  const end = Date.parse(lastAt);
  return Array.from({ length: n }, (_, i) => ({
    id: `e${i}`,
    tracker_id: t.id,
    logged_on: '2026-08-20',
    logged_at: new Date(end - (n - 1 - i) * 3_600_000).toISOString(),
    amount: t.increment,
  }));
}

function renderCard(
  tracker: Tracker,
  entries: TrackerEntry[],
  over: Partial<React.ComponentProps<typeof TrackerCard>> = {},
) {
  const onAdd = jest.fn();
  const onRemove = jest.fn();
  render(
    <TrackerCard
      tracker={tracker}
      entries={entries}
      units="metric"
      unitsReady
      onAdd={onAdd}
      onRemove={onRemove}
      onEdit={() => {}}
      {...over}
    />,
  );
  return { onAdd, onRemove };
}

/** The margin the fill is drawn with — the channel that marks an over cup. */
function fillInset(glyphTestID: string): number {
  const fill = screen.getByTestId(`${glyphTestID}-fill`);
  const flat = StyleSheet.flatten(fill.props.style) as { margin?: number };
  return flat.margin ?? 0;
}

describe('the card shows when the last one was', () => {
  it('renders the clock, which is the reading N77 was written around', () => {
    // The suite runs under TZ=America/Los_Angeles, so 23:40 UTC is 16:40 local
    // — the exact string the ticket asks for.
    renderCard(coffee, taps(coffee, 3));
    expect(screen.getByTestId('tracker-foot-cof')).toHaveTextContent(/last at 16:40/);
  });

  it('shows it for water too, because the card does not know what coffee is', () => {
    // A branch on `tracker.preset` anywhere in this component would be the
    // CoffeeCard the ticket forbids. The clock is unconditional.
    renderCard(water, taps(water, 2));
    expect(screen.getByTestId('tracker-foot-wat')).toHaveTextContent(/last at 16:40/);
  });

  it('says nothing at all when there is no target and nothing logged', () => {
    // An athlete who declined a ceiling is not handed an empty goal line.
    renderCard(coffee, []);
    expect(screen.queryByTestId('tracker-foot-cof')).toBeNull();
  });
});

describe('N431: the cutoff line is wired to the card, not just the model', () => {
  // Same reasoning as the file header: `cutoffLine` is already pinned down as
  // pure logic in `trackerModel.test.ts`, and a correct function nothing
  // renders is exactly the #406 shape. This proves the card actually calls it
  // and draws what it returns.
  const withCutoff: Tracker = { ...coffee, cutoff_minutes: 960 }; // 16:00

  it('is absent when the tracker has no cutoff configured', () => {
    renderCard(coffee, [], { now: new Date('2026-08-20T19:00:00.000Z') });
    expect(screen.queryByTestId('tracker-cutoff-cof')).toBeNull();
  });

  it('counts down before the cutoff, on the live card', () => {
    // 2026-08-20T19:00:00.000Z is 12:00 local — four hours before 16:00.
    renderCard(withCutoff, [], { now: new Date('2026-08-20T19:00:00.000Z') });
    expect(screen.getByTestId('tracker-cutoff-cof')).toHaveTextContent('cutoff in 4h');
  });

  it('names the late cup once one crosses the line', () => {
    // 2026-08-20T23:10:00.000Z is 16:10 local — past the 16:00 cutoff.
    const late = taps(withCutoff, 1, '2026-08-20T23:10:00.000Z');
    renderCard(withCutoff, late, { now: new Date('2026-08-20T23:10:00.000Z') });
    expect(screen.getByTestId('tracker-cutoff-cof')).toHaveTextContent(
      'last at 16:10 — past your 16:00 cutoff',
    );
  });

  it('is absent on a browsed PAST day nothing crossed the cutoff on', () => {
    // `now: null` (the default, and what a browsed-day screen passes) — a cup
    // logged well before the cutoff leaves nothing to warn about.
    const early = taps(withCutoff, 1, '2026-08-20T21:00:00.000Z'); // 14:00 local
    renderCard(withCutoff, early);
    expect(screen.queryByTestId('tracker-cutoff-cof')).toBeNull();
  });

  it('still states a crossed cutoff on a browsed PAST day — a fact, not a live reading', () => {
    const late = taps(withCutoff, 1, '2026-08-20T23:10:00.000Z');
    renderCard(withCutoff, late); // now: null — not real today
    expect(screen.getByTestId('tracker-cutoff-cof')).toHaveTextContent(
      'last at 16:10 — past your 16:00 cutoff',
    );
  });

  it('reads no differently from the foot line above it — same register, no verdict', () => {
    renderCard(withCutoff, [], { now: new Date('2026-08-20T23:10:00.000Z') });
    const text = screen.getByTestId('tracker-cutoff-cof').props.children;
    expect(String(text)).not.toMatch(/warn|careful|stop|too (much|late)|!/i);
  });
});

describe('the count, and the limit if one is set', () => {
  it('reads the count first when there is no ceiling', () => {
    renderCard(coffee, taps(coffee, 3));
    expect(screen.getByTestId('tracker-value-cof')).toHaveTextContent('3 cups');
  });

  it('states the limit second once one exists, and never refuses a cup past it', () => {
    renderCard({ ...coffee, target: 3 }, taps(coffee, 5));
    expect(screen.getByTestId('tracker-value-cof')).toHaveTextContent('5 of 3 cups');
    expect(screen.getByTestId('tracker-foot-cof')).toHaveTextContent(
      /2 past your target of 3/,
    );
    // Five cups logged is five glyphs drawn. A row that stopped at the ceiling
    // would be telling the athlete their last two cups did not happen.
    expect(screen.getByTestId('tracker-glyph-cof-4')).toBeTruthy();
  });
});

describe('cups past the limit render distinctly', () => {
  it('draws the ones past the target with a different fill and the rest alike', () => {
    renderCard({ ...coffee, target: 3 }, taps(coffee, 5));
    const within = [0, 1, 2].map((i) => fillInset(`tracker-glyph-cof-${i}`));
    const past = [3, 4].map((i) => fillInset(`tracker-glyph-cof-${i}`));
    // Within the target they are identical to each other...
    expect(new Set(within).size).toBe(1);
    // ...and the ones past it are drawn differently from those.
    expect(new Set(past).size).toBe(1);
    expect(past[0]).not.toBe(within[0]);
  });

  it('changes the SHAPE, never the colour — nothing here reads as an error', () => {
    // The criterion is "visually distinct without being coloured as an error".
    // Every glyph on the card carries the tracker's own fill, over or not.
    renderCard({ ...coffee, target: 3 }, taps(coffee, 5));
    const colours = [0, 1, 2, 3, 4].map((i) => {
      const flat = StyleSheet.flatten(
        screen.getByTestId(`tracker-glyph-cof-${i}-fill`).props.style,
      ) as { backgroundColor?: string };
      return flat.backgroundColor;
    });
    expect(new Set(colours).size).toBe(1);
  });

  it('marks nothing when there is no target to be past', () => {
    // Coffee's shipped default. Five cups, no ceiling, five identical glyphs.
    renderCard(coffee, taps(coffee, 5));
    const insets = [0, 1, 2, 3, 4].map((i) => fillInset(`tracker-glyph-cof-${i}`));
    expect(new Set(insets).size).toBe(1);
  });

  it('an over-target cup still un-taps, by its own entry id', () => {
    // "Cups past the limit log normally" — a cup you cannot remove is not
    // logged normally. The id, not the index: two quick taps on one glyph must
    // not remove two cups.
    const entries = taps(coffee, 5);
    const { onRemove } = renderCard({ ...coffee, target: 3 }, entries);
    fireEvent.press(screen.getByTestId('tracker-glyph-cof-4'));
    expect(onRemove).toHaveBeenCalledWith(entries[4].id);
  });
});

describe('VoiceOver names coffee, not water', () => {
  it('labels the add control and every glyph with the tracker it belongs to', () => {
    renderCard({ ...coffee, target: 3 }, taps(coffee, 5));
    expect(screen.getByLabelText('Add a cup of Coffee')).toBeTruthy();
    expect(screen.getByLabelText('Coffee, cup 1 of 5, filled')).toBeTruthy();
    // The over state is spoken, so a VoiceOver user learns from the label what
    // the sighted user learns from the smaller fill.
    expect(screen.getByLabelText('Coffee, cup 4 of 5, filled, past your target')).toBeTruthy();
  });

  it('never says the tracker is empty when a cup is past the target', () => {
    // The subtractive fill is only unambiguous because empty and over cannot
    // coexist. If that ever breaks, this is the assertion that says so.
    renderCard({ ...coffee, target: 3 }, taps(coffee, 5));
    expect(screen.queryByLabelText(/empty/)).toBeNull();
  });
});

describe('no praise, no scolding, anywhere on the card', () => {
  it('reads every rendered string and finds no verdict', () => {
    const JUDGEMENTS = [
      'great', 'well done', 'nice', 'good job', 'amazing', 'keep it up', 'smashed',
      'too much', 'too many', 'over the limit', 'careful', 'warning', 'failed',
      'behind', 'you should', 'try harder', 'only', 'just', '!',
    ];
    renderCard({ ...coffee, target: 3 }, taps(coffee, 5));
    const rendered = screen.root ? collectText(screen.root) : [];
    // The apparatus, not the subject: a walk that collected nothing would pass
    // this test in silence.
    expect(rendered.join(' ')).toContain('past your target of 3');
    for (const s of rendered) {
      for (const word of JUDGEMENTS) {
        expect(s.toLowerCase()).not.toContain(word);
      }
    }
  });
});

/**
 * N432 — the generic add-time choice. `addChoices` is deliberately not about
 * coffee here: the fixture below could be any tracker, which is the point —
 * this component must not need to know what coffee is to offer a picker.
 */
describe('addChoices: a picker instead of a plain increment tap', () => {
  const choices = [
    { key: 'espresso', label: 'Espresso', accessibilityLabel: 'Espresso — about 63 mg caffeine' },
    { key: 'drip', label: 'Drip', accessibilityLabel: 'Drip — about 95 mg caffeine' },
  ];

  it('with no addChoices, `+` still calls onAdd directly — the ordinary tap is unchanged', () => {
    const { onAdd } = renderCard(coffee, []);
    fireEvent.press(screen.getByTestId('tracker-add-cof'));
    expect(onAdd).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId('tracker-choices-cof')).toBeNull();
  });

  it('with addChoices, `+` opens the picker instead of calling onAdd', () => {
    const onAddChoice = jest.fn();
    const { onAdd } = renderCard(coffee, [], { addChoices: choices, onAddChoice });
    fireEvent.press(screen.getByTestId('tracker-add-cof'));

    expect(onAdd).not.toHaveBeenCalled();
    expect(screen.getByTestId('tracker-choice-cof-espresso')).toBeTruthy();
    expect(screen.getByTestId('tracker-choice-cof-drip')).toBeTruthy();
  });

  it('picking a choice fires onAddChoice with its key, and closes the picker', () => {
    const onAddChoice = jest.fn();
    renderCard(coffee, [], { addChoices: choices, onAddChoice });
    fireEvent.press(screen.getByTestId('tracker-add-cof'));
    fireEvent.press(screen.getByTestId('tracker-choice-cof-espresso'));

    expect(onAddChoice).toHaveBeenCalledWith('espresso');
    expect(screen.queryByTestId('tracker-choices-cof')).toBeNull();
  });

  it('pressing `+` again while open closes it without picking anything', () => {
    const onAddChoice = jest.fn();
    renderCard(coffee, [], { addChoices: choices, onAddChoice });
    fireEvent.press(screen.getByTestId('tracker-add-cof'));
    expect(screen.getByTestId('tracker-choices-cof')).toBeTruthy();

    fireEvent.press(screen.getByTestId('tracker-add-cof'));
    expect(screen.queryByTestId('tracker-choices-cof')).toBeNull();
    expect(onAddChoice).not.toHaveBeenCalled();
  });

  it('an empty glyph opens the picker too, not just the `+` button', () => {
    // `+` is not the only add gesture — an empty glyph adds directly on every
    // other tracker (N77/N78), so a coffee card with choices must route that
    // through the SAME picker rather than silently logging a default.
    const onAdd = jest.fn();
    const onAddChoice = jest.fn();
    render(
      <TrackerCard
        tracker={coffee}
        entries={[]}
        units="metric"
        unitsReady
        onAdd={onAdd}
        onRemove={jest.fn()}
        onEdit={() => {}}
        addChoices={choices}
        onAddChoice={onAddChoice}
      />,
    );
    fireEvent.press(screen.getByTestId('tracker-glyph-cof-0'));

    expect(onAdd).not.toHaveBeenCalled();
    expect(screen.getByTestId('tracker-choice-cof-espresso')).toBeTruthy();
  });

  it('labels the add control as a chooser, using the choice\'s own label when picking', () => {
    renderCard(coffee, [], { addChoices: choices, onAddChoice: jest.fn() });
    expect(screen.getByLabelText('Add a cup of Coffee — choose a type')).toBeTruthy();

    fireEvent.press(screen.getByTestId('tracker-add-cof'));
    expect(screen.getByLabelText('Espresso — about 63 mg caffeine')).toBeTruthy();
  });
});

/** Every string the tree renders, including accessibility labels and hints. */
function collectText(node: { children?: unknown[]; props?: Record<string, unknown> }): string[] {
  const out: string[] = [];
  const visit = (n: unknown) => {
    if (typeof n === 'string') {
      out.push(n);
      return;
    }
    if (!n || typeof n !== 'object') return;
    const el = n as { children?: unknown[]; props?: Record<string, unknown> };
    for (const key of ['accessibilityLabel', 'accessibilityHint']) {
      const v = el.props?.[key];
      if (typeof v === 'string') out.push(v);
    }
    for (const child of el.children ?? []) visit(child);
  };
  visit(node);
  return out;
}
