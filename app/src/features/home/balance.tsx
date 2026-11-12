// Home bands ("Sticker"): one full-bleed colour band per group, yours first. People are chips above
// each group's name. The balance is a tilted ticket stuck on the seam under your band, and the orb
// sits on the same seam as the one add button. Built only from the Home system in ui/scale.ts.
import { useState, type ReactNode } from 'react';
import { View } from 'react-native';
import { useRouter } from 'expo-router';
import { planSettlement } from '@/core';
import type { Group, Household, ID } from '@/core/types';
import { yourGroup } from '@/store/store';
import { openSheet } from '@/store/ui';
import { ArrowDown, ArrowUp, Check } from '@/ui/icons';
import { Press, T } from '@/ui/primitives';
import { useTheme } from '@/ui/theme';
import { corner, space, text } from '@/ui/scale';
import { alpha } from '@/ui/tokens';
import { TEXT_CAP } from '@/ui/textScale';
import { OrbButton } from '../records';
import { money, nameOf, standingWords } from '../hooks';

type Transfer = { fromGroupId: ID; toGroupId: ID; amount: number };

export const ORB = 80;
/** How far the ticket hangs below the seam, and the room the bands leave for it. */
const TICKET_DROP = 56;
/** The ticket's solid ink layer shows this far below its face. */
const DEPTH = space[2] + 2;
const yourRoom = space[7] + space[5];
const theirRoom = TICKET_DROP + DEPTH + space[5];
const ARROW = 30;

/**
 * `repay`: show the repayment buttons (the desk leaves them out; its top bar has Repay).
 * `top`: the status bar inset. `header`: a row drawn at the top of your band (the phone's household switcher).
 * `onSeam`: reports where the seam is, so a screen can tell when the orb has scrolled away.
 */
export function Bands({ h, balances, hide, repay, top = 0, header, onSeam }: {
  h: Household; balances: Record<ID, number>; hide: boolean; repay: boolean; top?: number; header?: ReactNode; onSeam?: (y: number) => void;
}) {
  const [seam, setSeam] = useState(0);
  const [width, setWidth] = useState(0);
  const mine = yourGroup(h);
  const others = h.groups.filter((g) => g.id !== mine.id);
  const plan = planSettlement(balances);
  const transfers = plan.status === 'exact' ? plan.transfers : [];
  return (
    <View onLayout={(e) => setWidth(e.nativeEvent.layout.width)}>
      <View style={{ zIndex: 1 }} onLayout={(e) => { setSeam(e.nativeEvent.layout.height); onSeam?.(e.nativeEvent.layout.height); }}>
        <YourBand h={h} mine={mine} others={others} balances={balances} hide={hide} top={top} header={header} width={width} />
      </View>
      {others.map((g, i) => (
        <GroupBand key={g.id} h={h} g={g} mine={mine} two={others.length === 1} first={i === 0} last={i === others.length - 1}
          balances={balances} transfers={transfers} hide={hide} repay={repay} />
      ))}
      {seam ? <OrbButton size={ORB} plus={28} style={{ position: 'absolute', zIndex: 2, right: space[5], top: seam - ORB / 2 }} /> : null}
    </View>
  );
}

function YourBand({ h, mine, others, balances, hide, top, header, width }: {
  h: Household; mine: Group; others: Group[]; balances: Record<ID, number>; hide: boolean; top: number; header?: ReactNode; width: number;
}) {
  const { ui } = useTheme();
  const router = useRouter();
  const bal = balances[mine.id] ?? 0;
  const square = h.events.length === 0 || Object.values(balances).every((v) => v === 0);
  const counter = others.length === 1 ? nameOf(h, others[0]) : null;
  const label = square ? 'Nobody owes anything'
    : bal < 0 ? `You owe${counter ? ` ${counter}` : ''}`
    : counter ? `${counter} owe${others[0].memberIds.length > 1 ? '' : 's'} you` : 'You get back';
  const amount = square ? 'All square' : money(h, Math.abs(bal), hide);
  return (
    <View style={{ backgroundColor: ui.group(mine), paddingTop: top + (header ? 0 : space[5]), paddingHorizontal: space[5], paddingBottom: others.length ? yourRoom : space[6] }}>
      {header}
      <Chips h={h} g={mine} />
      <T accessibilityRole="header" style={[text.name, { color: ui.onFill, marginTop: space[2] }]}>{nameOf(h, mine)}</T>
      {others.length ? (
        // Room for the ticket: the band minus both gutters, the orb and a gap beside it.
        <Ticket label={label} amount={amount} icon={square ? 'square' : bal < 0 ? 'owe' : 'owed'}
          room={width - space[5] * 2 - space[3] - ORB} a11y={square ? 'All square. See the balance' : `${label} ${amount}. See why`} />
      ) : (
        <View style={{ gap: space[3], alignItems: 'flex-start', marginTop: space[3] }}>
          <T style={[text.body, { color: ui.onFill }]}>Add the people you share costs with. Each group gets its own colour.</T>
          <InkButton label="Add people" onPress={() => router.push('/settings/people')} />
        </View>
      )}
    </View>
  );
}

