import { ClerkProvider, useAuth } from '@clerk/clerk-expo';
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
      <RootLayoutNav />
    </ClerkProvider>
  );
}

function RootLayoutNav() {
  const { isLoaded, isSignedIn } = useAuth();
  const segments = useSegments();
  const router = useRouter();

  useEffect(() => {
    if (!isLoaded) return;

    // Keyed on the sign-in screen specifically, not on "is this the tabs".
    // The earlier version bounced any signed-in user off any route outside
    // (tabs) — harmless while sign-in was the only such route, but it made
    // every pushed screen unreachable the moment one existed: tapping a
    // workout navigated and was instantly replaced back to the tab root.
    const onSignIn = segments[0] === 'sign-in';
    if (!isSignedIn && !onSignIn) {
      router.replace('/sign-in');
    } else if (isSignedIn && onSignIn) {
      router.replace('/');
    }
  }, [isLoaded, isSignedIn, segments, router]);

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
        {/* Pushed over the tabs so the workout keeps a back button to the
            list it came from, rather than becoming a tab of its own. */}
        <Stack.Screen name="workout/[id]" options={{ title: 'Workout' }} />
        <Stack.Screen name="settings" options={{ title: 'Settings' }} />
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
