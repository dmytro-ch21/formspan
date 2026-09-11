import fs from 'fs';
import path from 'path';

/**
 * The bottom sheets draw from tokens, not from hand-written whites —
 * N493 part 3 (#858 item 6).
 *
 * **The report.** The athlete, on a device: the Library's "More from your
 * library" curtain "opens a curtain from bottom but the colors are wayyy off
 * from what app looks like".
 *
 * **What it was.** Not one wrong value — five, all of them `rgba(255,255,255,
 * …)` written out by hand, and one of them was the whole complaint: a
 * `LinearGradient` glass wash at `0.10 → 0.03` across the entire sheet. N508
 * later settled the app's one glass wash at `CARD_GLASS_COLORS`
 * (`0.06 → 0.02`) and gave it a component, and every other glass surface in
 * the app moved to it. These two sheets predated that and never did, so their
 * lit corner sat visibly lighter than anything else on screen — which is what
 * "way off from what the app looks like" describes precisely.
 *
 * **Why a source check and not a render test.** The defect is a colour, and a
 * render test that asserts a colour is a restatement of the value it is
 * checking — it passes for whatever the file happens to say. What can
 * actually go wrong again is the *derivation*: somebody writes a literal
 * because it is quicker than importing `withAlpha`. That is a property of the
 * text, so the text is what this reads.
 *
 * **Scope, deliberately narrow.** The two bottom sheets this ticket is about,
 * not the app. Other files hold whites for reasons that are not this bug —
 * `constants/Card.ts` IS the definition of the glass wash, and
 * `BjjRankHeader.tsx` builds a belt-tinted one on purpose (`CardGlass`'s own
 * doc comment blesses that). A repo-wide ban would be a different decision,
 * and not one a bug report about one curtain gets to make.
 */

const SHEETS = [
  ['app/library.tsx', 'the facet and "More from your library" sheets'],
  ['components/food/EntryMenuSheet.tsx', "the food entry's 3-dot menu"],
] as const;

function read(rel: string): string {
  return fs.readFileSync(path.join(__dirname, '..', '..', rel), 'utf8');
}

describe.each(SHEETS)('%s — %s', (rel) => {
  const src = read(rel);

  it('writes no raw white, because vola.text is #F3F6FA and not #FFFFFF', () => {
    const hits = src.split('\n').filter((l) => l.includes('rgba(255,255,255'));
    expect(hits).toEqual([]);
  });

  it('derives its translucent chrome with withAlpha', () => {
    // The positive half: absence above could also be satisfied by deleting
    // the chrome. Something has to still be deriving a colour here.
    expect(src).toContain('withAlpha(');
  });
});

describe('the Library sheets take the glass wash from the one that is settled', () => {
  const src = read('app/library.tsx');

  it('renders CardGlass rather than its own gradient', () => {
    expect(src).toContain('<CardGlass />');
  });

  it('names no gradient stops of its own', () => {
    // `colors={[…]}` on a LinearGradient in this file is how the drift got in.
    expect(src).not.toContain('<LinearGradient');
  });

  it('uses it in BOTH sheets — the facet one and the extras one', () => {
    // The athlete only reported the extras curtain; the facet sheet above it
    // shares every style and had the identical wash, so fixing one and not
    // the other would leave the same bug one tap away.
    expect(src.split('<CardGlass />').length - 1).toBe(2);
  });
});
