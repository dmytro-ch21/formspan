import { useState } from 'react';
import { Pressable, type PressableProps, type StyleProp, type ViewStyle } from 'react-native';
import Animated, { cubicBezier, type CSSStyle } from 'react-native-reanimated';

import { PRESS_BEZIER, PRESS_MS, PRESS_RETENTION, PRESS_SCALE } from '@/constants/Motion';

/**
 * F48/#1059 — a pressable that answers the finger, for everything that is not
 * a `Button`.
 *
 * F38 gave the shared `Button` a press state and deliberately stopped there:
 * 81 files and 346 pressables still respond to a touch with nothing. This is
 * what they migrate onto — the SAME numbers as `Button`, from the same
 * `constants/Motion.ts`, so the app cannot drift back into the four-opacity
 * disagreement F38 just finished consolidating.
 *
 * ## What it is not for
 *
 * **Backdrops, scrims and full-screen dismiss targets.** Their whole job is to
 * be a big tap target behind a sheet; shrinking one when the athlete taps
 * outside is visibly wrong, and there is no affordance to reinforce because
 * the element is invisible by design. Those keep a plain `Pressable`, and
 * `pressFeedback.test.ts` names them so the exemption is a decision on the
 * record rather than a file somebody forgot.
 *
 * **Full-bleed list rows** are an open question, not a default — the platform
 * convention for a row is a background highlight, and a 0.97 scale on
 * something the width of the screen reads oddly. `PressableScale` is for
 * controls: buttons, chips, icons, cards, tiles.
 *
 * ## Why a component rather than a hook
 *
 * The transition has to sit on the element that scales, and the retention
 * offset has to sit on the `Pressable`. A hook would hand both back for every
 * call site to wire up correctly, which is the same "remember it per site"
 * that left `pressRetentionOffset` at zero uses across the whole app before
 * F38.
 */
export type PressableScaleProps = PressableProps & {
  style?: StyleProp<ViewStyle>;
  children?: React.ReactNode;
};

export function PressableScale({ style, children, disabled, ...rest }: PressableScaleProps) {
  /*
    `useState`, not a shared value: this fires twice per press, not per frame.
    A worklet for a two-state toggle is the mobile equivalent of installing a
    motion library for a fade.
  */
  const [pressed, setPressed] = useState(false);

  return (
    <AnimatedPressable
      {...rest}
      disabled={disabled}
      onPressIn={(e) => {
        setPressed(true);
        rest.onPressIn?.(e);
      }}
      onPressOut={(e) => {
        setPressed(false);
        rest.onPressOut?.(e);
      }}
      style={[pressTransition, style, pressed && !disabled && pressedStyle]}
      // Baked in, exactly as on `Button`: a thumb drifting between sets must
      // not cancel a press the athlete meant, and no call site should have to
      // remember that.
      pressRetentionOffset={rest.pressRetentionOffset ?? PRESS_RETENTION}
    >
      {children}
    </AnimatedPressable>
  );
}

const AnimatedPressable = Animated.createAnimatedComponent(Pressable);

/*
  The transition lives on the RESTING style, so the press is instant and only
  the release is eased — 0ms in, 120ms out. Declared on the pressed style it
  would animate the way IN, which is the half nobody should wait for.

  Outside `StyleSheet.create` because React Native's own style types have no
  `transitionProperty`; these are Reanimated's CSS properties and `CSSStyle` is
  where they are typed.
*/
const pressTransition: CSSStyle = {
  transform: [{ scale: 1 }],
  transitionProperty: 'transform',
  transitionDuration: `${PRESS_MS}ms`,
  transitionTimingFunction: cubicBezier(...PRESS_BEZIER),
};

const pressedStyle: CSSStyle = { transform: [{ scale: PRESS_SCALE }] };
