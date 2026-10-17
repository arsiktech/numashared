// History: the whole household as one conversation. Phone only; on a tablet or desk the same
// thread lives in the middle of Home, so this route sends you there.
import { View } from 'react-native';
import { Redirect } from 'expo-router';
import { openSheet } from '@/store/ui';
import { useTheme } from '@/ui/theme';
import { useHousehold } from '@/features/hooks';
import { HistoryThread } from '@/features/history/thread';

export default function History() {
  const { h } = useHousehold();
  const { c, layout } = useTheme();
  if (!h) return <Redirect href="/welcome" />;
  if (layout !== 'phone') return <Redirect href="/home" />;
  return (
    <View style={{ flex: 1, backgroundColor: c.bg }}>
      <HistoryThread onSelect={(id) => openSheet({ type: 'detail', recordId: id })} />
    </View>
  );
}
