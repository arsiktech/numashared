// Sign-in state and the "Continue with Apple" button used by Welcome, Join, Invite and Settings.
import { useEffect, useState, useSyncExternalStore } from 'react';
import Constants from 'expo-constants';
import { appleSignInSupported, AuthError, currentSession, subscribeSession } from '@/sync/auth';
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
  if (code === 'APPLE_AUDIENCE_REJECTED') return inExpoGo
    ? 'Sign-in works in the Numa Shared app itself, not inside Expo Go.'
    : 'This build of the app can’t sign in. Install Numa Shared from TestFlight.';
  if (code.endsWith('RATE_LIMITED')) return 'Too many tries. Wait a minute, then try again.';
  if (code === 'SESSION_LIMIT_REACHED' || code === 'IDENTITY_REQUEST_FAILED') return 'Couldn’t sign in just now. Try again in a moment.';
  return `Couldn’t finish that (${code}). Try again.`;
}

export function AppleCTA({ label = 'Continue with Apple', onSignedIn, disabled }: {
  label?: string; onSignedIn?: (arrived: number) => void; disabled?: boolean;
}) {
  const [busy, setBusy] = useState(false);
  return (
    <CTA variant="apple" label={busy ? 'Signing in…' : label} disabled={busy || disabled}
      icon={<Apple size={20} color="#FFFFFF" />}
      onPress={async () => {
        setBusy(true);
        try {
          const arrived = await signIn();
          haptic.success();
          onSignedIn?.(arrived);
        } catch (e) {
          if (e instanceof AuthError && e.code === 'CANCELLED') return;
          showToast(explainFailure(e instanceof AuthError ? e.code : 'APPLE_SIGN_IN_FAILED'));
        } finally {
          setBusy(false);
        }
      }} />
  );
}
