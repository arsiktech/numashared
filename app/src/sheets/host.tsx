// Renders the open sheets on top of every screen. Each sheet type lives in its own file.
import { View, StyleSheet } from 'react-native';
import { closeSheet, useUI, type OpenSheet } from '@/store/ui';
import { FROZEN_HISTORY_MESSAGE, useStore } from '@/store/store';
import { Sheet, useSheet } from '@/ui/sheet';
import { T, TextButton } from '@/ui/primitives';
import { AddSheet } from './add';
import { RepaySheet } from './repay';
import { DetailSheet } from './detail';
import { PlanSheet } from './plan';
import { VoidSheet } from './void';
import { HouseholdsSheet } from './households';
import { SignOutSheet } from './signout';
import { FlagSheet } from './flag';

export type SheetProps<T extends OpenSheet['type']> = { spec: Extract<OpenSheet, { type: T }>; onClosed: () => void };

export function SheetHost() {
  const sheets = useUI((u) => u.sheets);
  const frozen = useStore((s) => !!s.households.find((h) => h.id === s.activeId)?.sync?.frozen);
  if (!sheets.length) return null;
  return (
    <View style={StyleSheet.absoluteFill} pointerEvents="box-none">
      {sheets.map((spec) => {
        const onClosed = () => closeSheet(spec.key);
        if (frozen && ['add', 'repay', 'void', 'flag'].includes(spec.type)) {
          return <Sheet key={spec.key} origin={spec.origin} onClosed={onClosed} height="auto" label="Read-only history"><ReadOnlyBody /></Sheet>;
        }
        switch (spec.type) {
          case 'add': return <AddSheet key={spec.key} spec={spec} onClosed={onClosed} />;
          case 'repay': return <RepaySheet key={spec.key} spec={spec} onClosed={onClosed} />;
          case 'detail': return <DetailSheet key={spec.key} spec={spec} onClosed={onClosed} />;
          case 'plan': return <PlanSheet key={spec.key} spec={spec} onClosed={onClosed} />;
          case 'void': return <VoidSheet key={spec.key} spec={spec} onClosed={onClosed} />;
          case 'households': return <HouseholdsSheet key={spec.key} spec={spec} onClosed={onClosed} />;
          case 'signout': return <SignOutSheet key={spec.key} spec={spec} onClosed={onClosed} />;
          case 'flag': return <FlagSheet key={spec.key} spec={spec} onClosed={onClosed} />;
        }
      })}
    </View>
  );
}

function ReadOnlyBody() {
  const { close } = useSheet();
  return <View style={{ padding: 24, gap: 16 }}>
    <T accessibilityRole="header" style={{ fontSize: 20 }}>Read-only history</T>
    <T style={{ fontSize: 16, lineHeight: 22 }}>{FROZEN_HISTORY_MESSAGE}</T>
    <TextButton label="Close" bold onPress={close} />
  </View>;
}
