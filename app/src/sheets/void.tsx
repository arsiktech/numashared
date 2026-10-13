// Void a record: it stays in history, crossed out, and stops counting. It can be restored.
import { useEffect, useState } from 'react';
import { voidRecord } from '@/store/store';
import { Sheet } from '@/ui/sheet';
import { money, useHousehold } from '@/features/hooks';
import { ConfirmBody, quotedTitle, recordSummary } from '@/features/add/confirm';
import type { SheetProps } from './host';

export function VoidSheet({ spec, onClosed }: SheetProps<'void'>) {
  const { h, ledger } = useHousehold();
  // The record as it was when the sheet opened, so the sheet can fold away after the change.
  const [r] = useState(() => {
    const x = ledger?.byId[spec.recordId];
    return x && !x.voided ? x : undefined;
  });
  const ok = !!h && !!r;
  useEffect(() => { if (!ok) onClosed(); }, [ok, onClosed]);
  if (!h || !r || !ok) return null;
  const amount = r.kind === 'expense' ? r.expense!.amount : r.kind === 'settlement' ? r.settlement!.amount : r.opening!.entries.reduce((a, e) => a + e.amount, 0);
  const title = r.kind === 'expense' ? `Void ${quotedTitle(r)}?` : r.kind === 'settlement' ? 'Void this repayment?' : 'Void the opening balance?';
  return (
    <Sheet origin={spec.origin} onClosed={onClosed} height="auto" label={title}>
      <ConfirmBody title={title} sub={recordSummary(h, r)} needsReason otherPlaceholder="What happened?"
        reasons={['Duplicate', 'Wrong amount', 'Not shared', 'Other']}
        explain="It stays in history, crossed out, and stops counting. Everyone sees it was voided. You can restore it."
        action={`Void ${money(h, amount)}`}
        onConfirm={(reason) => {
          try {
            voidRecord(h, r.id, reason ?? 'Other', `${r.kind === 'expense' ? quotedTitle(r) : r.kind === 'settlement' ? 'Repayment' : 'Opening balance'} voided`);
          } catch (e) {
            return e instanceof Error ? e.message : 'Try again in a moment.';
          }
        }} />
    </Sheet>
  );
}
