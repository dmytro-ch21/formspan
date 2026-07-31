import { ActivityIndicator, Pressable, StyleSheet } from 'react-native';

import { Text, View } from '@/components/Themed';
import { vola } from '@/constants/Colors';

/**
 * The "Continue with Google" control plus the divider under it, as one piece
 * so sign-in and sign-up cannot drift apart. Both screens keep their own
 * StyleSheets, and this is the one element that has to look identical on both.
 *
 * Deliberately outlined rather than filled: this screen already has one filled
 * lime button, and two competing primaries is no primary. It sits *above* the
 * email form, matching the order in `apps/web`'s Clerk modal, so the same
 * athlete meets the same sequence on both surfaces.
 *
 * No Google wordmark. Rendering one means carrying Google's brand asset and
 * following its usage rules; a text label is honest, accessible, and costs
 * nothing to keep compliant.
 */
export function GoogleAuthButton({
  onPress,
  busy,
  disabled,
  label = 'Continue with Google',
}: {
  onPress: () => void;
  busy: boolean;
  disabled?: boolean;
  label?: string;
}) {
  return (
    <View style={styles.wrap}>
      <Pressable
        style={[styles.button, (busy || disabled) && styles.buttonDisabled]}
        onPress={onPress}
        disabled={busy || disabled}
        accessibilityRole="button"
        accessibilityLabel={label}
        accessibilityState={{ busy, disabled: busy || disabled }}
        testID="auth-google"
      >
        {busy ? (
          <ActivityIndicator color={vola.text} />
        ) : (
          <Text style={styles.buttonText}>{label}</Text>
        )}
      </Pressable>

      <View style={styles.dividerRow}>
        <View style={styles.rule} />
        <Text style={styles.dividerText}>or</Text>
        <View style={styles.rule} />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { gap: 16 },
  button: {
    borderWidth: 1,
    borderColor: vola.line,
    backgroundColor: vola.surface,
    borderRadius: 12,
    paddingVertical: 15,
    alignItems: 'center',
    justifyContent: 'center',
    // Holds height while the spinner replaces the label, so nothing below
    // jumps when the browser sheet is opening.
    minHeight: 50,
  },
  buttonDisabled: { opacity: 0.6 },
  buttonText: { color: vola.text, fontWeight: '600', fontSize: 15 },

  dividerRow: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  rule: { flex: 1, height: StyleSheet.hairlineWidth, backgroundColor: vola.line },
  dividerText: { color: vola.textDim, fontSize: 12 },
});
