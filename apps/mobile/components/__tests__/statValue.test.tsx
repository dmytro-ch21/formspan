import { render, screen } from '@testing-library/react-native';
import { StyleSheet } from 'react-native';

import { Stat, StatRow, StatValue } from '../ui/Stat';

/**
 * The figure/unit split, and the size ladder that keeps a long one in its
 * column.
 *
 * Written because the session screen's summary carried its own copy of this
 * component for months — `adjustsFontSizeToFit minimumFontScale={0.6}` and the
 * unit baked into the value string — and a four-figure volume came out shrunk
 * to two-thirds the size of the single digits beside it. "480kg" next to "1"
 * and "8" at different sizes is what "it truncates and the whole thing is ugly"
 * looks like.
 *
 * The shared component's own comment explains why `adjustsFontSizeToFit` is the
 * wrong tool — it measures after layout and is unreliable across the nested
 * `Text` runs this renders. These tests pin the deterministic alternative, so a
 * future "simplification" back to the prop has to argue with a red test.
 */

/**
 * The rendered tree is a Text whose children are the figure string and a nested
 * Text for the unit — so `getByText('480')` cannot match (the outer node's text
 * is "480kg"). These read the JSON tree instead, which is also what makes the
 * font sizes inspectable at all.
 */
type Node = { type: string; props: { style?: unknown }; children: (Node | string)[] | null };

const tree = (ui: React.ReactElement): Node => {
  const r = render(ui);
  const json = r.toJSON() as unknown as Node;
  r.unmount();
  return json;
};

// StyleSheet.flatten, not a hand-rolled merge: registered styles arrive as
// opaque ids under jest-expo, and spreading those produces nothing.
const fontSize = (n: Node): number | undefined =>
  (StyleSheet.flatten(n.props.style as never) as { fontSize?: number } | undefined)?.fontSize;

const strings = (n: Node): string[] =>
  (n.children ?? []).filter((c): c is string => typeof c === 'string');

const nested = (n: Node): Node[] =>
  (n.children ?? []).filter((c): c is Node => typeof c === 'object' && c !== null);

describe('StatValue', () => {
  it('sets the unit smaller than the figures', () => {
    const t = tree(<StatValue value="480kg" size={22} />);

    expect(strings(t)).toEqual(['480']);
    expect(fontSize(t)).toBe(22);

    const unit = nested(t)[0];
    expect(strings(unit)).toEqual(['kg']);
    // 62% — quiet enough that the two read as one quantity.
    expect(fontSize(unit)).toBe(Math.round(22 * 0.62));
  });

  it('keeps a thousands separator inside the figure', () => {
    // "12,450" is one number. Split on the comma, the "," would render small
    // and muted in the middle of the figure.
    const t = tree(<StatValue value="12,450kg" size={22} />);
    expect(strings(t)).toEqual(['12,450']);
    expect(strings(nested(t)[0])).toEqual(['kg']);
  });

  it('shrinks a long figure but only when asked to fit', () => {
    // The case the session summary hits: pounds run an order of magnitude
    // longer than kilos, so one session reads "553.7k lb".
    expect(fontSize(tree(<StatValue value="553.7k lb" size={22} fit />))!).toBeLessThan(22);
    // ...and a short one is untouched, so a row of stats does not end up at
    // three different sizes — which is exactly what the old session summary did.
    expect(fontSize(tree(<StatValue value="8" size={22} fit />))).toBe(22);
    // Without `fit`, nothing shrinks: the ladder is opt-in because most screens
    // give a figure all the room it wants.
    expect(fontSize(tree(<StatValue value="553.7k lb" size={22} />))).toBe(22);
  });

  it('renders an unknown value as a full-size dash, not a unit', () => {
    // The em dash is this codebase's "we don't know". Treated as a unit it
    // would render small and muted, collapsing the column instead of holding a
    // number's worth of space.
    const t = tree(<StatValue value="—" size={22} />);
    expect(strings(t)).toEqual(['—']);
    expect(fontSize(t)).toBe(22);
    expect(nested(t)).toHaveLength(0);
  });
});

describe('Stat', () => {
  it('reads the figure and its label as one thing', () => {
    // Ungrouped, VoiceOver announces the number and the word as two unrelated
    // stops with nothing connecting them.
    render(<Stat label="Volume" value="480kg" />);
    expect(screen.getByLabelText('480kg Volume')).toBeTruthy();
  });
});

describe('the values the session summary actually shows', () => {
  it('keeps a clock together', () => {
    // `2:39` is one quantity. Split on the colon it rendered as two full-size
    // figures either side of a muted 14pt `:` — worse than the problem this
    // component was brought in to fix, and `1:23:45` did it twice.
    for (const clock of ['2:39', '1:23:45']) {
      const t = tree(<StatValue value={clock} size={22} />);
      expect(strings(t)).toEqual([clock]);
      expect(nested(t)).toHaveLength(0);
    }
  });

  it('shrinks harder in a four-column row than a three', () => {
    // The ladder was tuned for thirds (~90pt of content); the session summary
    // is quarters (~60pt). `1:23:45`, `251.1t` and `12,450lb` all overflowed a
    // quarter at the three-column sizes.
    for (const value of ['1:23:45', '251.1t', '12,450lb', '553.7k lb']) {
      const three = fontSize(tree(<StatValue value={value} size={22} fit slots={3} />))!;
      const four = fontSize(tree(<StatValue value={value} size={22} fit slots={4} />))!;
      expect(four).toBeLessThanOrEqual(three);
    }
    // ...and at least one of them genuinely moves, or the rung shift is inert.
    expect(fontSize(tree(<StatValue value="251.1t" size={22} fit slots={4} />))!).toBeLessThan(
      fontSize(tree(<StatValue value="251.1t" size={22} fit slots={3} />))!,
    );
  });

  it('never shrinks below two-thirds, however long the value', () => {
    // A floor, so a pathological string cannot render as unreadable specks.
    const smallest = fontSize(tree(<StatValue value="1,234,567,890kg" size={22} fit slots={4} />))!;
    expect(smallest).toBeGreaterThanOrEqual(Math.round(22 * 0.62));
  });
});

describe('StatRow', () => {
  it('does not render an empty slot for a single falsy child', () => {
    // `<StatRow>{finished && <Stat/>}</StatRow>` is not an array, so the old
    // Array.isArray form fell through to `[children]` and rendered one empty
    // column. The session summary gates its Volume stat exactly this way.
    const t = tree(<StatRow>{false}</StatRow>);
    expect(nested(t)).toHaveLength(0);
  });

  it('tells its children how many columns they are sharing', () => {
    // Four stats must shrink on the four-column ladder without every call site
    // having to pass the count itself.
    // Measured FIRST: `tree` unmounts, which would tear down the row's screen.
    const solo = fontSize(tree(<StatValue value="251.1t" size={22} fit slots={3} />))!;

    render(
      <StatRow>
        <Stat label="Time" value="1:23:45" size={22} fit />
        <Stat label="Sets" value="12" size={22} fit />
        <Stat label="Reps" value="96" size={22} fit />
        <Stat label="Volume" value="251.1t" size={22} fit />
      </StatRow>,
    );
    const inRow = StyleSheet.flatten(
      screen.getByText('251.1t').props.style as never,
    ) as { fontSize?: number };
    expect(inRow.fontSize).toBeLessThan(solo);
  });
});
