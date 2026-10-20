// Invite your household. Each invited person gets a code of their own: it works once, for them,
// and opens the household with their name already on it. A household that lives only on this
// phone is shared first (Continue with Apple on iPhone).
import { useEffect, useState } from 'react';
import { View } from 'react-native';
import { Redirect } from 'expo-router';
import type { Household, Person } from '@/core/types';
import { CloudOff, Copy, Share as ShareIcon } from '@/ui/icons';
import { Banner, BannerText, CTA, Dot, ListCard, Pill, T } from '@/ui/primitives';
import { useTheme } from '@/ui/theme';
import { fonts } from '@/ui/tokens';
import { useHousehold, initials } from '@/features/hooks';
import { Caption, Screen, ScreenHeader } from '@/features/onboarding/chrome';
import { showCode } from '@/features/onboarding/model';
import { InvitePattern } from '@/features/onboarding/pattern';
import { shareText } from '@/features/onboarding/share';
import { explainFailure, SignInButtons, useSession, useSignInOptions } from '@/features/account/session';
import { showToast } from '@/store/ui';
import { PUBLIC_SITE_URL } from '@/sync/config';
import { failureOf } from '@/sync/engine';
import { online, turnOnSync, useSyncStatus } from '@/sync/runtime';
import { groupLimitWords } from '@/sync/contract';

export default function Invite() {
  const { h } = useHousehold();
  if (!h) return <Redirect href="/welcome" />;
  return (
    <Screen header={<ScreenHeader title="Invite your household" back={h.name} />}>
      {!h.sync ? <ShareFirst h={h} /> : h.sync.role === 'owner' ? <Codes h={h} /> : <MemberView h={h} />}
    </Screen>
  );
}

function ShareFirst({ h }: { h: Household }) {
  const { c } = useTheme();
  const session = useSession();
  const signInOptions = useSignInOptions();
  const [busy, setBusy] = useState(false);
  const share = async () => {
    setBusy(true);
    try { await turnOnSync(h.id); } catch (e) {
      const code = failureOf(e).code;
      showToast((e as Error).message === 'group-too-large'
        ? `A group can be up to ${groupLimitWords()} people. Change the groups in People and groups first.`
        : explainFailure(code));
    } finally { setBusy(false); }
  };
  return (
    <View style={{ marginTop: 18, gap: 14 }}>
      <T style={{ fontSize: 16, lineHeight: 22 }}>
        {h.name} lives only on this phone right now. Share it, and everyone you invite sees the same history and balance on their own phone.
      </T>
      <People h={h} />
      {session ? (
        <CTA label={busy ? 'Sharing…' : `Share ${h.name}`} disabled={busy} onPress={share} />
      ) : signInOptions.any ? (
        <SignInButtons verb="to share" onSignedIn={() => { void share(); }} />
      ) : (
        <Banner icon={<CloudOff size={18} color={c.ink2} />}>
          <BannerText rest="Sharing needs you to sign in, which this device can’t do yet. Until then, add their expenses for them." />
        </Banner>
      )}
      <Caption style={{ fontFamily: fonts.medium, lineHeight: 18 }}>You become the owner. Nothing already recorded changes.</Caption>
    </View>
  );
}

