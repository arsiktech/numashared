// Google's own "Continue with Google" button, for the web build. Google Identity Services renders
// it and hands back an ID token, which the backend exchanges for a Numa Shared session like the
// phone's. The page's origin must be listed for the web client in Google Cloud.
import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, View } from 'react-native';
import { T } from '@/ui/primitives';
import { useTheme } from '@/ui/theme';
import { GOOGLE_WEB_CLIENT_ID } from '@/sync/config';

type Gsi = {
  accounts: { id: {
    initialize: (o: { client_id: string; callback: (r: { credential?: string }) => void; ux_mode?: string; use_fedcm_for_prompt?: boolean }) => void;
    renderButton: (el: HTMLElement, o: Record<string, unknown>) => void;
  } };
};

let loading: Promise<Gsi> | null = null;
function loadGsi(): Promise<Gsi> {
  const w = window as unknown as { google?: Gsi };
  if (w.google?.accounts?.id) return Promise.resolve(w.google);
  loading ??= new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = 'https://accounts.google.com/gsi/client';
    s.async = true;
    s.onload = () => (w.google ? resolve(w.google) : reject(new Error('GSI_UNAVAILABLE')));
    s.onerror = () => { loading = null; reject(new Error('GSI_UNAVAILABLE')); };
    document.head.appendChild(s);
  });
  return loading;
}

export function GoogleWebButton({ onCredential, disabled }: { onCredential: (idToken: string) => void; disabled?: boolean }) {
  const host = useRef<View>(null);
  const { c } = useTheme();
  const [state, setState] = useState<'loading' | 'ready' | 'failed'>('loading');
  const latest = useRef(onCredential);
  latest.current = onCredential;
  useEffect(() => {
    if (!GOOGLE_WEB_CLIENT_ID) return;
    let alive = true;
    loadGsi().then((g) => {
      const el = host.current as unknown as HTMLElement | null;
      if (!alive || !el) return;
      g.accounts.id.initialize({ client_id: GOOGLE_WEB_CLIENT_ID!, ux_mode: 'popup', callback: (r) => { if (r.credential) latest.current(r.credential); } });
      // The rest of the app is in English, so the button is too, whatever the browser's language.
      g.accounts.id.renderButton(el, { type: 'standard', theme: 'outline', size: 'large', shape: 'pill', text: 'continue_with', locale: 'en', width: Math.min(400, el.clientWidth || 320) });
      setState('ready');
    }).catch(() => { if (alive) setState('failed'); });
    return () => { alive = false; };
  }, []);
  if (state === 'failed') {
    return <T style={{ fontSize: 14, lineHeight: 20, color: c.ink2, textAlign: 'center' }}>Google sign-in couldn’t load. Check your connection and reload the page.</T>;
  }
  return (
    <View style={{ minHeight: 44, justifyContent: 'center' }}>
      {state === 'loading' ? (
        <View accessibilityLabel="Loading Google sign-in" style={{ position: 'absolute', left: 0, right: 0, height: 44, borderRadius: 22, borderWidth: 1, borderColor: c.hair, alignItems: 'center', justifyContent: 'center', flexDirection: 'row', gap: 8 }}>
          <ActivityIndicator size="small" color={c.ink2} />
          <T style={{ fontSize: 14, color: c.ink2 }}>Loading Google sign-in…</T>
        </View>
      ) : null}
      <View ref={host} style={{ minHeight: 44, alignItems: 'center', opacity: disabled ? 0.5 : 1 }} pointerEvents={disabled ? 'none' : 'auto'} />
    </View>
  );
}
