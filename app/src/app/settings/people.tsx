// People and groups: each group as a color card with its color picker and members. Add someone (a
// new group of their own), and move people between groups while no money is recorded yet.
import { useState } from 'react';
import { View } from 'react-native';
import { Redirect } from 'expo-router';
import { GROUP_COLORS, MAX_GROUPS, type GroupColor, type ID } from '@/core/types';
import { addPerson, canRemovePerson, hasFinancialHistory, removePerson, setGroupColor, setGroups } from '@/store/store';
import { showToast } from '@/store/ui';
import { explainFailure } from '@/features/account/session';
import { failureOf } from '@/sync/engine';
import { online } from '@/sync/runtime';
import { groupLimitWords } from '@/sync/contract';
import { Close, Lock } from '@/ui/icons';
import { haptic, Pill, Press, T } from '@/ui/primitives';
import { useTheme } from '@/ui/theme';
import { alpha, fonts } from '@/ui/tokens';
import { nameOf, useHousehold } from '@/features/hooks';
import { Field } from '@/features/onboarding/chrome';
import { movePerson } from '@/features/onboarding/model';
import { SInfo, SettingsShell, usePillBg } from '@/features/settings/parts';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const dayMonth = (ts: number) => { const d = new Date(ts); return `${d.getDate()} ${MONTHS[d.getMonth()]}`; };

const COLOR_NAMES: Record<GroupColor, string> = { citrus: 'Citrus', lilac: 'Lilac', sky: 'Sky', mint: 'Mint', butter: 'Butter', rose: 'Rose' };

