// "Connect to Numa Shared": the consent page an AI agent sends the person to (convex/agentOAuth.ts).
// The agent (Claude, ChatGPT, Cursor…) opened /oauth/authorize, which checked it and sent the browser
// here with a one-time request id. The signed-in person connects or declines; either way the browser
// goes back to the agent. Connecting covers all of the person's households, with nothing to choose.
import { useEffect, useState } from 'react';
import { Linking, View } from 'react-native';
import { useLocalSearchParams } from 'expo-router';
import { CloudOff, Warn } from '@/ui/icons';
import { Banner, BannerText, CTA, haptic, T } from '@/ui/primitives';
import { useTheme } from '@/ui/theme';
import { fonts, isWeb } from '@/ui/tokens';
import { Brand, Screen } from '@/features/onboarding/chrome';
import { explainFailure, SignInButtons, useSession, useSignInOptions } from '@/features/account/session';
import { failureOf } from '@/sync/engine';
import { agents, type AgentRequest } from '@/sync/runtime';

function consentFailure(code: string): string {
  if (code === 'AGENT_REQUEST_EXPIRED') return 'This request has expired. Start again from your agent.';
  if (code === 'TOO_MANY_AGENTS') return 'You already have 5 agents connected. Disconnect one in Settings, AI agents, then try again.';
  return explainFailure(code);
}

/** Sends the browser (or the phone) back to the agent. */
function returnTo(url: string) {
  if (isWeb) globalThis.location?.assign(url);
  else void Linking.openURL(url);
}

