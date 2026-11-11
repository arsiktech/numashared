// Already owe each other money? An optional opening balance that becomes the first line in history.
// Reached during setup (?first=1) or later from Home's empty state; either way it ends on Home.
import { useEffect, useState } from 'react';
import { View } from 'react-native';
import { Redirect, useLocalSearchParams, useRouter } from 'expo-router';
import { applyKey, formatMoney, isPlural, parseInput, type Key } from '@/core';
import type { ID } from '@/core/types';
import { setOpeningBalance, yourGroup } from '@/store/store';
import { showToast } from '@/store/ui';
import { CTA, haptic, Press, T, TextButton } from '@/ui/primitives';
import { BigAmount, Keypad } from '@/ui/money-ui';
import { useTheme } from '@/ui/theme';
import { fonts, isWeb } from '@/ui/tokens';
import { nameOf, useHousehold } from '@/features/hooks';
import { Screen, ScreenHeader, Segmented } from '@/features/onboarding/chrome';

export default function Opening() {
  const { h, ledger } = useHousehold();
  const { c, tone } = useTheme();
  const router = useRouter();
  const { first } = useLocalSearchParams<{ first?: string }>();
  const [yes, setYes] = useState(false);
  const [from, setFrom] = useState<ID | null>(null);
  const [to, setTo] = useState<ID | null>(null);
  const [picking, setPicking] = useState<'from' | 'to' | null>(null);
  const [input, setInput] = useState('');
  const currency = h?.currency ?? 'EUR';

  // Desk and tablet web: type the amount on the keyboard as well.
  useEffect(() => {
    if (!isWeb || !yes) return;
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)) return;
      const k = e.key === 'Backspace' ? 'back' : e.key === ',' ? '.' : e.key;
      if (!/^[0-9.]$/.test(k) && k !== 'back') return;
      e.preventDefault();
      setInput((v) => applyKey(v, k as Key, currency));
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [yes, currency]);

  if (!h || !ledger) return <Redirect href="/welcome" />;
  const mine = yourGroup(h);
  const fromId = from ?? mine.id;
  const toId = to ?? h.groups.find((g) => g.id !== fromId)?.id ?? null;
  const fromG = h.groups.find((g) => g.id === fromId)!;
  const toG = toId ? h.groups.find((g) => g.id === toId)! : null;
  const cents = parseInput(input, currency) ?? 0;
  const hasOpening = ledger.records.some((r) => r.kind === 'opening' && !r.voided);
  const finish = () => {
    if (first === '1' || !router.canGoBack()) {
      if (router.canDismiss()) router.dismissAll();
      router.replace('/home');
    } else router.back();
  };

  const pick = (which: 'from' | 'to', id: ID) => {
    const other = which === 'from' ? toId : fromId;
    if (id === other) { setFrom(toId); setTo(fromId); } // picking the other side swaps them
    else if (which === 'from') setFrom(id);
    else setTo(id);
    setPicking(null);
    haptic.tick();
  };

  const save = async () => {
    if (!toG || cents <= 0) return;
    try {
      await setOpeningBalance(h, [{ fromGroupId: fromId, toGroupId: toG.id, amount: cents }]);
      haptic.success();
      finish();
    } catch (e) {
      showToast((e as Error).message || 'Couldn’t save the opening balance.');
    }
  };

  if (h.groups.length < 2 || hasOpening) {
    return (
      <Screen header={<ScreenHeader title="Already owe each other money?" />} footer={<CTA label="Go to Home" onPress={finish} />}>
        <View style={{ marginTop: 22, backgroundColor: c.chip, borderRadius: 16, padding: 14 }}>
          <T style={{ fontSize: 14.5, lineHeight: 20 }}>
            {hasOpening
              ? 'This household already has an opening balance. It’s the first line in history; void it there if it was wrong.'
              : 'An opening balance needs at least two groups. Add someone in Settings first.'}
          </T>
        </View>
      </Screen>
    );
  }

  const token = (which: 'from' | 'to', g: NonNullable<typeof toG>) => {
    const t = tone(g);
    const open = picking === which;
    return (
      <Press onPress={() => setPicking(open ? null : which)} accessibilityState={{ expanded: open }}
        accessibilityLabel={`${which === 'from' ? 'Group that owes' : 'Group that is owed'}: ${nameOf(h, g)}. Change`}
        style={{ minHeight: 44, paddingHorizontal: 12, borderRadius: 14, backgroundColor: t.band, justifyContent: 'center', alignSelf: 'flex-start',
          borderWidth: open ? 2 : 0, borderColor: t.ink }}>
        <T style={{ fontFamily: fonts.display, fontSize: 28, lineHeight: 36, letterSpacing: -0.6, color: t.ink }}>{nameOf(h, g)}</T>
      </Press>
    );
  };

  const picker = picking ? (
    <View accessibilityRole="radiogroup" accessibilityLabel={picking === 'from' ? 'Who owes' : 'Who is owed'}
      style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 12 }}>
      {h.groups.map((g) => {
        const t = tone(g);
        const on = (picking === 'from' ? fromId : toId) === g.id;
        return (
          <Press key={g.id} accessibilityRole="radio" accessibilityState={{ checked: on }} accessibilityLabel={nameOf(h, g)} onPress={() => pick(picking, g.id)}
            style={{ minHeight: 44, paddingHorizontal: 14, borderRadius: 22, backgroundColor: t.band, justifyContent: 'center', borderWidth: on ? 2 : 0, borderColor: t.ink }}>
            <T style={{ fontFamily: fonts.semibold, fontSize: 15, color: t.ink }}>{nameOf(h, g)}</T>
          </Press>
        );
      })}
    </View>
  ) : null;

  const footer = yes ? (
    <View style={{ gap: 4, alignItems: 'stretch' }}>
      <CTA label={cents > 0 ? `Start at ${formatMoney(cents, currency)}` : 'Type an amount'} disabled={cents <= 0} onPress={save} />
      <TextButton label="Skip, start at zero" bold onPress={finish} style={{ alignSelf: 'center' }} />
    </View>
  ) : <CTA label="Start at zero" onPress={finish} />;

  return (
    <Screen header={<ScreenHeader title="Already owe each other money?"
      onBack={first === '1' ? () => router.replace('/setup/groups?first=1') : undefined} />} footer={footer}>
      <View style={{ marginTop: 22 }}>
        <Segmented label="Opening balance" value={yes ? 'yes' : 'no'} onChange={(v) => setYes(v === 'yes')}
          options={[{ value: 'no', label: 'No, start at zero' }, { value: 'yes', label: 'Yes' }]} />
      </View>
      {yes && toG ? (
        <>
          <View style={{ marginTop: 22, backgroundColor: c.card, borderRadius: 22, paddingTop: 24, paddingHorizontal: 20, paddingBottom: 20 }}>
            <View style={{ flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: 8 }}>
              {token('from', fromG)}
              <T style={{ fontFamily: fonts.display, fontSize: 28, letterSpacing: -0.6 }}>{isPlural(fromG, h.people, h.youId) ? 'owe' : 'owes'}</T>
            </View>
            <View style={{ marginTop: 6 }}>{token('to', toG)}</View>
            {picker}
            <View style={{ marginTop: 14 }}>
              <BigAmount cents={cents} currency={currency} size={56} color={c.ink} typed={input || undefined} caret
                accessibilityLabel={`Amount ${formatMoney(cents, currency)}`} />
            </View>
          </View>
          <View style={{ marginTop: 8 }}>
            <Keypad color={c.ink} height={52} onKey={(k) => setInput((v) => applyKey(v, k as Key, currency))} />
          </View>
          <View style={{ marginTop: 8, backgroundColor: c.chip, borderRadius: 16, padding: 14 }}>
            <T style={{ fontSize: 14.5, lineHeight: 20 }}>This becomes the first line in history, so everyone starts from the same number.</T>
          </View>
        </>
      ) : (
        <View style={{ marginTop: 16, backgroundColor: c.chip, borderRadius: 16, padding: 14 }}>
          <T style={{ fontSize: 14.5, lineHeight: 20 }}>
            Everyone starts at zero. If you already owe each other, choose Yes and it becomes the first line in history.
          </T>
        </View>
      )}
    </Screen>
  );
}