export default function PeopleScreen() {
  const { h } = useHousehold();
  const { c, tone } = useTheme();
  const [moving, setMoving] = useState(false);
  const [sel, setSel] = useState<ID | null>(null);
  const [adding, setAdding] = useState(false);
  const [newName, setNewName] = useState('');
  const [removing, setRemoving] = useState<ID | null>(null);
  const [busy, setBusy] = useState(false);
  const pillBg = usePillBg();
  if (!h) return <Redirect href="/welcome" />;
  const fixed = hasFinancialHistory(h);
  const full = h.groups.length >= MAX_GROUPS;
  const nm = (pid: ID) => h.people.find((p) => p.id === pid)?.name ?? 'Someone';

  const shared = !!h.sync && !h.sync.setup;
  const moveTo = async (index: number) => {
    if (!sel) return;
    const before = h.groups.map((g) => g.memberIds);
    const next = movePerson(before, sel, index);
    if (next === before) { showToast(`A group is up to ${groupLimitWords()} people who pay as one`); return; }
    if (shared) {
      try { await online.regroup(h, next); } catch (e) { showToast(explainFailure(failureOf(e).code)); return; }
    } else {
      try { setGroups(h.id, next.map((m) => ({ memberIds: m }))); } catch (e) { showToast((e as Error).message); return; }
    }
    haptic.tick();
    setSel(null);
  };

  // Only the household's owner can remove people once it is shared.
  const mayRemove = (pid: ID) => canRemovePerson(h, pid) && (!shared || h.sync!.role === 'owner');
  const remove = async (pid: ID) => {
    const name = nm(pid);
    setBusy(true);
    try {
      if (shared) await online.removePerson(h, pid);
      else removePerson(h.id, pid);
      haptic.success();
      showToast(`${name} removed`);
    } catch (e) {
      showToast(explainFailure(failureOf(e).code));
    } finally {
      setBusy(false);
      setRemoving(null);
    }
  };

  const add = async () => {
    const v = newName.trim();
    if (!v) return;
    if (shared) {
      if (h.sync!.role !== 'owner') { showToast('Only the person who set up the household can add people'); return; }
      try { await online.addPerson(h, v); } catch (e) { showToast(explainFailure(failureOf(e).code)); return; }
      showToast(`${v} added. Their invite code is on the Invite screen`);
      haptic.success();
    } else if (addPerson(h.id, v)) { showToast(`${v} added in a group of their own`); haptic.success(); }
    setNewName('');
    setAdding(false);
  };

  return (
    <SettingsShell title="People and groups" back="Settings" active="people">
      <View style={{ gap: 16, marginTop: 8 }}>
        {h.groups.map((g, gi) => {
          const t = tone(g);
          const target = moving && !!sel && !g.memberIds.includes(sel);
          return (
            <View key={g.id} accessibilityLabel={nameOf(h, g)} style={{ borderRadius: 22, padding: 16, paddingTop: 12, backgroundColor: t.band }}>
              {target ? (
                <Press noScale onPress={() => moveTo(gi)} accessibilityLabel={`Move ${nm(sel!)} to ${nameOf(h, g)}`}
                  style={{ position: 'absolute', left: 0, top: 0, right: 0, bottom: 0, borderRadius: 22 }} />
              ) : null}
              <View pointerEvents="box-none" style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 4, minHeight: 44 }}>
                <T pointerEvents="none" style={{ fontFamily: fonts.bold, fontSize: 20, lineHeight: 24, color: t.ink, flexShrink: 1 }}>{nameOf(h, g)}</T>
                <View accessibilityRole="radiogroup" accessibilityLabel={`Color for ${nameOf(h, g)}`} style={{ flexDirection: 'row', marginRight: -3 }}>
                  {GROUP_COLORS.map((col) => {
                    const on = g.color === col;
                    const owner = h.groups.find((x) => x.id !== g.id && x.color === col);
                    return (
                      <Press key={col} noScale disabled={!!owner} onPress={() => { setGroupColor(h.id, g.id, col); haptic.tick(); }}
                        accessibilityRole="radio" accessibilityState={{ checked: on, disabled: !!owner }}
                        accessibilityLabel={owner ? `${COLOR_NAMES[col]}, used by ${nameOf(h, owner)}` : COLOR_NAMES[col]}
                        style={{ width: 30, height: 44, alignItems: 'center', justifyContent: 'center', opacity: owner ? 0.38 : 1 }}>
                        <View style={{ width: on ? 26 : 22, height: on ? 26 : 22, borderRadius: 13, backgroundColor: tone(col).band,
                          borderWidth: on ? 2 : 1, borderColor: on ? t.ink : alpha(t.ink, 0.18) }}>
                          {on ? <View style={{ flex: 1, borderRadius: 11, borderWidth: 2, borderColor: '#FFFFFF' }} /> : null}
                        </View>
                      </Press>
                    );
                  })}
                </View>
              </View>
              {g.memberIds.map((pid) => {
                const p = h.people.find((x) => x.id === pid)!;
                const you = pid === h.youId;
                const on = sel === pid;
                const status = you ? 'On this device' : p.joined ? `Joined${p.joinedAt ? ` ${dayMonth(p.joinedAt)}` : ''}` : 'Not joined yet';
                const row = (
                  <>
                    <View style={{ width: 40, height: 40, borderRadius: 20, backgroundColor: on ? t.ink : alpha(t.ink, 0.09), alignItems: 'center', justifyContent: 'center' }}>
                      <T style={{ fontFamily: fonts.bold, fontSize: 15, color: on ? t.band : t.ink }}>{you ? 'Y' : p.name.slice(0, 1).toUpperCase()}</T>
                    </View>
                    <View style={{ flex: 1 }}>
                      <T style={{ fontFamily: fonts.semibold, fontSize: 16, color: t.ink }}>{p.name}{you ? ' (you)' : ''}</T>
                      <T style={{ fontFamily: fonts.semibold, fontSize: 12.5, color: t.ink, opacity: 0.72, marginTop: 1 }}>{on ? 'Now tap the group they should join' : status}</T>
                    </View>
                  </>
                );
                const style = { flexDirection: 'row' as const, alignItems: 'center' as const, gap: 12, minHeight: 64, borderTopWidth: 1, borderTopColor: alpha(t.ink, 0.1) };
                if (moving) {
                  return (
                    <Press key={pid} noScale onPress={() => setSel(on ? null : pid)} accessibilityState={{ selected: on }}
                      accessibilityLabel={on ? `${p.name}, selected` : `Move ${p.name}`} style={style}>{row}</Press>
                  );
                }
                if (removing === pid) {
                  return (
                    <View key={pid} style={[style, { flexWrap: 'wrap', paddingVertical: 10 }]} accessibilityLiveRegion="polite">
                      <T style={{ flex: 1, minWidth: 160, fontFamily: fonts.semibold, fontSize: 15, color: t.ink }}>Remove {p.name}?</T>
                      <Pill small label={busy ? 'Removing…' : 'Remove'} onPress={busy ? undefined : () => remove(pid)} accessibilityLabel={`Yes, remove ${p.name}`} />
                      <Pill small light label="Keep" onPress={() => setRemoving(null)} style={{ backgroundColor: alpha(t.ink, 0.09) }} accessibilityLabel={`Keep ${p.name}`} />
                    </View>
                  );
                }
                return (
                  <View key={pid} style={style}>
                    <View accessible accessibilityLabel={`${p.name}${you ? ', you' : ''}, ${status}`} style={{ flex: 1, flexDirection: 'row', alignItems: 'center', gap: 12 }}>{row}</View>
                    {mayRemove(pid) ? (
                      <Press onPress={() => setRemoving(pid)} accessibilityLabel={`Remove ${p.name}`}
                        style={{ width: 44, height: 44, borderRadius: 22, alignItems: 'center', justifyContent: 'center', backgroundColor: alpha(t.ink, 0.09) }}>
                        <Close size={18} color={t.ink} />
                      </Press>
                    ) : null}
                  </View>
                );
              })}
            </View>
          );
        })}
      </View>

      {adding ? (
        <View style={{ marginTop: 20, gap: 10 }}>
          <Field value={newName} onChangeText={setNewName} placeholder="Their name" autoFocus accessibilityLabel="New person’s name"
            onSubmitEditing={add} returnKeyType="done" maxLength={24} autoCapitalize="words" />
          <View style={{ flexDirection: 'row', gap: 8 }}>
            <Pill label="Add" onPress={add} style={{ flex: 1, alignSelf: 'auto' }} />
            <Pill light label="Cancel" onPress={() => { setAdding(false); setNewName(''); }} style={{ flex: 1, alignSelf: 'auto', backgroundColor: pillBg }} />
          </View>
        </View>
      ) : (
        <View style={{ flexDirection: 'row', gap: 8, marginTop: 20 }}>
          <Pill light label={moving ? 'Done moving' : 'Move someone'} style={{ flex: 1, alignSelf: 'auto', opacity: fixed ? 0.5 : 1, backgroundColor: pillBg }}
            accessibilityLabel={fixed ? 'Move someone. Not available once money is recorded' : moving ? 'Done moving' : 'Move someone'}
            onPress={() => { if (fixed) { showToast('Groups are fixed once money is recorded'); return; } setMoving(!moving); setSel(null); }} />
          <Pill light label="Add someone" style={{ flex: 1, alignSelf: 'auto', opacity: full ? 0.5 : 1, backgroundColor: pillBg }}
            accessibilityLabel={full ? `Add someone. Up to ${MAX_GROUPS} groups` : 'Add someone'}
            onPress={() => { if (full) { showToast(`Up to ${MAX_GROUPS} groups for now`); return; } setAdding(true); setMoving(false); }} />
        </View>
      )}

      <View style={{ marginTop: 16 }}>
        <SInfo icon={fixed ? <Lock size={18} color={c.ink2} /> : undefined}>
          {fixed
            ? 'Groups are fixed now that money is recorded, so every past balance stays explainable. Someone new gets a group of their own.'
            : moving
              ? 'Tap a person, then tap the group they should join. You can move people until the first expense is added.'
              : 'You can move people until the first expense is added. Someone new gets a group of their own. Added someone by mistake? Remove them with the cross while they haven’t joined.'}
        </SInfo>
      </View>
    </SettingsShell>
  );
}
