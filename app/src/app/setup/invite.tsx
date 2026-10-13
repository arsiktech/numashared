// Invite your household: the code as a picture and as text, share or copy it, and who is in.
// Joining from another phone needs sync, which arrives in a later update; the screen says so.
import { View } from 'react-native';
import { Redirect } from 'expo-router';
import { Copy, Share as ShareIcon } from '@/ui/icons';
import { Dot, ListCard, Pill, T } from '@/ui/primitives';
import { useTheme } from '@/ui/theme';
import { fonts } from '@/ui/tokens';
import { useHousehold, initials } from '@/features/hooks';
import { Caption, Screen, ScreenHeader } from '@/features/onboarding/chrome';
import { showCode } from '@/features/onboarding/model';
import { InvitePattern } from '@/features/onboarding/pattern';
import { shareText } from '@/features/onboarding/share';

export default function Invite() {
  const { h } = useHousehold();
  const { c } = useTheme();
  if (!h) return <Redirect href="/welcome" />;
  const code = showCode(h.inviteCode);
  const others = h.people.filter((p) => p.id !== h.youId);
  return (
    <Screen header={<ScreenHeader title="Invite your household" back={h.name} />}>
      <View style={{ marginTop: 22, backgroundColor: c.card, borderRadius: 22, paddingTop: 26, paddingHorizontal: 22, paddingBottom: 24, alignItems: 'center' }}>
        <InvitePattern code={h.inviteCode} label={`Invite picture for ${h.name}. The code is ${code.split('').join(' ')}`} />
        <T style={{ fontFamily: fonts.semibold, fontSize: 12.5, color: c.ink2, marginTop: 14 }}>or type the code</T>
        <T selectable accessibilityLabel={`Invite code ${code.split('').join(' ')}`}
          style={{ fontFamily: fonts.semibold, fontSize: 36, lineHeight: 42, letterSpacing: 5, paddingLeft: 5, marginTop: 2, fontVariant: ['tabular-nums'] }}>{code}</T>
      </View>

      <View style={{ flexDirection: 'row', gap: 12, marginTop: 16 }}>
        <Pill label="Share invite" style={{ flex: 1, height: 48, borderRadius: 24, alignSelf: 'auto' }} icon={<ShareIcon size={18} color={c.bg} />}
          onPress={() => shareText(`Join ${h.name} on Numa Shared with the code ${code}.`, 'Invite copied', `Join ${h.name}`)} />
        <Pill light label="Copy code" style={{ flex: 1, height: 48, borderRadius: 24, alignSelf: 'auto' }} icon={<Copy size={18} color={c.ink} />}
          onPress={() => shareText(code, 'Code copied')} />
      </View>

      <T accessibilityRole="header" style={{ fontFamily: fonts.semibold, fontSize: 13, color: c.ink2, paddingTop: 28, paddingBottom: 8, paddingHorizontal: 4 }}>Who’s in</T>
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
            ) : <T style={{ fontSize: 15, color: c.ink2 }}>Invited</T>}
          </View>
        )) : (
          <T style={{ padding: 16, fontSize: 15, color: c.ink2 }}>Just you so far. Add people in Settings, People and groups.</T>
        )}
      </ListCard>
      <Caption style={{ marginTop: 12, fontFamily: fonts.medium, lineHeight: 18 }}>People join from their own phone once sync is on. Until then, add their expenses for them.</Caption>
    </Screen>
  );
}
