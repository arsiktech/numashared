// Detail sheet (phone and tablet): a paper sheet with the record's whole story.
import { Sheet } from '@/ui/sheet';
import { RecordDetail } from '@/features/detail/content';
import type { SheetProps } from './host';

export function DetailSheet({ spec, onClosed }: SheetProps<'detail'>) {
  return (
    <Sheet origin={spec.origin} onClosed={onClosed} label="Record details">
      <RecordDetail recordId={spec.recordId} variant="sheet" />
    </Sheet>
  );
}
