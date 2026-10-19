// The invite picture: three finder squares and a module field drawn with Views from the code.
import { useMemo } from 'react';
import { View } from 'react-native';
import { useTheme } from '@/ui/theme';
import { invitePattern } from './model';

export function InvitePattern({ code, size = 168, label }: { code: string; size?: number; label: string }) {
  const { c } = useTheme();
  const n = 21;
  const m = size / n;
  const grid = useMemo(() => invitePattern(code, n), [code]);
  const finder = (left: number, top: number) => (
    <View key={`${left}-${top}`} style={{ position: 'absolute', left, top, width: m * 7, height: m * 7, backgroundColor: c.ink }}>
      <View style={{ position: 'absolute', left: m, top: m, width: m * 5, height: m * 5, backgroundColor: c.card }} />
      <View style={{ position: 'absolute', left: m * 2, top: m * 2, width: m * 3, height: m * 3, backgroundColor: c.ink }} />
    </View>
  );
  return (
    <View accessible accessibilityRole="image" accessibilityLabel={label} style={{ width: size, height: size }}>
      {finder(0, 0)}
      {finder(size - m * 7, 0)}
      {finder(0, size - m * 7)}
      {grid.flatMap((row, y) => row.map((on, x) => (on ? (
        <View key={`${x}:${y}`} style={{ position: 'absolute', left: x * m, top: y * m, width: m, height: m, borderRadius: 1, backgroundColor: c.ink }} />
      ) : null)))}
    </View>
  );
}
