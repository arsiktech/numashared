// Settings: household, you, data and account. A shared household lives on the server and on every
// member's phone; one made without signing in stays on this device until it is shared.
import { useState } from 'react';
import { Linking, TextInput, View } from 'react-native';
import { Redirect, useLocalSearchParams, useRouter } from 'expo-router';
import Constants from 'expo-constants';
import { currencyLocked, getState, hasFinancialHistory, leaveHousehold, renameHousehold, setCurrency, setPrefs, useStore, type Appearance } from '@/store/store';
import { openSheet } from '@/store/ui';
import { Bell, Check, Download, Eye, House, Lock, Moon, Pencil, People, Share as ShareIcon, VoidX } from '@/ui/icons';
import { Press, T, Toggle } from '@/ui/primitives';
import { useTheme } from '@/ui/theme';
import { fonts, isAndroid, isWeb } from '@/ui/tokens';
import { useHousehold } from '@/features/hooks';
import { CURRENCIES, currencyLabel } from '@/features/onboarding/model';
import { SGroup, SNote, SRow, SettingsShell, useDesk, type DeskSection } from '@/features/settings/parts';
import { explainFailure, SignInButtons, useSession, useSignInOptions } from '@/features/account/session';
import { showToast } from '@/store/ui';
import { failureOf } from '@/sync/engine';
import { online, registerPush, signOutEverywhere, turnOnSync } from '@/sync/runtime';
import { groupLimitWords } from '@/sync/contract';
import { PUBLIC_SITE_URL } from '@/sync/config';
import { Apple, CloudOff } from '@/ui/icons';
import { Kbd } from '@/features/web/kbd';

const version = Constants.expoConfig?.version ?? '1.0.0';

export default function Settings() {
  const { h } = useHousehold();
  const { c } = useTheme();
  const desk = useDesk();
  const params = useLocalSearchParams<{ section?: string }>();
  const [section, setSection] = useState<DeskSection>((params.section as DeskSection) || 'household');
  if (!h) return <Redirect href="/welcome" />;
  const shown = (s: DeskSection) => !desk || section === s || (s === 'household' && !['you', 'account'].includes(section));
  const active: DeskSection = desk ? (['you', 'account'].includes(section) ? section : 'household') : 'household';
  const title = !desk ? 'Settings' : active === 'you' ? 'You' : active === 'account' ? 'Account' : 'Household';
  return (
    <SettingsShell title={title} back={h.name} active={active}
      onSection={(s) => { if (s === 'household' || s === 'you' || s === 'account') { setSection(s); return true; } return false; }}>
      {shown('household') ? <HouseholdGroup /> : null}
      {desk && active === 'household' ? <><Shortcuts /><SGroup title="Danger zone"><LeaveRow last /></SGroup></> : null}
      {shown('you') ? <YouGroup /> : null}
      {!desk ? <DataGroup /> : null}
      {shown('account') ? <AccountGroup /> : null}
      {!desk || active === 'account' ? (
        <T style={{ fontFamily: fonts.semibold, fontSize: 12.5, color: c.ink2, textAlign: 'center', paddingTop: 24, paddingBottom: 16 }}>
          Numa Shared {version} · {h.sync ? 'Shared' : 'Saved on this device'}
        </T>
      ) : null}
    </SettingsShell>
  );
}

function HouseholdGroup() {
  const { h } = useHousehold();
  const { c } = useTheme();
  const router = useRouter();
  const desk = useDesk();
  const [pickCurrency, setPickCurrency] = useState(false);
  if (!h) return null;
  const locked = currencyLocked(h);
  const groups = h.groups.length;
  const people = `${h.people.length} ${h.people.length === 1 ? 'person' : 'people'} · ${groups} ${groups === 1 ? 'group' : 'groups'}`;
  return (
    <SGroup title={desk ? undefined : 'Household'} first>
      <NameRow />
      <SRow first={false} label="Currency" icon={<Lock size={22} color={c.ink2} />}
        value={isAndroid && !desk ? currencyLabel(h.currency) : `${currencyLabel(h.currency)}`}
        sub={locked ? (isAndroid && !desk ? 'fixed' : h.sync && !hasFinancialHistory(h) ? 'Fixed once shared' : 'Fixed after the first expense') : 'Fixed once the first expense is added or the household is shared'}
        right={!isAndroid || desk ? (locked ? <Lock size={16} color={c.ink2} /> : null) : undefined}
        onPress={locked ? undefined : () => setPickCurrency(!pickCurrency)}
        a11y={`Currency, ${currencyLabel(h.currency)}${locked ? (hasFinancialHistory(h) ? ', fixed because money is recorded' : ', fixed because the household is shared') : '. Change'}`} />
      {pickCurrency && !locked ? CURRENCIES.map((cur) => (
        <SRow key={cur.code} label={cur.name} value={cur.code} chevron={false}
          right={cur.code === h.currency ? <Check size={18} color={c.ink} /> : null}
          onPress={() => { setCurrency(h.id, cur.code); setPickCurrency(false); }}
          a11y={`${cur.name}${cur.code === h.currency ? ', selected' : ''}`} />
      )) : null}
      <SRow label="People and groups" sub={people} icon={<People size={22} color={c.ink2} />} onPress={() => router.push('/settings/people')} />
      <SRow label="Invite people" icon={<ShareIcon size={22} color={c.ink2} />} onPress={() => router.push('/setup/invite')} last />
    </SGroup>
  );
}

