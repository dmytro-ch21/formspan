import { useAuth } from '@clerk/clerk-expo';
import { useRouter } from 'expo-router';
import { useState } from 'react';
import { Pressable, ScrollView, StyleSheet } from 'react-native';

import { ScreenHeader, TAB_BAR_CLEARANCE } from '@/components/ScreenHeader';
import { Text, View } from '@/components/Themed';
import { Icon } from '@/components/ui/Icon';
import { PickSessionSheet } from '@/components/ui/PickSessionSheet';
import { vola } from '@/constants/Colors';
import { useAccent } from '@/lib/AccentProvider';
import { enabledSports } from '@/lib/modules';
import { useModules } from '@/lib/ModulesProvider';
import { startSessionHref } from '@/lib/startSession';

/**
 * Train — where a session is started, and eventually where it is run.
 *
 * ## What this is, and what it is not
 *
 * A **shell**, deliberately. N176 (#581) added the tab; N177 (#582) builds the
 * execution hub inside it. The ticket that added it says in as many words not
 * to design the screen deeply yet, so this file holds exactly one thing: the
 * action that makes the tab honest on the day it ships.
 *
 * A tab called Train that cannot start training is worse than no tab, and
 * "coming soon" on a shipped bottom-bar slot is the same claim dressed up. So
 * the shell starts a session and says plainly that the rest arrives next.
 *
 * ## It reuses the picker rather than growing a second one
 *
 * `PickSessionSheet` is the app's one answer to "what do you want to train?",
 * with Today and the week planner already on it, and its own docstring records
 * why: this app has had three disagreeing sport lists, which is what the module
 * registry exists to prevent. Where a pick GOES is `lib/startSession.ts`, which
 * Today now calls too — that branch was inline there until this screen needed
 * the same decision.
 *
 * Nothing here creates or writes a session. The engines that do — `sessionStore`,
 * `session/start`, `bjj/log` — are untouched, which is the epic's hard
 * non-regression: strength logging stays fast, inline and local-first, and BJJ
 * keeps its three-tap floor, because neither has been re-entered from here.
 *
 * ## The no-disciplines state
 *
 * Same as Today's, and the same wording: an athlete who has enabled nothing is
 * offered the screen that fixes it rather than a picker with nothing in it.
 * `PickSessionSheet` itself lists disciplines that exist and are turned OFF, so
 * a switched-off sport is still visible and still explains itself from here —
 * N61's rule, which this file gets by using the shared component.
 */
export default function TrainScreen() {
  const { modules } = useModules();
  const { userId } = useAuth();
  const accent = useAccent();
  const router = useRouter();

  const [picking, setPicking] = useState(false);
  const startable = enabledSports(modules);

  return (
    <View style={styles.screen}>
      <ScreenHeader title="Train" />
      <ScrollView contentContainerStyle={styles.body}>
        <Text style={styles.lead}>Start a session, or log one you have finished.</Text>

        {startable.length > 0 ? (
          <Pressable
            style={({ pressed }) => [
              styles.start,
              { backgroundColor: accent.accent },
              pressed && styles.pressed,
            ]}
            onPress={() => setPicking(true)}
            accessibilityRole="button"
            accessibilityLabel="New log"
            testID="train-new-log"
          >
            <Icon name="plus" size={16} color={accent.on} />
            <Text numberOfLines={1} style={[styles.startText, { color: accent.on }]}>
              New log
            </Text>
          </Pressable>
        ) : (
          <Pressable
            style={styles.choose}
            onPress={() => router.push('/profile/edit')}
            accessibilityRole="button"
            accessibilityLabel="Choose what you train"
            testID="train-choose-sports"
          >
            <Text style={styles.chooseText}>Choose what you train</Text>
          </Pressable>
        )}

        {/*
          Dashed, following #468's rule: a placeholder standing WHERE content
          would stand is dashed, one standing BESIDE content is a card. The rest
          of this screen is the content that is not here yet, so this is the
          former — and a solid card would read as the thing rather than as its
          absence.
        */}
        <View style={styles.soon} testID="train-soon">
          <Text style={styles.soonTitle}>The rest of Train is on its way</Text>
          <Text style={styles.soonNote}>
            Running a session, the rest timer and swapping an exercise still live where
            they always have. Today lists what is planned and what is open.
          </Text>
        </View>
      </ScrollView>

      <PickSessionSheet
        visible={picking}
        modules={modules}
        userId={userId ?? null}
        title="New log"
        onClose={() => setPicking(false)}
        onPick={(pick) => {
          // Closed before navigating, exactly as Today does it: leaving the
          // modal mounted over a push means coming back from the session lands
          // on the sheet again.
          setPicking(false);
          router.push(startSessionHref(pick, modules));
        }}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: vola.bg },
  body: { paddingHorizontal: 20, paddingBottom: TAB_BAR_CLEARANCE, gap: 16 },
  lead: { color: vola.textMuted, fontSize: 14, lineHeight: 20 },

  start: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    height: 52,
    borderRadius: 26,
  },
  pressed: { opacity: 0.85 },
  startText: { fontSize: 15, fontWeight: '700', letterSpacing: 0.4 },

  choose: {
    alignItems: 'center',
    justifyContent: 'center',
    height: 52,
    borderRadius: 26,
    borderWidth: 1,
    borderStyle: 'dashed',
    borderColor: vola.lineSoft,
  },
  chooseText: { fontSize: 15, fontWeight: '600' },

  soon: {
    borderWidth: 1,
    borderStyle: 'dashed',
    borderColor: vola.lineSoft,
    borderRadius: 16,
    padding: 20,
    gap: 6,
  },
  soonTitle: { fontSize: 15, fontWeight: '700' },
  // textMuted rather than textDim: at 13pt this is small text, and textDim
  // measures 3.96:1 on `bg`, below AA's 4.5:1.
  soonNote: { color: vola.textMuted, fontSize: 13, lineHeight: 19 },
});
