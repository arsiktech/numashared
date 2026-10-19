// Join with a code. The code field formats as you type ("K7Q 4MZ"). The code is checked with the
// server first, so a wrong or used code says so before anyone signs in; then Continue with Apple
// (on iPhone) joins and opens the household. Invite links land here with the code filled in.
import { useEffect, useRef, useState } from 'react';
import { View } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { CloudOff, Warn } from '@/ui/icons';
import { Banner, BannerText, CTA, haptic, Press, T } from '@/ui/primitives';
import { useTheme } from '@/ui/theme';
import { fonts, isWeb } from '@/ui/tokens';
import { Brand, Field, Screen, ScreenHeader } from '@/features/onboarding/chrome';
import { cleanCode, showCode } from '@/features/onboarding/model';
import { explainFailure, SignInButtons, useSession, useSignInOptions } from '@/features/account/session';
import { useStore } from '@/store/store';
import { failureOf, type InvitePreview } from '@/sync/engine';
import { joinWithInvite, lookUpInvite, requestSync } from '@/sync/runtime';

type Active = Extract<InvitePreview, { status: 'active' }>;

const NOT_ACTIVE: Record<string, string> = {
  invalid: 'That code doesn’t match an invite. Check it with the person who invited you.',
  expired: 'That invite has expired. Ask for a new code.',
  revoked: 'That invite was cancelled. Ask for a new code.',
  used: 'That code has already been used. Each code works once, for one person.',
  rateLimited: 'Too many tries. Wait a minute, then try again.',
  unavailable: 'Couldn’t check the code: no connection. Try again when you’re online.',
};