function NameRow() {
  const { h } = useHousehold();
  const { c } = useTheme();
  const desk = useDesk();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  if (!h) return null;
  const commit = () => {
    const v = draft.trim();
    setEditing(false);
    if (!v || v === h.name) return;
    if (h.sync && !h.sync.setup) {
      online.rename(h, v).catch((e) => showToast(explainFailure(failureOf(e).code)));
    } else renameHousehold(h.id, v);
  };
  if (desk || editing) {
    return (
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12, minHeight: 56, paddingVertical: 8, paddingHorizontal: 16, borderBottomWidth: 1, borderBottomColor: c.hair, flexWrap: 'wrap' }}>
        {desk ? <View style={{ width: 22, alignItems: 'center' }}><House size={20} color={c.ink2} /></View> : null}
        <T style={{ fontSize: desk ? 14 : 16, fontFamily: desk ? fonts.semibold : fonts.regular, color: desk ? c.ink2 : c.ink, width: desk ? 98 : undefined }}>Name</T>
        <TextInput defaultValue={h.name} autoFocus={editing} onChangeText={setDraft} onFocus={() => setDraft(h.name)} onBlur={commit} onSubmitEditing={commit}
          accessibilityLabel="Household name" returnKeyType="done" maxLength={40} selectionColor={c.ink}
          style={[{ flex: 1, minWidth: 160, maxWidth: 320, height: 44, borderRadius: 12, backgroundColor: c.bg, borderWidth: 1, borderColor: c.hair, paddingHorizontal: 14,
            fontFamily: fonts.regular, fontSize: 16, color: c.ink }, isWeb ? ({ outlineColor: c.ink } as object) : null]} />
      </View>
    );
  }
  return (
    <SRow first label="Name" value={isAndroid ? undefined : h.name} sub={isAndroid ? h.name : undefined} icon={<Pencil size={22} color={c.ink2} />}
      onPress={() => { setDraft(h.name); setEditing(true); }} a11y={`Name, ${h.name}. Rename`} />
  );
}

function YouGroup() {
  const { c } = useTheme();
  const desk = useDesk();
  const prefs = useStore((s) => s.prefs);
  const [open, setOpen] = useState(false);
  const names: Record<Appearance, string> = { system: isAndroid ? 'System default' : 'System', light: 'Light', dark: 'Dark' };
  return (
    <SGroup title={desk ? undefined : 'You'}>
      <SRow first label="Hide amounts" sub="Hide numbers on Home and History" icon={<Eye size={22} color={c.ink2} />} a11y="Hide amounts"
        right={<Toggle label="Hide amounts" value={prefs.hideAmounts} android={isAndroid} onChange={(v) => setPrefs({ hideAmounts: v })} />} />
      <SRow label="Appearance" value={isAndroid && !desk ? undefined : names[prefs.appearance]} sub={isAndroid && !desk ? names[prefs.appearance] : undefined}
        icon={<Moon size={22} color={c.ink2} />} onPress={() => setOpen(!open)} a11y={`Appearance, ${names[prefs.appearance]}. ${open ? 'Close' : 'Change'}`} />
      {open ? (
        <View accessibilityRole="radiogroup" accessibilityLabel="Appearance" style={{ borderBottomWidth: 1, borderBottomColor: c.hair, paddingVertical: 4 }}>
          {(['system', 'light', 'dark'] as Appearance[]).map((a) => {
            const on = prefs.appearance === a;
            return (
              <Press key={a} noScale accessibilityRole="radio" accessibilityState={{ checked: on }} accessibilityLabel={names[a]}
                onPress={() => setPrefs({ appearance: a })}
                style={{ minHeight: 44, flexDirection: 'row', alignItems: 'center', paddingLeft: isAndroid && !desk ? 56 : 32, paddingRight: 16, gap: 10 }}>
                <T style={{ flex: 1, fontSize: 16, fontFamily: on ? fonts.semibold : fonts.regular }}>{names[a]}</T>
                {on ? <Check size={18} color={c.ink} /> : null}
              </Press>
            );
          })}
        </View>
      ) : null}
      <NotificationsRow />
    </SGroup>
  );
}

