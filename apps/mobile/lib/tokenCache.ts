import * as SecureStore from 'expo-secure-store';

/**
 * Persists Clerk's session token in the OS keychain (Keychain on iOS,
 * Keystore on Android) rather than AsyncStorage, so it isn't readable as
 * plaintext from the app sandbox. Without a cache, the session is lost on
 * every app restart.
 */
export const tokenCache = {
  async getToken(key: string) {
    try {
      return await SecureStore.getItemAsync(key);
    } catch {
      // A corrupt/unreadable keychain entry should force a fresh sign-in,
      // not crash the app on launch.
      await SecureStore.deleteItemAsync(key).catch(() => {});
      return null;
    }
  },
  async saveToken(key: string, value: string) {
    try {
      await SecureStore.setItemAsync(key, value);
    } catch {
      // Non-fatal: the session still works for this launch, it just won't
      // survive a restart.
    }
  },
};
