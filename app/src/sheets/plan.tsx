// Balance sheet, opened by the Home ticket: the sentence, the plan and every line behind it.
import { Sheet } from '@/ui/sheet';
import { PlanContent } from '@/features/plan/content';
import type { SheetProps } from './host';

export function PlanSheet({ spec, onClosed }: SheetProps<'plan'>) {
  return (
    <Sheet origin={spec.origin} onClosed={onClosed} label="Balance">
      <PlanContent />
    </Sheet>
  );
}
