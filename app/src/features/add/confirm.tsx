// The short paper sheets that confirm a destructive-looking change (Void, Flag): a question,
// what it is about, reason chips, a plain explanation, a red button and a way out.
import { useState, type ReactNode } from 'react';
import { TextInput, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { Household, LedgerRecord } from '@/core/types';
import { Warn } from '@/ui/icons';
import { Banner, BannerText, Chip, CTA, haptic, T, TextButton } from '@/ui/primitives';
import { useSheet } from '@/ui/sheet';
import { useTheme } from '@/ui/theme';
import { fonts, isWeb } from '@/ui/tokens';
import { clock, money, personName, recordTitle, relativeDay } from '../hooks';
import { settlementTitle } from '../records';

/** "€6.50 · You paid · Today 12:10". */
export function recordSummary(h: Household, r: LedgerRecord) {
  const when = `${relativeDay(r.createdAt)} ${clock(r.createdAt)}`;
  if (r.kind === 'expense') return `${money(h, r.expense!.amount)} · ${personName(h, r.expense!.payerId)} paid · ${when}`;
  if (r.kind === 'settlement') return `${money(h, r.settlement!.amount)} · ${settlementTitle(h, r)} · ${when}`;
  return `${money(h, r.opening!.entries.reduce((a, e) => a + e.amount, 0))} · ${when}`;
}

export const quotedTitle = (r: LedgerRecord) => `“${recordTitle(r)}”`;

export function ConfirmBody({ title, sub, reasons, explain, action, onConfirm, needsReason, otherPlaceholder }: {
  title: string; sub: string; reasons: string[]; explain: ReactNode; action: string;
  /** Returns an error message to show, or nothing when it worked. */
  onConfirm: (reason: string | undefined) => string | void;
  needsReason: boolean; otherPlaceholder: string;
}) {
  const { c } = useTheme();
  const insets = useSafeAreaInsets();
  const { close } = useSheet();
  const [reason, setReason] = useState<string | null>(null);
  const [other, setOther] = useState('');
  const [error, setError] = useState<string | null>(null);
  const finalReason = reason === 'Other' ? other.trim() || undefined : reason ?? undefined;
  const ready = !needsReason || !!finalReason;

  const confirm = () => {
    if (!ready) { haptic.warn(); return; }
    const err = onConfirm(finalReason);
    if (err) { haptic.warn(); setError(err); return; }
    haptic.medium();
    close();
  };

  return (
    <View>
      <View style={{ paddingHorizontal: 22, paddingTop: 10 }}>
        <T accessibilityRole="header" style={{ fontFamily: fonts.bold, fontSize: 20, letterSpacing: -0.2 }}>{title}</T>
        <T style={{ fontSize: 14, color: c.ink2, marginTop: 4 }}>{sub}</T>
        <T style={{ fontFamily: fonts.semibold, fontSize: 13, color: c.ink2, paddingTop: 20, paddingBottom: 8 }}>Why?{needsReason ? '' : ' optional'}</T>
        <View accessibilityRole="radiogroup" accessibilityLabel="Why" style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
          {reasons.map((r) => (
            <Chip key={r} label={r} on={reason === r} onPress={() => { haptic.tick(); setError(null); setReason(reason === r ? null : r); }} />
          ))}
        </View>
        {reason === 'Other' ? (
          <View style={{ marginTop: 12, minHeight: 48, borderRadius: 14, paddingHorizontal: 14, justifyContent: 'center', backgroundColor: c.card, borderWidth: 1, borderColor: c.hair }}>
            <TextInput value={other} onChangeText={setOther} autoFocus placeholder={otherPlaceholder} placeholderTextColor={c.ink3} maxLength={120}
              accessibilityLabel="Reason" returnKeyType="done" onSubmitEditing={confirm}
              style={[{ minHeight: 46, fontFamily: fonts.regular, fontSize: 16, color: c.ink, paddingVertical: 0 }, isWeb ? ({ outlineStyle: 'none' } as object) : null]} />
          </View>
        ) : null}
        <View style={{ marginTop: 18 }}>
          {error
            ? <Banner kind="bad" icon={<Warn size={20} color={c.bad} />}><BannerText kind="bad" strong="That didn’t work." rest={error} /></Banner>
            : <Banner kind="info"><T style={{ fontSize: 14.5, lineHeight: 20 }}>{explain}</T></Banner>}
        </View>
      </View>
      <View style={{ paddingTop: 18, paddingHorizontal: 22, paddingBottom: Math.max(insets.bottom, 12) + 4, alignItems: 'stretch', gap: 4 }}>
        <CTA variant="danger" label={action} disabled={!ready} onPress={confirm}
          accessibilityLabel={ready ? action : `${action}. Pick a reason first`} />
        <TextButton label="Keep it" onPress={() => close()} style={{ alignSelf: 'center', justifyContent: 'center' }} />
      </View>
    </View>
  );
}
