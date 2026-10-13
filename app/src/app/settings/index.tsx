// Settings: household, you, data and account. Everything is stored on this device; the rows that
// depend on sync (sign-in, notifications) say so instead of pretending.
import { useState } from 'react';
import { TextInput, View } from 'react-native';
import { Redirect, useLocalSearchParams, useRouter } from 'expo-router';
import Constants from 'expo-constants';
import { getState, hasFinancialHistory, leaveHousehold, renameHousehold, setCurrency, setPrefs, useStore, type Appearance } from '@/store/store';
import { openSheet } from '@/store/ui';
import { Bell, Check, Download, Eye, House, Lock, Moon, Pencil, People, Share as ShareIcon, VoidX } from '@/ui/icons';
import { Press, T, Toggle } from '@/ui/primitives';
import { useTheme } from '@/ui/theme';
import { fonts, isAndroid, isWeb } from '@/ui/tokens';
import { useHousehold } from '@/features/hooks';
import { CURRENCIES, currencyLabel } from '@/features/onboarding/model';
import { SGroup, SNote, SRow, SettingsShell, useDesk, type DeskSection } from '@/features/settings/parts';
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
          Numa Shared {version} · Saved on this device
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
  const locked = hasFinancialHistory(h);
  const groups = h.groups.length;
  const people = `${h.people.length} ${h.people.length === 1 ? 'person' : 'people'} · ${groups} ${groups === 1 ? 'group' : 'groups'}`;
  return (
    <SGroup title={desk ? undefined : 'Household'} first>
      <NameRow />
      <SRow first={false} label="Currency" icon={<Lock size={22} color={c.ink2} />}
        value={isAndroid && !desk ? currencyLabel(h.currency) : `${currencyLabel(h.currency)}`}
        sub={locked ? (isAndroid && !desk ? 'fixed' : 'Fixed after the first expense') : 'Fixed once the first expense is added'}
        right={!isAndroid || desk ? (locked ? <Lock size={16} color={c.ink2} /> : null) : undefined}
        onPress={locked ? undefined : () => setPickCurrency(!pickCurrency)}
        a11y={`Currency, ${currencyLabel(h.currency)}${locked ? ', fixed because money is recorded' : '. Change'}`} />
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
    if (v && v !== h.name) renameHousehold(h.id, v);
    setEditing(false);
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
      <SRow label="Notifications" sub="Arrive with sync" icon={<Bell size={22} color={c.ink2} />} a11y="Notifications, arrive with sync" last
        right={<Toggle label="Notifications" value={prefs.notifications} android={isAndroid} onChange={(v) => setPrefs({ notifications: v })} />} />
    </SGroup>
  );
}

function DataGroup() {
  const { c } = useTheme();
  const router = useRouter();
  return (
    <SGroup title="Data">
      <SRow first label="Export CSV" icon={<Download size={22} color={c.ink2} />} onPress={() => router.push('/settings/export')} />
      <SNote>History is permanent. Edits and voids stay visible to everyone.</SNote>
    </SGroup>
  );
}

function AccountGroup() {
  const { c } = useTheme();
  const desk = useDesk();
  return (
    <SGroup title={desk ? undefined : 'Account'}>
      <SRow first label="On this device" sub="Sign-in arrives with sync" icon={<Lock size={22} color={c.ink2} />} />
      <SRow label="Sign out" icon={<View />} chevron={false} onPress={() => openSheet({ type: 'signout' })} last={desk} />
      {!desk ? <LeaveRow last /> : null}
    </SGroup>
  );
}

function LeaveRow({ last }: { last?: boolean }) {
  const { h } = useHousehold();
  const { c } = useTheme();
  const router = useRouter();
  const [confirm, setConfirm] = useState(false);
  if (!h) return null;
  const leave = () => {
    leaveHousehold(h.id);
    router.replace(getState().households.length ? '/home' : '/welcome');
  };
  return (
    <View>
      <SRow label={`Leave ${h.name}`} danger chevron={false} icon={<VoidX size={22} color={c.bad} />} last={last && !confirm}
        sub={confirm ? undefined : 'Removes it from this device'} onPress={() => setConfirm(!confirm)}
        a11y={`Leave ${h.name}`} />
      {confirm ? (
        <View accessibilityLiveRegion="polite" style={{ paddingHorizontal: 16, paddingBottom: 16, gap: 12 }}>
          <T style={{ fontSize: 14.5, lineHeight: 20, color: c.ink }}>
            Leave {h.name}? Without sync, this device has the only copy, so its history is deleted here for good.
          </T>
          <View style={{ flexDirection: 'row', gap: 10, flexWrap: 'wrap' }}>
            <Press onPress={leave} accessibilityLabel={`Yes, leave ${h.name}`}
              style={{ minHeight: 44, paddingHorizontal: 18, borderRadius: 22, backgroundColor: c.bad, justifyContent: 'center' }}>
              <T style={{ fontFamily: fonts.semibold, fontSize: 16, color: '#FFFFFF' }}>Leave and delete</T>
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