function Codes({ h }: { h: Household }) {
  const { c } = useTheme();
  const status = useSyncStatus();
  const pending = h.people.filter((p) => p.id !== h.youId && !p.joined && !p.archived);
  const missing = pending.some((p) => !h.sync!.invites?.[p.id]?.issued);
  useEffect(() => {
    if (!h.sync!.setup && missing) online.invites(h).catch(() => {});
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [h.id, missing, h.sync?.setup]);
  const single = pending.length === 1 ? h.sync!.invites?.[pending[0].id] : undefined;
  return (
    <View>
      {h.sync!.setup ? (
        <View style={{ marginTop: 18 }}>
          <Banner icon={<CloudOff size={18} color={c.ink2} />}>
            <BannerText rest={status.connected ? 'Setting up the shared household…' : 'Codes appear as soon as this phone is online.'} />
          </Banner>
        </View>
      ) : null}
      {single?.issued ? (
        <View style={{ marginTop: 22, backgroundColor: c.card, borderRadius: 22, paddingTop: 26, paddingHorizontal: 22, paddingBottom: 24, alignItems: 'center' }}>
          <InvitePattern code={single.code} label={`Invite picture for ${pending[0].name}. The code is ${single.code.split('').join(' ')}`} />
          <T style={{ fontFamily: fonts.semibold, fontSize: 12.5, color: c.ink2, marginTop: 14 }}>{pending[0].name}’s code</T>
        </View>
      ) : null}
      {pending.length ? (
        <>
          <T accessibilityRole="header" style={{ fontFamily: fonts.semibold, fontSize: 13, color: c.ink2, paddingTop: 24, paddingBottom: 8, paddingHorizontal: 4 }}>
            A code for each person
          </T>
          <View style={{ gap: 12 }}>
            {pending.map((p) => <CodeCard key={p.id} h={h} p={p} />)}
          </View>
        </>
      ) : null}
      <T accessibilityRole="header" style={{ fontFamily: fonts.semibold, fontSize: 13, color: c.ink2, paddingTop: 28, paddingBottom: 8, paddingHorizontal: 4 }}>Who’s in</T>
      <People h={h} />
      <Caption style={{ marginTop: 12, fontFamily: fonts.medium, lineHeight: 18 }}>
        Each code works once, for that person, for about a month. They type it in Numa Shared, or tap the link you send.
      </Caption>
    </View>
  );
}

function CodeCard({ h, p }: { h: Household; p: Person }) {
  const { c } = useTheme();
  const invite = h.sync!.invites?.[p.id];
  const ready = invite?.issued;
  const code = ready ? showCode(invite.code) : '';
  const link = ready ? `${PUBLIC_SITE_URL}/join/${invite.token}?code=${invite.code}` : '';
  return (
    <View style={{ backgroundColor: c.card, borderRadius: 20, padding: 18, gap: 12 }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
        <View style={{ width: 36, height: 36, borderRadius: 18, backgroundColor: c.chip, alignItems: 'center', justifyContent: 'center' }}>
          <T style={{ fontFamily: fonts.bold, fontSize: 14 }}>{initials(h, p.id)}</T>
        </View>
        <T style={{ flex: 1, fontFamily: fonts.semibold, fontSize: 17 }}>{p.name}</T>
        {ready ? (
          <T selectable accessibilityLabel={`${p.name}’s code ${invite.code.split('').join(' ')}`}
            style={{ fontFamily: fonts.semibold, fontSize: 24, letterSpacing: 3, fontVariant: ['tabular-nums'] }}>{code}</T>
        ) : <T style={{ fontSize: 14, color: c.ink2 }}>Making a code…</T>}
      </View>
      {ready ? (
        <View style={{ flexDirection: 'row', gap: 10 }}>
          <Pill label={`Send to ${p.name}`} style={{ flex: 1, height: 44, borderRadius: 22, alignSelf: 'auto' }} icon={<ShareIcon size={17} color={c.bg} />}
            accessibilityLabel={`Send ${p.name} their invite`}
            onPress={() => shareText(`${p.name}, join ${h.name} on Numa Shared: ${link}\nOr type the code ${code} in the app.`, 'Invite copied', `Join ${h.name}`)} />
          <Pill light label="Copy code" style={{ flex: 1, height: 44, borderRadius: 22, alignSelf: 'auto' }} icon={<Copy size={17} color={c.ink} />}
            accessibilityLabel={`Copy ${p.name}’s code`} onPress={() => shareText(invite.code, 'Code copied')} />
        </View>
      ) : null}
    </View>
  );
}

function MemberView({ h }: { h: Household }) {
  return (
    <View style={{ marginTop: 18, gap: 14 }}>
      <T style={{ fontSize: 16, lineHeight: 22 }}>
        Invite codes come from the person who set up {h.name}. Ask them to send a code to whoever still needs one.
      </T>
      <People h={h} />
    </View>
  );
}

function People({ h }: { h: Household }) {
  const { c } = useTheme();
  const others = h.people.filter((p) => p.id !== h.youId && !p.archived);
  return (
    <ListCard>
      {others.length ? others.map((p, i) => (
        <View key={p.id} style={{ flexDirection: 'row', alignItems: 'center', gap: 12, minHeight: 52, paddingVertical: 10, paddingHorizontal: 16,
          borderBottomWidth: i === others.length - 1 ? 0 : 1, borderBottomColor: c.hair }}>
          <View style={{ width: 32, height: 32, borderRadius: 16, backgroundColor: c.chip, alignItems: 'center', justifyContent: 'center' }}>
            <T style={{ fontFamily: fonts.bold, fontSize: 13 }}>{initials(h, p.id)}</T>
          </View>
          <T style={{ flex: 1, fontSize: 16 }}>{p.name}</T>
          {p.joined ? (
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
              <Dot color={c.good} />
              <T style={{ fontFamily: fonts.semibold, fontSize: 14, color: c.good }}>Joined</T>
            </View>
          ) : <T style={{ fontSize: 15, color: c.ink2 }}>{h.sync ? 'Invited' : 'Not shared yet'}</T>}
        </View>
      )) : (
        <T style={{ padding: 16, fontSize: 15, color: c.ink2 }}>Just you so far. Add people in Settings, People and groups.</T>
      )}
    </ListCard>
  );
}
