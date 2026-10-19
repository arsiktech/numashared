// Card sync: spends on chosen payment cards are added to this household by themselves, as
// "<owner> paid, for <group>". The owner picks the cards (last four digits) and whose they are,
// then gets a key once, to give to the sync script that reads the card provider's history.
import { useCallback, useEffect, useState } from 'react';
import { Share, View } from 'react-native';
import { Redirect } from 'expo-router';
import type { ID } from '@/core/types';
import { Warn } from '@/ui/icons';
import { Banner, BannerText, CTA, haptic, Press, T } from '@/ui/primitives';
import { useTheme } from '@/ui/theme';
import { fonts } from '@/ui/tokens';
import { Caption, Field, Label, Select } from '@/features/onboarding/chrome';
import { SettingsShell } from '@/features/settings/parts';
import { nameOf, relativeDay, useHousehold } from '@/features/hooks';
import { explainFailure } from '@/features/account/session';
import { failureOf } from '@/sync/engine';
import { CARD_SYNC_URL, cardSync, type CardSyncCard, type CardSyncStatus } from '@/sync/runtime';

type Row = { key: number; last4: string; forUnitId: ID; label: string };

export default function CardSyncScreen() {
  const { c } = useTheme();
  const { h } = useHousehold();
  const [status, setStatus] = useState<CardSyncStatus | undefined>(undefined);
  const [rows, setRows] = useState<Row[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [key, setKey] = useState<string | null>(null);

  const others = h ? h.groups.filter((g) => !g.memberIds.includes(h.youId)) : [];
  const owner = h?.sync?.role === 'owner';

  const refresh = useCallback(async () => {
    if (!h?.sync || h.sync.setup) return;
    try { setStatus(await cardSync.status(h)); } catch (e) { setError(explainFailure(failureOf(e).code)); }
  }, [h]);
  useEffect(() => { void refresh(); }, [refresh]);
  useEffect(() => {
    if (!h || rows.length || !others.length) return;
    setRows([{ key: 1, last4: '', forUnitId: others[0].id, label: nameOf(h, others[0]) }]);
  }, [h, others, rows.length]);

  if (!h) return <Redirect href="/welcome" />;
  if (!h.sync || h.sync.setup) {
    return (
      <SettingsShell title="Card sync" back="Settings" active="household">
        <T style={{ fontSize: 16, lineHeight: 22, color: c.ink2, marginTop: 12 }}>Share {h.name} first. Card sync adds spends for everyone in a shared household.</T>
      </SettingsShell>
    );
  }

  const valid = rows.length > 0 && rows.every((r) => /^\d{4}$/.test(r.last4) && r.label.trim())
    && new Set(rows.map((r) => r.last4)).size === rows.length;

  const link = async (cards: CardSyncCard[]) => {
    setBusy(true); setError(null);
    try {
      setKey(await cardSync.link(h, cards));
      haptic.success();
      await refresh();
    } catch (e) { haptic.warn(); setError(explainFailure(failureOf(e).code)); }
    finally { setBusy(false); }
  };
  const unlink = async () => {
    setBusy(true); setError(null);
    try { await cardSync.unlink(h); setKey(null); await refresh(); } catch (e) { setError(explainFailure(failureOf(e).code)); }
    finally { setBusy(false); }
  };

  const footer = !owner ? null : key ? (
    <CTA label="Share the key" onPress={() => { void Share.share({ message: `NUMA_SHARED_URL=${CARD_SYNC_URL}\nNUMA_SHARED_KEY=${key}` }); }} />
  ) : status ? (
    <CTA variant="second" label={busy ? 'Working…' : 'Make a new key'} disabled={busy}
      onPress={() => { void link(status.cards); }} />
  ) : (
    <CTA label={busy ? 'Linking…' : 'Link these cards'} disabled={!valid || busy}
      onPress={() => { void link(rows.map(({ last4, forUnitId, label }) => ({ last4, forUnitId, label: label.trim() }))); }} />
  );

  return (
    <SettingsShell title="Card sync" back="Settings" active="household" footer={footer}>
      <T style={{ fontSize: 16, lineHeight: 22, color: c.ink2, marginTop: 8, paddingHorizontal: 4 }}>
        Spends on the cards below are added as “{nameOf(h, h.groups.find((g) => g.memberIds.includes(status?.actorMemberId ?? h.youId))!)} paid”, entirely for whoever uses the card. Spends on any other card are ignored and never stored.
      </T>

      {error ? (
        <View style={{ marginTop: 16 }} accessibilityLiveRegion="polite">
          <Banner kind="warn" icon={<Warn size={18} color={c.warnInk} />}><BannerText kind="warn" rest={error} /></Banner>
        </View>
      ) : null}

      {key ? (
        <View style={{ marginTop: 18, backgroundColor: c.card, borderRadius: 18, padding: 16, gap: 10 }} accessibilityLiveRegion="polite">
          <T style={{ fontFamily: fonts.semibold, fontSize: 16 }}>Your sync key</T>
          <T selectable style={{ fontFamily: fonts.semibold, fontSize: 14, letterSpacing: 0.2 }}>{key}</T>
          <T style={{ fontSize: 14, lineHeight: 20, color: c.ink2 }}>
            Give it to the sync script on your computer. It’s shown only now; if you lose it, make a new one. It can only add card spends to {h.name}.
          </T>
        </View>
      ) : null}

      {status ? (
        <View style={{ marginTop: 18, gap: 10 }}>
          <Label>Linked cards</Label>
          <View style={{ backgroundColor: c.card, borderRadius: 18, overflow: 'hidden' }}>
            {status.cards.map((card, i) => (
              <View key={card.last4} style={{ flexDirection: 'row', justifyContent: 'space-between', gap: 12, padding: 16, borderTopWidth: i ? 1 : 0, borderTopColor: c.hair }}>
                <T style={{ fontSize: 16 }}>•{card.last4} {card.label}</T>
                <T style={{ fontSize: 15, color: c.ink2 }}>for {nameOf(h, card.forUnitId)}</T>
              </View>
            ))}
          </View>
          <Caption>
            {status.lastUsedAt ? `Last sync ${relativeDay(status.lastUsedAt).toLowerCase()}. ` : 'The sync script hasn’t sent anything yet. '}
            {`${Number(status.added)} ${Number(status.added) === 1 ? 'spend' : 'spends'} added so far.`}
          </Caption>
          {owner ? (
            <Press onPress={busy ? undefined : () => { void unlink(); }} accessibilityRole="button"
              style={{ minHeight: 44, justifyContent: 'center', alignSelf: 'flex-start', paddingHorizontal: 4 }}>
              <T style={{ fontFamily: fonts.semibold, fontSize: 15, color: c.bad, textDecorationLine: 'underline' }}>Turn off card sync</T>
            </Press>
          ) : null}
        </View>
      ) : status === null && owner ? (
        <View style={{ marginTop: 18, gap: 4 }}>
          {rows.map((r, i) => (
            <View key={r.key} style={{ gap: 4 }}>
              <Label style={{ marginTop: i ? 16 : 0 }}>{`Card ${i + 1}: last four digits`}</Label>
              <Field value={r.last4} onChangeText={(v) => setRows((all) => all.map((x) => (x.key === r.key ? { ...x, last4: v.replace(/\D/g, '').slice(0, 4) } : x)))}
                keyboardType="number-pad" maxLength={4} placeholder="1234" accessibilityLabel={`Card ${i + 1}, last four digits`} />
              <Label>Whose card</Label>
              <Field value={r.label} onChangeText={(v) => setRows((all) => all.map((x) => (x.key === r.key ? { ...x, label: v } : x)))}
                maxLength={40} placeholder="Name" accessibilityLabel={`Card ${i + 1}, whose card`} />
              <Label>Spends are for</Label>
              <Select label={`Card ${i + 1}, spends are for`} value={r.forUnitId}
                onChange={(v) => setRows((all) => all.map((x) => (x.key === r.key ? { ...x, forUnitId: v } : x)))}
                options={others.map((g) => ({ value: g.id, label: nameOf(h, g) }))} />
            </View>
          ))}
          {rows.length < 10 ? (
            <Press onPress={() => setRows((all) => [...all, { key: Date.now(), last4: '', forUnitId: others[0]?.id ?? '', label: '' }])}
              accessibilityRole="button" style={{ minHeight: 44, justifyContent: 'center', alignSelf: 'flex-start', marginTop: 10 }}>
              <T style={{ fontFamily: fonts.semibold, fontSize: 15, textDecorationLine: 'underline' }}>Add another card</T>
            </Press>
          ) : null}
        </View>
      ) : status === null ? (
        <T style={{ fontSize: 15, color: c.ink2, marginTop: 16 }}>Card sync is off. The household’s owner can turn it on.</T>
      ) : null}
    </SettingsShell>
  );
}
