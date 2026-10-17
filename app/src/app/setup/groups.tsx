// Who shares money? People who pay as one share a group and a balance. Tap a person, then tap the
// group they should join (the tap version of dragging them). Groups are fixed once money is recorded.
import { useState } from 'react';
import { View } from 'react-native';
import { Redirect, useLocalSearchParams, useRouter } from 'expo-router';
import { groupName } from '@/core';
import { GROUP_COLORS, MAX_GROUPS, type ID } from '@/core/types';
import { hasFinancialHistory, setGroups } from '@/store/store';
import { showToast } from '@/store/ui';
import { Lock, Plus } from '@/ui/icons';
import { Banner, BannerText, CTA, haptic, Press, T } from '@/ui/primitives';
import { useTheme } from '@/ui/theme';
import { alpha, fonts } from '@/ui/tokens';
import { useHousehold } from '@/features/hooks';
import { Screen, ScreenHeader } from '@/features/onboarding/chrome';
import { MAX_GROUP_SIZE, movePerson, type Arrangement } from '@/features/onboarding/model';
import { explainFailure } from '@/features/account/session';
import { currentSession } from '@/sync/auth';
import { failureOf } from '@/sync/engine';
import { online, turnOnSync } from '@/sync/runtime';

export default function Groups() {
  const { h } = useHousehold();
  const { c, tone } = useTheme();
  const router = useRouter();
  const { first } = useLocalSearchParams<{ first?: string }>();
  const [arr, setArr] = useState<Arrangement>(() => (h ? h.groups.map((g) => g.memberIds) : []));
  const [sel, setSel] = useState<ID | null>(null);
  const [pendingNew, setPendingNew] = useState(false);
  const [saving, setSaving] = useState(false);
  if (!h) return <Redirect href="/welcome" />;
  const fixed = hasFinancialHistory(h);
  const nm = (pid: ID) => (pid === h.youId ? 'You' : h.people.find((p) => p.id === pid)?.name ?? 'Someone');
  const title = (members: ID[]) => groupName({ id: 'x', color: 'citrus', memberIds: members }, h.people, h.youId);

  const move = (pid: ID, target: number | 'new') => {
    if (target === 'new') {
      const from = arr.find((g) => g.includes(pid));
      if (from && from.length === 1) { showToast(`${nm(pid)} already ${pid === h.youId ? 'have' : 'has'} a group of their own`); return; }
    } else if (arr[target].length >= MAX_GROUP_SIZE && !arr[target].includes(pid)) {
      showToast('A group is up to six people who pay as one');
      return;
    }
    setArr(movePerson(arr, pid, target));
    setSel(null);
    setPendingNew(false);
    haptic.tick();
  };

  const tapPerson = (pid: ID) => {
    if (fixed) return;
    if (pendingNew) { move(pid, 'new'); return; }
    setSel(sel === pid ? null : pid);
    haptic.tap();
  };

  const done = async () => {
    if (!fixed) {
      if (h.sync && !h.sync.setup) {
        // Already shared: regrouping is a server change, so it needs a connection.
        const changed = JSON.stringify(arr) !== JSON.stringify(h.groups.map((g) => g.memberIds));
        if (changed) {
          setSaving(true);
          try { await online.regroup(h, arr); } catch (e) { setSaving(false); showToast(explainFailure(failureOf(e).code)); return; }
          setSaving(false);
        }
      } else {
        try { setGroups(h.id, arr.map((m) => ({ memberIds: m }))); } catch (e) { showToast((e as Error).message); return; }
        // A new household made while signed in goes to the server once its groups are set.
        if (first === '1' && currentSession() && !h.sync) {
          turnOnSync(h.id).catch(() => showToast('Saved on this phone. It will be shared when you’re back online.'));
        }
      }
    }
    if (first === '1' && arr.length >= 2) router.replace('/setup/opening?first=1');
    else if (first === '1') router.replace('/home');
    else if (router.canGoBack()) router.back();
    else router.replace('/home');
  };

  const hint = fixed ? null
    : pendingNew ? 'Now tap the person who should start the new group.'
      : sel ? `Now tap the group ${nm(sel)} should join.`
        : 'Tap a person, then tap another group to move them.';

  return (
    <Screen header={<ScreenHeader title="Who shares money?" />} footer={<CTA label={saving ? 'Saving…' : fixed ? 'Done' : 'Looks right'} disabled={saving} onPress={done} />}>
      <T style={{ fontSize: 15, lineHeight: 21, color: c.ink2, marginTop: 12 }}>
        People who pay as one, like a couple, share a balance. Each group settles with the others.
      </T>
      {hint ? <T accessibilityLiveRegion="polite" style={{ fontSize: 14, fontFamily: fonts.semibold, color: c.ink, marginTop: 12 }}>{hint}</T> : null}

      <View style={{ gap: 12, marginTop: 18 }}>
        {arr.map((members, i) => {
          const t = tone(GROUP_COLORS[i % GROUP_COLORS.length]);
          const target = !!sel && !members.includes(sel);
          const card = { borderRadius: 22, padding: 16, backgroundColor: t.band };
          const body = (
            <>
              {target ? (
                <Press noScale onPress={() => move(sel!, i)} accessibilityLabel={`Move ${nm(sel!)} to ${title(members)}`}
                  style={{ position: 'absolute', left: 0, top: 0, right: 0, bottom: 0, borderRadius: 22 }} />
              ) : null}
              <T pointerEvents="none" style={{ fontFamily: fonts.bold, fontSize: 20, lineHeight: 24, color: t.ink, alignSelf: 'flex-start' }}>{title(members)}</T>
              <View pointerEvents="box-none" style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 12 }}>
                {members.map((pid) => {
                  const on = sel === pid;
                  return (
                    <Press key={pid} disabled={fixed} onPress={() => tapPerson(pid)} accessibilityState={{ selected: on, disabled: fixed }}
                      accessibilityLabel={fixed ? nm(pid) : on ? `${nm(pid)}, selected. Tap again to keep them here` : `${nm(pid)}. Tap to move to another group`}
                      style={{ minHeight: 44, paddingLeft: 8, paddingRight: 16, borderRadius: 22, flexDirection: 'row', alignItems: 'center', gap: 8,
                        backgroundColor: on ? t.ink : alpha(t.ink, 0.09) }}>
                      <View style={{ width: 28, height: 28, borderRadius: 14, backgroundColor: on ? t.band : t.ink, alignItems: 'center', justifyContent: 'center' }}>
                        <T style={{ fontFamily: fonts.bold, fontSize: 12, color: on ? t.ink : t.band }}>{nm(pid).slice(0, 1).toUpperCase()}</T>
                      </View>
                      <T style={{ fontFamily: fonts.semibold, fontSize: 16, color: on ? t.band : t.ink }}>{nm(pid)}</T>
                    </Press>
                  );
                })}
              </View>
              {target ? (
                <View pointerEvents="none" style={{ marginTop: 12, minHeight: 40, borderRadius: 14, borderWidth: 1.5, borderStyle: 'dashed', borderColor: alpha(t.ink, 0.45),
                  alignItems: 'center', justifyContent: 'center', paddingHorizontal: 12 }}>
                  <T style={{ fontFamily: fonts.semibold, fontSize: 14, color: t.ink, textAlign: 'center' }}>Tap here to move {nm(sel!)} into this group</T>
                </View>
              ) : null}
            </>
          );
          return <View key={i} style={card}>{body}</View>;
        })}

        {!fixed ? (
          <Press onPress={() => {
            if (arr.length >= MAX_GROUPS) return;
            if (sel) move(sel, 'new');
            else { setPendingNew(!pendingNew); haptic.tap(); }
          }} disabled={arr.length >= MAX_GROUPS} accessibilityState={{ disabled: arr.length >= MAX_GROUPS, selected: pendingNew }}
            accessibilityLabel={arr.length >= MAX_GROUPS ? `New group. Up to ${MAX_GROUPS} groups` : sel ? `Put ${nm(sel)} in a new group` : 'New group'}
            style={{ minHeight: 56, borderRadius: 22, borderWidth: 1.5, borderStyle: 'dashed', borderColor: pendingNew ? c.ink : c.ink3,
              backgroundColor: pendingNew ? c.chip : 'transparent', flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, paddingHorizontal: 16 }}>
            <Plus size={18} color={arr.length >= MAX_GROUPS ? c.ink3 : c.ink2} />
            <T style={{ fontFamily: fonts.semibold, fontSize: 16, color: arr.length >= MAX_GROUPS ? c.ink3 : c.ink2 }}>
              {arr.length >= MAX_GROUPS ? `Up to ${MAX_GROUPS} groups` : sel ? `New group for ${nm(sel)}` : pendingNew ? 'Cancel new group' : 'New group'}
            </T>
          </Press>
        ) : null}
      </View>

      <View style={{ marginTop: 16 }}>
        <Banner icon={fixed ? <Lock size={18} color={c.ink2} /> : undefined}>
          <BannerText rest={fixed
            ? 'Groups are fixed now that money is recorded, so every past balance stays explainable.'
            : 'You can change this until the first expense is added.'} />
        </Banner>
      </View>
    </Screen>
  );
}