export default function Join() {
  const { c, tone, layout } = useTheme();
  const router = useRouter();
  // `link` comes from an invite link opened in the app; `code` from the web invite page's button.
  const params = useLocalSearchParams<{ link?: string; code?: string }>();
  const [code, setCode] = useState(() => (params.link ? cleanCode(/code=([A-Za-z0-9]{6})/.exec(params.link)?.[1] ?? params.link)
    : params.code ? cleanCode(params.code) : ''));
  const [link, setLink] = useState(params.link ?? null);
  const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState<InvitePreview | null>(null);
  const [waiting, setWaiting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const hasHousehold = useStore((s) => s.households.length > 0 && !s.locked);
  const session = useSession();
  const signInOptions = useSignInOptions();
  const phone = layout === 'phone';
  const citrus = tone('citrus');
  const lilac = tone('lilac');
  const ready = code.length === 6;
  const active = preview?.status === 'active' ? (preview as Active) : null;

  const check = async () => {
    if ((!ready && !link) || busy) return;
    setBusy(true);
    setWaiting(false);
    const result = await lookUpInvite(link ?? code);
    setBusy(false);
    setPreview(result);
    if (result.status === 'active') haptic.success(); else haptic.warn();
  };

  const join = async (p: Active, retried = false): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      const result = await joinWithInvite(p);
      if (result.status === 'joined') { haptic.success(); router.replace('/home'); return; }
      setWaiting(true);
    } catch (e) {
      const f = failureOf(e);
      if (f.code === 'ALREADY_MEMBER') { await requestSync(); router.replace('/home'); return; }
      if (f.code === 'MEMBER_ALREADY_CLAIMED' || f.code === 'INVITE_INVALID') { setPreview({ status: 'used' }); return; }
      if (f.code === 'INVITE_EXPIRED') { setPreview({ status: 'expired' }); return; }
      if (f.code === 'INVITE_TICKET_INVALID' && !retried) {
        // The check is only good for a few minutes: check again and carry on.
        const fresh = await lookUpInvite(link ?? code);
        setPreview(fresh);
        if (fresh.status === 'active') { await join(fresh, true); return; }
        return;
      }
      setError(explainFailure(f.code));
    } finally {
      setBusy(false);
    }
  };

  const autoChecked = useRef(false);
  useEffect(() => {
    if (link && !autoChecked.current) { autoChecked.current = true; void check(); }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [link]);

  const potName = active?.potName ?? 'the household';

  return (
    <Screen header={phone ? <ScreenHeader title="" /> : <Brand />}>
      <View style={{ flexDirection: 'row', alignSelf: 'flex-start', height: 56, borderRadius: 28, overflow: 'hidden', marginTop: phone ? 16 : 40 }}
        accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
        <View style={{ backgroundColor: citrus.band, justifyContent: 'center', paddingLeft: 22, paddingRight: 16 }}>
          <T maxFontSizeMultiplier={1.2} style={{ fontFamily: fonts.cond, fontSize: 28, color: citrus.ink }}>You’re</T>
        </View>
        <View style={{ backgroundColor: lilac.band, justifyContent: 'center', paddingLeft: 16, paddingRight: 22 }}>
          <T maxFontSizeMultiplier={1.2} style={{ fontFamily: fonts.cond, fontSize: 28, color: lilac.ink }}>invited</T>
        </View>
      </View>
      <T accessibilityRole="header" maxFontSizeMultiplier={1.4}
        style={{ fontFamily: fonts.display, fontSize: phone ? 34 : 40, lineHeight: phone ? 38 : 44, letterSpacing: -0.8, marginTop: 20 }}>
        {active ? `Join ${potName}` : 'Join a household on Numa Shared'}
      </T>
      <T style={{ fontSize: 16, lineHeight: 22, color: c.ink2, marginTop: 12 }}>
        {active
          ? 'The code is good. You’ll see the whole history, and everything you add shows up for everyone.'
          : 'Type the 6-character code from the person who invited you.'}
      </T>

      {!active ? (
        <View style={{ marginTop: 28 }}>
          <T nativeID="join-code" style={{ fontFamily: fonts.semibold, fontSize: 12.5, color: c.ink2, marginBottom: 8, marginHorizontal: 4 }}>Invite code</T>
          <Field value={showCode(code)} onChangeText={(v) => { setCode(cleanCode(v)); setLink(null); setPreview(null); setError(null); }}
            accessibilityLabel="Invite code, 6 characters" placeholder="K7Q 4MZ" autoCapitalize="characters" autoCorrect={false}
            autoComplete="off" maxLength={7} returnKeyType="go" onSubmitEditing={check} autoFocus={!link && (!isWeb || !phone)}
            style={{ minHeight: 76, borderRadius: 20 }}
            inputStyle={{ fontFamily: fonts.semibold, fontSize: 36, letterSpacing: 2, paddingVertical: 12, fontVariant: ['tabular-nums'] }} />
        </View>
      ) : null}

      {preview && preview.status !== 'active' ? (
        <View style={{ marginTop: 16 }} accessibilityLiveRegion="polite">
          <Banner kind="warn" icon={<Warn size={18} color={c.warnInk} />}>
            <BannerText kind="warn" rest={NOT_ACTIVE[preview.status] ?? NOT_ACTIVE.invalid} />
          </Banner>
        </View>
      ) : null}
      {error ? (
        <View style={{ marginTop: 16 }} accessibilityLiveRegion="polite">
          <Banner kind="warn" icon={<Warn size={18} color={c.warnInk} />}><BannerText kind="warn" rest={error} /></Banner>
        </View>
      ) : null}
      {waiting ? (
        <View style={{ marginTop: 16 }} accessibilityLiveRegion="polite">
          <Banner><BannerText strong="Asked to join." rest={` The owner of ${potName} needs to let you in. It opens here as soon as they do.`} /></Banner>
        </View>
      ) : null}
      {active && !signInOptions.any && !session ? (
        <View style={{ marginTop: 16 }}>
          <Banner icon={<CloudOff size={18} color={c.ink2} />}>
            <BannerText rest="Joining needs you to sign in, which this device can’t do yet. Open the invite in the Numa Shared app on your phone." />
          </Banner>
        </View>
      ) : null}

      <View style={{ gap: 12, marginTop: 20 }}>
        {!active ? (
          <CTA label={busy ? 'Checking…' : ready ? `Check ${showCode(code)}` : 'Check code'} disabled={!ready || busy} onPress={check}
            accessibilityLabel={ready ? `Check code ${code.split('').join(' ')}` : 'Check code. Type the 6-character code first'} />
        ) : session ? (
          <CTA label={busy ? 'Joining…' : `Join ${potName}`} disabled={busy || waiting} onPress={() => join(active)} />
        ) : signInOptions.any ? (
          <SignInButtons verb="to join" disabled={busy} onSignedIn={() => { void join(active); }} />
        ) : null}
        <CTA variant="second" label={hasHousehold ? 'Back to my household' : 'Start my own household'}
          onPress={() => (hasHousehold ? router.replace('/home') : router.replace('/setup/account'))} />
      </View>

      <Press onPress={() => (router.canGoBack() ? router.back() : router.replace('/'))} accessibilityRole="link" accessibilityLabel="Not now"
        style={{ minHeight: 44, alignSelf: 'center', justifyContent: 'center', marginTop: 8, paddingHorizontal: 8, display: phone ? 'none' : 'flex' }}>
        <T style={{ fontFamily: fonts.semibold, fontSize: 15, textDecorationLine: 'underline' }}>Not now</T>
      </Press>
      <T style={{ fontFamily: fonts.medium, fontSize: 12.5, lineHeight: 18, color: c.ink2, textAlign: 'center', marginTop: 16 }}>
        Each code is for one person and works once.
      </T>
    </Screen>
  );
}
