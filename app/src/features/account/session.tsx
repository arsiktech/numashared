// Sign-in state and the "Continue with Apple" button used by Welcome, Join, Invite and Settings.
import { useEffect, useState, useSyncExternalStore } from 'react';
import Constants from 'expo-constants';
import Svg, { Path } from 'react-native-svg';
import { View } from 'react-native';
import { appleSignInSupported, AuthError, currentSession, googleSignInAvailable, subscribeSession } from '@/sync/auth';
import { signIn } from '@/sync/runtime';
import { showToast } from '@/store/ui';
import { Apple } from '@/ui/icons';
import { CTA, haptic } from '@/ui/primitives';

export function useSession() {
  return useSyncExternalStore(subscribeSession, currentSession, currentSession);
}

/** Running inside Expo Go, where Apple sign-in can't reach this app's account. */
export const inExpoGo = Constants.executionEnvironment === 'storeClient';

/** Sign in with Apple exists only in the installed iPhone and iPad app for now. */
export function useAppleAvailable() {
  const [ok, setOk] = useState(false);
  useEffect(() => { if (!inExpoGo) void appleSignInSupported().then(setOk); }, []);
  return ok;
}

/** Plain words for a sign-in or sync failure. */
export function explainFailure(code: string): string {
  if (code === 'NETWORK_UNAVAILABLE' || code === 'TRANSPORT_UNAVAILABLE') return 'No connection right now. Try again when you’re online.';
  if (code === 'GOOGLE_SIGN_IN_UNAVAILABLE') return 'Google sign-in isn’t switched on yet. Use Apple for now.';
  if (code === 'GOOGLE_AUDIENCE_REJECTED') return 'This build of the app can’t sign in with Google. Install the latest Numa Shared.';
  if (code === 'PLAY_SERVICES_NOT_AVAILABLE') return 'Google sign-in needs Google Play services on this phone.';
  if (code === 'APPLE_AUDIENCE_REJECTED') return inExpoGo
    ? 'Sign-in works in the Numa Shared app itself, not inside Expo Go.'
    : 'This build of the app can’t sign in. Install Numa Shared from TestFlight.';
  if (code.endsWith('RATE_LIMITED')) return 'Too many tries. Wait a minute, then try again.';
  if (code === 'SESSION_LIMIT_REACHED' || code === 'IDENTITY_REQUEST_FAILED') return 'Couldn’t sign in just now. Try again in a moment.';
  return `Couldn’t finish that (${code}). Try again.`;
}

/** Which sign-in methods this build can offer right now. */
export function useSignInOptions() {
  const apple = useAppleAvailable();
  const google = !inExpoGo && googleSignInAvailable();
  return { apple, google, any: apple || google };
}

/**
 * Continue with Apple and Continue with Google, stacked. `verb` finishes the label, for example
 * "to join" gives "Continue with Apple to join". Calls onSignedIn with how many households arrived.
 */
export function SignInButtons({ verb, onSignedIn, disabled }: {
  verb?: string; onSignedIn?: (arrived: number) => void; disabled?: boolean;
}) {
  const { apple, google } = useSignInOptions();
  const [busy, setBusy] = useState<'apple' | 'google' | null>(null);
  const run = async (provider: 'apple' | 'google') => {
    setBusy(provider);
    try {
      const arrived = await signIn(provider);
      haptic.success();
      onSignedIn?.(arrived);
    } catch (e) {
      if (e instanceof AuthError && e.code === 'CANCELLED') return;
      showToast(explainFailure(e instanceof AuthError ? e.code : `${provider.toUpperCase()}_SIGN_IN_FAILED`));
    } finally {
      setBusy(null);
    }
  };
  const tail = verb ? ` ${verb}` : '';
  return (
    <View style={{ gap: 12 }}>
      {apple ? (
        <CTA variant="apple" label={busy === 'apple' ? 'Signing in…' : `Continue with Apple${tail}`} disabled={!!busy || disabled}
          icon={<Apple size={20} color="#FFFFFF" />} onPress={() => run('apple')} />
      ) : null}
      {google ? (
        <CTA variant="google" label={busy === 'google' ? 'Signing in…' : `Continue with Google${tail}`} disabled={!!busy || disabled}
          icon={<GoogleG size={20} />} onPress={() => run('google')} />
      ) : null}
    </View>
  );
}

/** Google's multicolor G, as its sign-in guidelines ask. */
function GoogleG({ size = 20 }: { size?: number }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 48 48" accessibilityElementsHidden importantForAccessibility="no">
      <Path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z" />
      <Path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z" />
      <Path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z" />
      <Path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z" />
    </Svg>
  );
}