export default function Connect() {
  const { c, layout } = useTheme();
  const phone = layout === 'phone';
  const params = useLocalSearchParams<{ request?: string }>();
  const request = typeof params.request === 'string' ? params.request : '';
  const session = useSession();
  const signIn = useSignInOptions();
  const [info, setInfo] = useState<AgentRequest | null>(null);
  const [households, setHouseholds] = useState<Array<{ id: string; name: string | null }> | null>(null);
  const [busy, setBusy] = useState<'connect' | 'decline' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<'connected' | 'declined' | null>(null);

  useEffect(() => {
    if (!request) { setInfo({ status: 'expired' }); return; }
    agents.consent.describe(request).then(setInfo, (e) => setError(consentFailure(failureOf(e).code)));
  }, [request]);

  const accountId = session?.accountId ?? null;
  useEffect(() => {
    if (!accountId) { setHouseholds(null); return; }
    let live = true;
    const load = (tries: number) => agents.consent.households().then(
      (list) => { if (live) setHouseholds(list); },
      (e) => {
        // Right after sign-in the connection may still be starting.
        if (live && tries > 0) setTimeout(() => load(tries - 1), 600);
        else if (live) setError(consentFailure(failureOf(e).code));
      },
    );
    void load(5);
    return () => { live = false; };
  }, [accountId]);

  const pending = info?.status === 'pending' ? info : null;
  const agent = pending?.agent ?? 'This agent';

  const connect = async () => {
    setBusy('connect'); setError(null);
    try {
      const { redirectTo } = await agents.consent.approve(request);
      haptic.success();
      setDone('connected');
      returnTo(redirectTo);
    } catch (e) {
      haptic.warn();
      setError(consentFailure(failureOf(e).code));
    } finally { setBusy(null); }
  };
  const decline = async () => {
    setBusy('decline'); setError(null);
    try {
      const { redirectTo } = await agents.consent.deny(request);
      setDone('declined');
      if (redirectTo) returnTo(redirectTo);
    } catch (e) {
      setError(consentFailure(failureOf(e).code));
    } finally { setBusy(null); }
  };

  // What "all your households" means today, so the person sees what they are sharing.
  const names = (households ?? []).map((h) => h.name?.trim() || 'Unnamed household');
  const reads = households === null ? 'Loading…'
    : names.length === 0 ? 'No households yet'
    : names.length <= 3 ? names.join(', ')
    : `${names.slice(0, 2).join(', ')} and ${names.length - 2} more`;

  const title = done === 'connected' ? `${agent} is connected`
    : done === 'declined' ? 'Not connected'
    : info?.status === 'expired' ? 'This request has expired'
    : `Connect ${agent} to Numa Shared`;

  return (
    <Screen header={<Brand />}>
      <T accessibilityRole="header" maxFontSizeMultiplier={1.4}
        style={{ fontFamily: fonts.display, fontSize: phone ? 32 : 38, lineHeight: phone ? 36 : 42, letterSpacing: -0.8, marginTop: phone ? 20 : 36 }}>
        {title}
      </T>

      {done === 'connected' ? (
        <T style={{ fontSize: 16, lineHeight: 22, color: c.ink2, marginTop: 12 }}>
          Go back to {agent}. You can disconnect it any time in Settings, AI agents.
        </T>
      ) : done === 'declined' ? (
        <T style={{ fontSize: 16, lineHeight: 22, color: c.ink2, marginTop: 12 }}>{agent} can’t read anything. You can close this page.</T>
      ) : info?.status === 'expired' ? (
        <T style={{ fontSize: 16, lineHeight: 22, color: c.ink2, marginTop: 12 }}>
          Requests last 10 minutes and work once. Start again from your agent.
        </T>
      ) : pending ? (
        <>
          <T style={{ fontSize: 16, lineHeight: 22, color: c.ink2, marginTop: 12 }}>
            {pending.canWrite
              ? `${agent} will act as you in all your households: read who paid and who owes whom, add expenses and repayments, edit and void records, and manage the household. Its changes show as yours, via ${agent}. You can turn each off in Settings, AI agents. It can’t delete your account or a household, or remove anyone, and Numa Shared never moves money.`
              : `${agent} will be able to read who paid, who owes whom and the records in all your households. It can’t add, change or delete anything, and Numa Shared never moves money.`}
          </T>
          <View style={{ marginTop: 18, backgroundColor: c.card, borderRadius: 18, paddingHorizontal: 16, paddingVertical: 4 }}>
            {pending.verifiedHost ? (
              <Fact label="Agent" value={`${agent} · ${pending.verifiedHost}`} />
            ) : null}
            {session ? <Fact label="Can read" value={reads} /> : null}
            <Fact label="Returns to" value={pending.returnsTo} last />
          </View>
          {pending.returnsToThisComputer ? (
            <View style={{ marginTop: 14 }}>
              <Banner kind="warn" icon={<Warn size={18} color={c.warnInk} />}>
                <BannerText kind="warn" strong="An app on this computer asked." rest=" Connect only if you just started this from an agent you trust." />
              </Banner>
            </View>
          ) : null}
        </>
      ) : !error ? (
        <T style={{ fontSize: 16, color: c.ink2, marginTop: 12 }}>Loading…</T>
      ) : null}

      {error ? (
        <View style={{ marginTop: 16 }} accessibilityLiveRegion="polite">
          <Banner kind="warn" icon={<Warn size={18} color={c.warnInk} />}><BannerText kind="warn" rest={error} /></Banner>
        </View>
      ) : null}

      {pending && !done ? (
        <View style={{ gap: 12, marginTop: 24 }}>
          {session ? (
            <CTA label={busy === 'connect' ? 'Connecting…' : `Connect ${agent}`} disabled={!!busy || !households} onPress={() => { void connect(); }} />
          ) : signIn.any ? (
            <SignInButtons verb="to connect" disabled={!!busy} />
          ) : (
            <Banner icon={<CloudOff size={18} color={c.ink2} />}>
              <BannerText rest="Connecting an agent needs you to sign in, which this browser can’t do yet. Open the link in a browser where you use Numa Shared." />
            </Banner>
          )}
          <CTA variant="second" label={busy === 'decline' ? 'Declining…' : 'Don’t connect'} disabled={!!busy} onPress={() => { void decline(); }} />
        </View>
      ) : null}
    </Screen>
  );
}

function Fact({ label, value, last }: { label: string; value: string; last?: boolean }) {
  const { c } = useTheme();
  return (
    <View style={{ flexDirection: 'row', justifyContent: 'space-between', gap: 12, paddingVertical: 12, borderBottomWidth: last ? 0 : 1, borderBottomColor: c.hair }}>
      <T style={{ fontSize: 15, color: c.ink2 }}>{label}</T>
      <T selectable style={{ fontFamily: fonts.semibold, fontSize: 15, flexShrink: 1, textAlign: 'right' }}>{value}</T>
    </View>
  );
}