function NotificationsRow() {
  const { c } = useTheme();
  const prefs = useStore((s) => s.prefs);
  const session = useSession();
  const canPush = !!session && !isAndroid && !isWeb;
  const sub = canPush ? 'When someone adds, edits or repays' : session ? 'On iPhone for now' : 'After you sign in';
  return (
    <SRow label="Notifications" sub={sub} icon={<Bell size={22} color={c.ink2} />} a11y={`Notifications, ${sub}`} last
      right={<Toggle label="Notifications" value={prefs.notifications && canPush} android={isAndroid}
        onChange={async (v) => {
          if (!canPush) { showToast(sub); return; }
          setPrefs({ notifications: v });
          if (v) {
            try {
              const ok = await registerPush();
              if (!ok) { setPrefs({ notifications: false }); showToast('Allow notifications for Numa Shared in iPhone Settings'); }
            } catch (e) { showToast(explainFailure(failureOf(e).code)); }
          }
        }} />} />
  );
}

function DataGroup() {
  const { c } = useTheme();
  const router = useRouter();
  const { h } = useHousehold();
  return (
    <SGroup title="Data">
      <SRow first label="Export CSV" icon={<Download size={22} color={c.ink2} />} onPress={() => router.push('/settings/export')} />
      <SRow label="Import a Google Sheet" sub="Creates a new household from it" icon={<View />} onPress={() => router.push('/import')} />
      {h?.sync && !h.sync.setup ? (
        <SRow label="Card sync" sub="Add spends on chosen cards by themselves" icon={<View />} onPress={() => router.push('/settings/card-sync')} />
      ) : null}
      <SNote>History is permanent. Edits and voids stay visible to everyone.</SNote>
    </SGroup>
  );
}

function AccountGroup() {
  const { c } = useTheme();
  const router = useRouter();
  const desk = useDesk();
  const { h } = useHousehold();
  const session = useSession();
  const signInOptions = useSignInOptions();
  const [busy, setBusy] = useState(false);
  if (!h) return null;
  const share = async () => {
    setBusy(true);
    try { await turnOnSync(h.id); showToast(`${h.name} is shared. Invite people from Invite people.`); }
    catch (e) { showToast((e as Error).message === 'group-too-large' ? `A group can be up to ${groupLimitWords()} people. Change the groups first.` : explainFailure(failureOf(e).code)); }
    finally { setBusy(false); }
  };
  return (
    <SGroup title={desk ? undefined : 'Account'}>
      {session ? (
        <SRow first label="Signed in" sub={h.sync ? `${h.name} is shared` : `${h.name} is only on this device`} icon={<Apple size={22} color={c.ink2} />} chevron={false} />
      ) : (
        <SRow first label="Not signed in" sub={signInOptions.any ? 'Sign in to share a household with others on any device' : 'Signing in isn’t available on this device yet'} icon={<CloudOff size={22} color={c.ink2} />} chevron={false} />
      )}
      {session && !h.sync ? (
        <SRow label={busy ? 'Sharing…' : `Share ${h.name}`} sub="Move it to your account so others can join" icon={<ShareIcon size={22} color={c.ink2} />}
          onPress={busy ? undefined : share} />
      ) : null}
      {!session && signInOptions.any ? (
        <View style={{ paddingHorizontal: 16, paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: c.hair }}>
          <SignInButtons />
        </View>
      ) : null}
      {session ? (
        <SRow label="Sign out" icon={<View />} chevron={false} onPress={() => openSheet({ type: 'signout' })} />
      ) : null}
      {session ? (
        <SRow label="Delete account" sub="Deletes your account and its shared households here" icon={<View />}
          onPress={() => router.push('/settings/delete-account')} />
      ) : null}
      <SRow label="Privacy" icon={<View />} onPress={() => openLink(`${PUBLIC_SITE_URL}/privacy`)} />
      <SRow label="Help and support" icon={<View />} onPress={() => openLink(`${PUBLIC_SITE_URL}/support`)} last={desk} />
      {!desk ? <LeaveRow last /> : null}
    </SGroup>
  );
}

