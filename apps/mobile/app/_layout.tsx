import { ClerkProvider, useAuth, useSignUp } from '@clerk/clerk-expo';
import { useAuthToken } from '@/lib/useAuthToken';
import { clearSessionToken } from '@/lib/session';

import { ModulesProvider } from '@/lib/ModulesProvider';
import { TrackEffortProvider } from '@/lib/TrackEffortProvider';
import { setSyncIdentity, startSyncOrchestrator } from '@/lib/sync';
import { seedIfNeeded } from '@/lib/seed';
import { syncSessions } from '@/lib/sessionStore';

import { UnitsProvider } from '@/lib/UnitsProvider';
import { useFonts } from 'expo-font';
import { DarkTheme, Stack, ThemeProvider, useRouter, useSegments } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import { useEffect, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import 'react-native-reanimated';

import { AnimatedSplash } from '@/components/AnimatedSplash';

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

// The native splash is a bare `#080B12` field (see app.json) and `AnimatedSplash`
// opens on the same bare field, so the handover between them has nothing to give
// it away whichever frame it lands on. The cross-fade is belt and braces.
SplashScreen.setOptions({ fade: true, duration: 200 });

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
          <TrackEffortProvider>
            <RootLayoutNav />
          </TrackEffortProvider>
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
  const { isLoaded, isSignedIn, userId } = useAuth();
  const { signUp } = useSignUp();
  const getToken = useAuthToken();
  const segments = useSegments();
  const router = useRouter();
  const [splashDone, setSplashDone] = useState(false);

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

  // The orchestrator owns timers and an AppState listener, so it is started
  // once for the process rather than per screen — a listener per mounted
  // screen is how one foreground transition becomes five syncs.
  useEffect(() => startSyncOrchestrator(), []);

  // Who to sync as. Cleared on sign-out so a queued retry can't fire against
  // the previous athlete's rows.
  useEffect(() => {
    setSyncIdentity(isSignedIn ? (userId ?? null) : null, isSignedIn ? getToken : null);
  }, [isSignedIn, userId, getToken]);

  // Fill the caches once, so the app is usable before it is ever offline.
  //
  // Deliberately NOT awaited and NOT gating render: every screen already
  // paints cache-first with an honest empty state, and blocking a first
  // launch on five network calls would trade a rare bad gym session for a bad
  // first impression on every install. This just makes those caches non-empty
  // sooner than "whenever you happen to open the right screen".
  useEffect(() => {
    if (!isSignedIn || !userId) return;
    void seedIfNeeded(userId, getToken, {
      sessions: async () => {
        await syncSessions(userId, getToken);
      },
    }).catch(() => {
      // Offline on first launch is the ordinary case, not an error: nothing
      // is marked seeded, so the next launch tries again.
    });
  }, [isSignedIn, userId, getToken]);

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

  // Hold the UI until Clerk resolves, so the first frame isn't the wrong screen
  // followed by a visible redirect. This used to `return null` outright; now the
  // splash covers that gap instead of a blank screen doing it, and `ready` below
  // is what keeps the splash from lifting off one.
  return (
    <View style={styles.root}>
      {isLoaded ? <RootStack /> : null}
      {splashDone ? null : (
        <AnimatedSplash ready={isLoaded} onFinish={() => setSplashDone(true)} />
      )}
    </View>
  );
}

// Always dark, and carrying VOLA's own ground rather than React Navigation's
// default near-black — the app has one palette.
function RootStack() {
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
        <Stack.Screen name="position/[id]" options={{ title: 'Position' }} />
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

const styles = StyleSheet.create({
  // The splash is absolutely positioned over this, and until Clerk resolves
  // there is nothing else in it — so it carries the background itself rather
  // than letting a white root show through for those frames.
  root: { flex: 1, backgroundColor: vola.bg },
});
