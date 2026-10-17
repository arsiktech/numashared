// Flag a repayment that looks wrong. It is fixed by a linked correction; both stay in history.
import { useEffect, useState } from 'react';
import { flagSettlement } from '@/store/store';
import { Sheet } from '@/ui/sheet';
import { useHousehold } from '@/features/hooks';
import { ConfirmBody, recordSummary } from '@/features/add/confirm';
import type { SheetProps } from './host';

export function FlagSheet({ spec, onClosed }: SheetProps<'flag'>) {
  const { h, ledger } = useHousehold();
  // The record as it was when the sheet opened, so the sheet can fold away after the change.
  const [r] = useState(() => {
    const x = ledger?.byId[spec.recordId];
    return x && x.kind === 'settlement' && !x.flagged && !x.voided ? x : undefined;
  });
  const ok = !!h && !!r;
  useEffect(() => { if (!ok) onClosed(); }, [ok, onClosed]);
  if (!h || !r || !ok) return null;
  return (
    <Sheet origin={spec.origin} onClosed={onClosed} height="auto" label="Flag this repayment?">
      <ConfirmBody title="Flag this repayment?" sub={recordSummary(h, r)} needsReason={false} otherPlaceholder="What looks wrong?"
        reasons={['Wrong amount', 'Never arrived', 'Duplicate', 'Other']}
        explain="A flagged repayment is fixed by a linked correction. Both stay in history."
        action="Flag repayment"
        onConfirm={(reason) => {
          try {
            flagSettlement(h, r.id, reason);
          } catch (e) {
            return e instanceof Error ? e.message : 'Try again in a moment.';
          }
        }} />
    </Sheet>
  );
}
