// Card sync: spends on chosen payment cards are added to this household by themselves, as
// "<owner> paid, for <group>". The owner picks the cards (last four digits) and whose they are,
// then gets a key once, to give to the sync script that reads the card provider's history.
import { useCallback, useEffect, useRef, useState } from 'react';
import { View } from 'react-native';
import { Redirect } from 'expo-router';
import type { ID } from '@/core/types';
import { Warn } from '@/ui/icons';
import { Banner, BannerText, CTA, haptic, Press, T } from '@/ui/primitives';
import { useTheme } from '@/ui/theme';
import { fonts } from '@/ui/tokens';
import { Caption, Field, Label, Select } from '@/features/onboarding/chrome';
import { shareText } from '@/features/onboarding/share';
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
  const shared = !!h?.sync && !h.sync.setup;
  const hRef = useRef(h);
  hRef.current = h;

  const refresh = useCallback(async () => {
    const cur = hRef.current;
    if (!cur || !shared) return;
    try { setStatus(await cardSync.status(cur)); } catch (e) { setError(explainFailure(failureOf(e).code)); }
  }, [h?.id, shared]);
  useEffect(() => { void refresh(); }, [refresh]);
  useEffect(() => {
    const cur = hRef.current;
    if (!cur) return;
    const otherGroups = cur.groups.filter((g) => !g.memberIds.includes(cur.youId));
    setRows(otherGroups.length ? [{ key: 1, last4: '', forUnitId: otherGroups[0].id, label: nameOf(cur, otherGroups[0]) }] : []);
  }, [h?.id]);

  if (!h) return <Redirect href="/welcome" />;
  if (!h.sync || h.sync.setup) {
    return (
      <SettingsShell title="Card sync" back="Settings" active="household">
        <T style={{ fontSize: 16, lineHeight: 22, color: c.ink2, marginTop: 12 }}>Share {h.name} first. Card sync adds spends for everyone in a shared household.</T>
      </SettingsShell>
    );
  }

  const valid = others.length > 0 && rows.length > 0 && rows.every((r) => /^\d{4}$/.test(r.last4) && r.label.trim() && r.forUnitId)
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

  const actorGroup = h.groups.find((g) => g.memberIds.includes(status?.actorMemberId ?? h.youId)) ?? h.groups[0];
  const lastSyncDay = (ts: number) => {
    const d = relativeDay(ts);
    return d === 'Today' || d === 'Yesterday' ? d.toLowerCase() : d;
  };

  const footer = !owner ? null : key ? (
    <CTA label="Share the key" onPress={() => { void shareText(`NUMA_SHARED_URL=${CARD_SYNC_URL}\nNUMA_SHARED_KEY=${key}`, 'Sync key copied'); }} />
  ) : status ? (
    <CTA variant="second" label={busy ? 'Working…' : 'Make a new key'} disabled={busy}
      onPress={() => { void link(status.cards); }} />
  ) : others.length > 0 ? (
    <CTA label={busy ? 'Linking…' : 'Link these cards'} disabled={!valid || busy}
      onPress={() => { void link(rows.map(({ last4, forUnitId, label }) => ({ last4, forUnitId, label: label.trim() }))); }} />
  ) : null;

  return (
    <SettingsShell title="Card sync" back="Settings" active="household" footer={footer}>
      <T style={{ fontSize: 16, lineHeight: 22, color: c.ink2, marginTop: 8, paddingHorizontal: 4 }}>
        Spends on the cards below are added as “{actorGroup ? nameOf(h, actorGroup) : 'You'} paid”, entirely for whoever uses the card. Spends on any other card are ignored and never stored.
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
            {status.lastUsedAt ? `Last sync ${lastSyncDay(status.lastUsedAt)}. ` : 'The sync script hasn’t sent anything yet. '}
            {`${Number(status.added)} ${Number(status.added) === 1 ? 'spend' : 'spends'} added so far.`}
          </Caption>
          {owner ? (
            <Press onPress={busy ? undefined : () => { void unlink(); }} accessibilityRole="button"
              style={{ minHeight: 44, justifyContent: 'center', alignSelf: 'flex-start', paddingHorizontal: 4 }}>
              <T style={{ fontFamily: fonts.semibold, fontSize: 15, color: c.bad, textDecorationLine: 'underline' }}>Turn off card sync</T>
            </Press>
          ) : null}
        </View>
      ) : status === null && owner && others.length === 0 ? (
        <T style={{ fontSize: 15, color: c.ink2, marginTop: 16 }}>Add another group in People and groups first, so spends have someone to go to.</T>
      ) : status === null && owner ? (
        <View style={{ marginTop: 18, gap: 4 }}>
          {rows.map((r, i) => (
            <View key={r.key} style={{ gap: 4 }}>
              <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: i ? 16 : 0 }}>
                <Label>{`Card ${i + 1}: last four digits`}</Label>
                {rows.length > 1 ? (
                  <Press onPress={() => setRows((all) => all.filter((x) => x.key !== r.key))} accessibilityLabel={`Remove card ${i + 1}`}
                    style={{ minHeight: 44, justifyContent: 'center', paddingHorizontal: 4 }}>
                    <T style={{ fontFamily: fonts.semibold, fontSize: 14, color: c.bad }}>Remove</T>
                  </Press>
                ) : null}
              </View>
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