/** The balance as a sticker: canvas face, ink outline, a solid ink layer below it, tilted. */
function Ticket({ label, amount, icon, room, a11y }: { label: string; amount: string; icon: 'owe' | 'owed' | 'square'; room: number; a11y: string }) {
  const { ui } = useTheme();
  const Icon = icon === 'square' ? Check : icon === 'owe' ? ArrowDown : ArrowUp;
  // Inside the face: two gutters, the outline and the arrow beside the amount.
  const amountRoom = room - space[5] * 2 - ARROW - space[1] - 6;
  return (
    <Press noScale onPress={() => openSheet({ type: 'plan' })} accessibilityLabel={a11y}
      style={{ position: 'absolute', left: space[4] + 2, bottom: -TICKET_DROP, maxWidth: room, transform: [{ rotate: '-3deg' }] }}>
      <View style={{ position: 'absolute', left: 0, right: 0, top: DEPTH, bottom: -DEPTH, borderRadius: corner + space[2], backgroundColor: ui.ink }} />
      <View style={{ backgroundColor: ui.canvas, borderRadius: corner + space[2], borderWidth: 2.5, borderColor: ui.ink,
        paddingTop: space[3], paddingBottom: space[2], paddingHorizontal: space[5] }}>
        <T numberOfLines={1} style={text.label}>{label}</T>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: space[1] }}>
          {/* The web has no adjustsFontSizeToFit, so a long amount is sized to the ticket here. */}
          <T numberOfLines={1} maxFontSizeMultiplier={TEXT_CAP.display} style={[text.hero, { flexShrink: 1 }, fit(amount, amountRoom)]}>{amount}</T>
          <Icon size={ARROW} color={ui.ink} />
        </View>
      </View>
    </Press>
  );
}

function GroupBand({ h, g, mine, two, first, last, balances, transfers, hide, repay }: {
  h: Household; g: Group; mine: Group; two: boolean; first: boolean; last: boolean; balances: Record<ID, number>; transfers: Transfer[]; hide: boolean; repay: boolean;
}) {
  const { ui } = useTheme();
  const name = nameOf(h, g);
  const we = mine.memberIds.length > 1;
  const owesMe = transfers.find((x) => x.fromGroupId === g.id && x.toGroupId === mine.id);
  const iOwe = transfers.find((x) => x.fromGroupId === mine.id && x.toGroupId === g.id);
  const own = balances[g.id] ?? 0;
  // With two groups the ticket already says the amount; with more, each band says where it stands.
  const standing = two ? null : own === 0 ? 'Square overall' : `Overall: ${standingWords(h, own, g.memberIds.length === 1, hide)}`;
  const action = !repay ? null
    : iOwe ? { label: two ? `${we ? 'We' : 'I'} paid ${name}` : `You paid ${money(h, iOwe.amount, hide)}`, a11y: `Record paying ${name} ${money(h, iOwe.amount, hide)}`, from: mine.id, to: g.id, amount: iOwe.amount }
    : owesMe ? { label: two ? `${name} paid ${we ? 'us' : 'me'}` : `${name} paid you`, a11y: `Record ${name} paying you ${money(h, owesMe.amount, hide)}`, from: g.id, to: mine.id, amount: owesMe.amount }
    : null;
  return (
    <View style={{ backgroundColor: ui.group(g), paddingTop: first ? theirRoom : space[5], paddingBottom: last ? space[6] : space[5], paddingHorizontal: space[5], gap: space[2] }}>
      <Chips h={h} g={g} />
      <T accessibilityRole="header" style={[text.name, { color: ui.onFill }]}>{name}</T>
      {standing ? <T style={[text.meta, { color: ui.onFill }]}>{standing}</T> : null}
      {action ? (
        <View style={{ marginTop: space[2] }}>
          <InkButton label={action.label} accessibilityLabel={action.a11y}
            onPress={() => openSheet({ type: 'repay', fromGroupId: action.from, toGroupId: action.to, amount: action.amount })} />
        </View>
      ) : null}
    </View>
  );
}

/** One chip per person: "Ari (you)", "Sam", "Mia (invited)" once the household is shared. */
function Chips({ h, g }: { h: Household; g: Group }) {
  const { ui } = useTheme();
  return (
    <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space[2] }}>
      {g.memberIds.map((id) => {
        const p = h.people.find((x) => x.id === id)!;
        const me = p.id === h.youId;
        const label = me ? (p.name.trim() && p.name.trim() !== 'You' ? `${p.name} (you)` : 'You') : h.sync && !p.joined ? `${p.name} (invited)` : p.name;
        return (
          <View key={id} style={{ paddingHorizontal: space[3], paddingVertical: space[1] + 2, borderRadius: corner, backgroundColor: alpha(ui.onFill, 0.12) }}>
            <T style={[text.strong, { color: ui.onFill, lineHeight: 18 }]}>{label}</T>
          </View>
        );
      })}
    </View>
  );
}

/** The one button style on a colour band: ink fill, canvas text. */
function InkButton({ label, onPress, accessibilityLabel }: { label: string; onPress: () => void; accessibilityLabel?: string }) {
  const { ui } = useTheme();
  return (
    <Press onPress={onPress} accessibilityLabel={accessibilityLabel ?? label}
      style={{ alignSelf: 'flex-start', minHeight: 44, justifyContent: 'center', paddingHorizontal: space[4] + 2, borderRadius: 22, backgroundColor: ui.ink }}>
      <T style={[text.strong, { color: ui.canvas }]}>{label}</T>
    </Press>
  );
}

/** Shrink a long amount so it fits on one line; a short one keeps the hero size. */
function fit(amount: string, room: number) {
  if (room <= 0) return null;
  const size = Math.min(text.hero.fontSize, Math.floor(room / (amount.length * 0.38)));
  return size < text.hero.fontSize ? { fontSize: size, lineHeight: Math.ceil(size * 1.05) } : null;
}
