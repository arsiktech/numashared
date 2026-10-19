// What deleting the account does to each shared household, in words.
import type { DeletionPreview } from '@/sync/accountDeletion';

export function outcomeText(p: DeletionPreview['pots'][number]): string {
  const name = p.name ?? 'A household';
  if (p.outcome === 'deleted') return `${name} is deleted, with its whole history. Nobody else is in it.`;
  return p.successorName
    ? `${name} stays for the others. ${p.successorName} becomes its owner, and you show as “Former member”.`
    : `${name} stays for the others, and you show as “Former member”.`;
}