function openLink(url: string) {
  if (isWeb) { window.open(url, '_blank', 'noopener'); return; }
  Linking.openURL(url).catch(() => showToast('Couldn’t open the page'));
}

function LeaveRow({ last }: { last?: boolean }) {
  const { h } = useHousehold();
  const { c } = useTheme();
  const router = useRouter();
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  if (!h) return null;
  const shared = !!h.sync && !h.sync.setup;
  // A shared household nobody else has joined can be deleted outright (made by mistake);
  // once someone has joined, you can only leave it, because its history is theirs too.
  const alone = !h.people.some((p) => p.id !== h.youId && p.joined);
  const mode: 'delete-local' | 'delete-shared' | 'leave' = !shared ? 'delete-local' : alone && h.sync!.role === 'owner' ? 'delete-shared' : 'leave';
  const label = mode === 'leave' ? `Leave ${h.name}` : `Delete ${h.name}`;
  const sub = mode === 'leave' ? 'Your history stays for the others' : mode === 'delete-shared' ? 'Nobody else has joined yet' : 'Removes it from this device';
  const question = mode === 'leave'
    ? `Leave ${h.name}? Everything you added stays in its history for the others, and your balance stays visible to them. You can’t add anything after leaving.`
    : mode === 'delete-shared'
      ? `Delete ${h.name} for good? Nobody else has joined, so nobody loses anything. Invite codes you sent stop working.`
      : `Delete ${h.name}? It isn’t shared, so this phone has the only copy and its history is gone for good.`;
  const go = async () => {
    setBusy(true);
    try {
      if (mode === 'leave') await online.leave(h);
      else if (mode === 'delete-shared') await online.deleteHousehold(h);
      else leaveHousehold(h.id);
    } catch (e) {
      const code = failureOf(e).code;
      showToast(code === 'SOLE_ACTIVE_MEMBER' ? 'You’re the only one here. Invite someone first, or keep it.'
        : code === 'HOUSEHOLD_HAS_MEMBERS' ? 'Someone has joined since, so you can leave it but not delete it.'
          : explainFailure(code));
      setBusy(false);
      return;
    }
    router.replace(getState().households.length ? '/home' : '/welcome');
  };
  return (
    <View>
      <SRow label={label} danger chevron={false} icon={<VoidX size={22} color={c.bad} />} last={last && !confirm}
        sub={confirm ? undefined : sub} onPress={() => setConfirm(!confirm)} a11y={label} />
      {confirm ? (
        <View accessibilityLiveRegion="polite" style={{ paddingHorizontal: 16, paddingBottom: 16, gap: 12 }}>
          <T style={{ fontSize: 14.5, lineHeight: 20, color: c.ink }}>{question}</T>
          <View style={{ flexDirection: 'row', gap: 10, flexWrap: 'wrap' }}>
            <Press onPress={busy ? undefined : go} accessibilityLabel={`Yes, ${label.toLowerCase()}`}
              style={{ minHeight: 44, paddingHorizontal: 18, borderRadius: 22, backgroundColor: c.bad, justifyContent: 'center', opacity: busy ? 0.6 : 1 }}>
              <T style={{ fontFamily: fonts.semibold, fontSize: 16, color: '#FFFFFF' }}>{busy ? 'One moment…' : mode === 'leave' ? 'Leave' : 'Delete'}</T>
            </Press>
            <Press onPress={() => setConfirm(false)} accessibilityLabel="Cancel"
              style={{ minHeight: 44, paddingHorizontal: 18, borderRadius: 22, backgroundColor: c.chip, justifyContent: 'center' }}>
              <T style={{ fontFamily: fonts.semibold, fontSize: 16 }}>Cancel</T>
            </Press>
          </View>
        </View>
      ) : null}
    </View>
  );
}

function Shortcuts() {
  const keys: [string, string][] = [['New expense', 'N'], ['Search history', '/'], ['Record a repayment', 'R'], ['Close', 'Esc']];
  return (
    <SGroup title="Shortcuts">
      {keys.map(([label, k], i) => (
        <SRow key={k} label={label} first={i === 0} last={i === keys.length - 1} right={<Kbd k={k} />} a11y={`${label}: ${k === '/' ? 'slash' : k}`} />
      ))}
    </SGroup>
  );
}
