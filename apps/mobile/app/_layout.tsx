import { ClerkProvider, useAuth, useSignUp } from '@clerk/clerk-expo';
import { clearSessionToken } from '@/lib/session';

import { ModulesProvider } from '@/lib/ModulesProvider';
import { UnitsProvider } from '@/lib/UnitsProvider';
import { useFonts } from 'expo-font';
import { DarkTheme, Stack, ThemeProvider, useRouter, useSegments } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import { useEffect } from 'react';
import 'react-native-reanimated';

import { tokenCache } from '@/lib/tokenCache';
import { vola } from '@/constants/Colors';

const volaNavTheme = {
  ...DarkTheme,
  colors: {
    ...DarkTheme.colors,
    background: vola.bg,
    card: vola.surface,
    border: vola.lineSoft,
    text: vola.text,
    primary: vola.lime,
  },
};

export {
  // Catch any errors thrown by the Layout component.
  ErrorBoundary,
} from 'expo-router';

export const unstable_settings = {
  initialRouteName: '(tabs)',
};

// Prevent the splash screen from auto-hiding before asset loading is complete.
SplashScreen.preventAutoHideAsync();

const publishableKey = process.env.EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY;

export default function RootLayout() {
  const [loaded, error] = useFonts({
    SpaceMono: require('../assets/fonts/SpaceMono-Regular.ttf'),
  });

  // Expo Router uses Error Boundaries to catch errors in the navigation tree.
  useEffect(() => {
    if (error) throw error;
  }, [error]);

  useEffect(() => {
    if (loaded) {
      SplashScreen.hideAsync();
    }
  }, [loaded]);

  if (!loaded) {
    return null;
  }

  if (!publishableKey) {
    // Fail loudly rather than rendering a half-working app that silently
    // can't authenticate.
    throw new Error(
      'EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY is not set — copy apps/mobile/.env.example to .env.local',
    );
  }

  return (
    <ClerkProvider publishableKey={publishableKey} tokenCache={tokenCache}>
      {/* Inside ClerkProvider because it keys on userId, and above the
          navigator because the tab bar is built from it. */}
      <ModulesProvider>
        <UnitsProvider>
          <RootLayoutNav />
        </UnitsProvider>
      </ModulesProvider>
    </ClerkProvider>
  );
}

/**
 * Every screen a signed-out user is allowed to be on. Adding a route here is
 * not optional bookkeeping — the guard below replaces any path not in this
 * list with `/sign-in`, so a missing entry makes the new screen unreachable.
 */
const AUTH_ROUTES = ['sign-in', 'sign-up', 'forgot-password'];

function RootLayoutNav() {
  const { isLoaded, isSignedIn } = useAuth();
  const { signUp } = useSignUp();
  const segments = useSegments();
  const router = useRouter();

  // A sign-up that got as far as "account created, email not yet verified" and
  // was then interrupted — a killed app, a lost connection. Clerk keeps it on
  // the client, and `sign-up.tsx` knows how to resume it, but only if the user
  // is actually sent there. Sending them to sign-in instead strands them: the
  // password they chose can't sign in against an unverified account, and the
  // error doesn't hint that sign-up is where the exit is.
  //
  // A boolean, not the resource, so the effect doesn't re-run on every
  // identity change of a Clerk object it doesn't otherwise read.
  const hasPendingSignUp =
    signUp?.status === 'missing_requirements' &&
    (signUp.unverifiedFields?.includes('email_address') ?? false);

  useEffect(() => {
    if (!isLoaded) return;

    // Keyed on the sign-in screen specifically, not on "is this the tabs".
    // The earlier version bounced any signed-in user off any route outside
    // (tabs) — harmless while sign-in was the only such route, but it made
    // every pushed screen unreachable the moment one existed: tapping a
    // workout navigated and was instantly replaced back to the tab root.
    // A *set* of auth routes, not one route: each of these sits outside the
    // signed-in app just as sign-in does, and keying on sign-in alone would
    // bounce a signed-out user straight back off the screen they just opened —
    // silently, one frame after it rendered. Every new auth screen belongs in
    // AUTH_ROUTES; that is the whole reason it's a named constant next to the
    // routes themselves rather than an inline `||` chain that grows.
    // Drop the brokered token the moment Clerk says there is no session —
    // a remote sign-out, a revoked session, an expired one. The Settings
    // button is NOT the only way out of a session, and the token is persisted
    // in the keychain, so relying on that button alone left the next athlete
    // on a shared device authenticating as the previous one until the token
    // expired. Keyed on the transition, so it runs once rather than on every
    // navigation while signed out.
    if (!isSignedIn) void clearSessionToken();

    const onAuthScreen = AUTH_ROUTES.includes(segments[0] as string);
    if (!isSignedIn && !onAuthScreen) {
      router.replace(hasPendingSignUp ? '/sign-up' : '/sign-in');
    } else if (isSignedIn && onAuthScreen) {
      router.replace('/');
    }
  }, [isLoaded, isSignedIn, hasPendingSignUp, segments, router]);

  // Hold the UI until Clerk resolves, so the first frame isn't the wrong
  // screen followed by a visible redirect.
  if (!isLoaded) {
    return null;
  }

  // Always dark, and carrying VOLA's own ground rather than React
  // Navigation's default near-black — the app has one palette.
  return (
    <ThemeProvider value={volaNavTheme}>
      <Stack
        screenOptions={{
          // One continuous ground on pushed screens too. The default header
          // paints its own surface colour and a hairline rule under it,
          // which on a dark theme reads as a seam splitting the screen into
          // two slabs — the same separation the tab shell just lost.
          headerStyle: { backgroundColor: vola.bg },
          headerShadowVisible: false,
          headerTintColor: vola.lime,
          headerTitleStyle: { color: vola.text },
          contentStyle: { backgroundColor: vola.bg },
        }}
      >
        {/* `title` is never shown (the header is hidden) but it is what the
            next screen's back button says — without it that reads "(tabs)". */}
        <Stack.Screen name="(tabs)" options={{ headerShown: false, title: 'Today' }} />
        <Stack.Screen name="sign-in" options={{ title: 'Sign in' }} />
        <Stack.Screen name="sign-up" options={{ title: 'Create account' }} />
        <Stack.Screen name="forgot-password" options={{ title: 'Reset password' }} />
        {/* Pushed over the tabs so the workout keeps a back button to the
            list it came from, rather than becoming a tab of its own. */}
        <Stack.Screen name="workout/[id]" options={{ title: 'Workout' }} />
        <Stack.Screen name="settings" options={{ title: 'Settings' }} />
        <Stack.Screen name="settings/units" options={{ title: 'Units' }} />
        <Stack.Screen name="profile/edit" options={{ title: 'Edit profile' }} />
        <Stack.Screen name="exercise/[id]" options={{ title: 'Exercise' }} />
        <Stack.Screen name="technique/[id]" options={{ title: 'Technique' }} />
        <Stack.Screen name="session/start" options={{ title: 'Start' }} />
        <Stack.Screen name="session/[id]" options={{ title: 'Session' }} />
        {/* Presented as a sheet: picking an exercise is an interruption of
            logging, not a place you navigate to and stay. */}
        <Stack.Screen
          name="session/[id]/add"
          options={{ title: 'Add exercise', presentation: 'modal' }}
        />
      </Stack>
    </ThemeProvider>
  );
}
