import { render, screen } from '@testing-library/react-native';
import { StyleSheet } from 'react-native';

import { Stat, StatValue } from '../ui/Stat';

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
