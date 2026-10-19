// Renders the open sheets on top of every screen. Each sheet type lives in its own file.
import { View, StyleSheet } from 'react-native';
import { closeSheet, useUI, type OpenSheet } from '@/store/ui';
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
  if (!sheets.length) return null;
  return (
    <View style={StyleSheet.absoluteFill} pointerEvents="box-none">
      {sheets.map((spec) => {
        const onClosed = () => closeSheet(spec.key);
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
