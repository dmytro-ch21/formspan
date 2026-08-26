import { StyleSheet, View } from 'react-native';

import { Text } from '@/components/Themed';
import { vola } from '@/constants/Colors';
import type { Module } from '@/lib/modules';

/**
 * A whole route saying which module is turned off — N61 / #423.
 *
 * ## Why a whole screen and not a placeholder
 *
 * `bjj/index`, `bjj/log`, `bjj/positions` and `PromotionForm` already do this
 * by hand: with the discipline off they replace their entire body with "BJJ
 * tracking is off / turn it back on under Sports in your profile". #370's
 * finding was that those screens were never the problem — nothing LINKED to
 * them while the module was off, so the athlete never reached the screen that
 * would explain itself. The fix there was to restore the links.
 *
 * The Food and Goals tabs were that same link, for nutrition. Restoring them
 * (see `(tabs)/_layout.tsx`) was only half the fix: a tab leading to a target
 * screen that renders a target nobody set would trade a silent absence for a
 * confusing presence. So the two screens gained the off-state their BJJ
 * counterparts already had, and it lives here rather than being hand-written a
 * fifth and sixth time.
 *
 * **N176 (#581) took those two out of the bottom bar** — the routes stay, and
 * Today links to both — so this notice is now reached from a link rather than
 * from a tab. That makes it more load-bearing, not less: it is the only thing
 * on those two screens that distinguishes "turned off" from "broken", and the
 * screens are still resolvable by deep link from anywhere.
 *
 * ## Neither dashed nor a card, and that is deliberate
 *
 * #468 set the placeholder rule: one standing WHERE content would stand is
 * dashed, one standing BESIDE content is a card. Both of those are about a slot
 * inside a populated screen — Today's Fuel row has cards above and below it, so
 * the border is what stops an athlete reading the absence as the thing. Here
 * there is no screen around the notice; the notice is the screen. Nothing to be
 * mistaken for, nothing to be consistent with, and a dashed rectangle wrapped
 * around an entire viewport reads as a broken layout rather than a placeholder.
 * The four BJJ screens all settled on plain centred text and that is the
 * precedent this follows.
 *
 * ## Three states, not two
 *
 * `module` is `undefined` when this deployment has no such module AT ALL — the
 * state `moduleOffWithFoodLog` exists to separate — and then there is no offer
 * to make, because promising a feature the server does not have is the same lie
 * as hiding one it does. Nothing links to these screens in that case, so it is
 * only reachable by deep link or a stale back-stack entry, which is exactly the
 * route `bjj/positions` documents for its own copy of this guard.
 */
export function ModuleOffNotice({
  module,
  action,
  testID,
}: {
  /** The disabled module, or undefined if this deployment has none. */
  module: Module | undefined;
  /** What turning it back on would let the athlete do — "log food". */
  action: string;
  testID?: string;
}) {
  return (
    <View style={styles.centre} testID={testID}>
      {module === undefined ? (
        // No offer, because there is nothing to accept — and no module NAME
        // either, since naming one this deployment does not have is the lie
        // this branch exists to avoid. Phrased around what the athlete came to
        // do, which is the one thing still known.
        <>
          <Text style={styles.title}>Not available</Text>
          <Text style={styles.muted}>Nothing here is set up to {action}.</Text>
        </>
      ) : (
        <>
          {/* The module's own LABEL, from the registry — "1 discipline is off"
              does not tell an athlete it is the one they went looking for, and
              a capitalised key gives "Bjj" where the registry says "BJJ". */}
          <Text style={styles.title}>{module.label} is turned off</Text>
          <Text style={styles.muted}>
            Turn it back on under Sports in your profile to {action}.
          </Text>
        </>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  // Matching `bjj/log`'s `centre` exactly rather than approximately: these are
  // the same thing on two screens, and the moment they differ by 4pt somebody
  // reads it as intentional.
  centre: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 32, gap: 8 },
  title: { fontSize: 18, fontWeight: '700', textAlign: 'center' },
  // textMuted, not textDim: at 13pt this is small text, and textDim measures
  // 3.96:1 on `bg` — below AA's 4.5:1. textMuted is 7.38:1.
  muted: { color: vola.textMuted, fontSize: 13, textAlign: 'center' },
});
