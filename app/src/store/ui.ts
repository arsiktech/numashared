// Transient UI state: which sheet is open, where it grows from, and the undo lane.
import { useSyncExternalStore } from 'react';
import type { ID } from '@/core/types';

export type Origin = { x: number; y: number; r: number };

export type SheetSpec =
  | { type: 'add'; editRecordId?: ID; preset?: { payerId?: ID; category?: string } }
  | { type: 'repay'; fromGroupId?: ID; toGroupId?: ID; amount?: number }
  | { type: 'detail'; recordId: ID }
  | { type: 'plan' }
  | { type: 'void'; recordId: ID }
  | { type: 'households' }
  | { type: 'signout' }
  | { type: 'flag'; recordId: ID };

export type OpenSheet = SheetSpec & { key: number; origin?: Origin };

type UI = { sheets: OpenSheet[]; toast: { key: number; text: string } | null; celebrate: number | null };

let ui: UI = { sheets: [], toast: null, celebrate: null };
const listeners = new Set<() => void>();
const emit = () => { for (const l of listeners) l(); };
let seq = 1;

export function useUI<T>(sel: (u: UI) => T): T {
  return useSyncExternalStore((l) => { listeners.add(l); return () => { listeners.delete(l); }; }, () => sel(ui), () => sel(ui));
}

export function openSheet(spec: SheetSpec, origin?: Origin) {
  ui = { ...ui, sheets: [...ui.sheets, { ...spec, key: seq++, origin }] };
  emit();
}

/** Replace the top sheet (for example Detail -> Edit) without a close animation. */
export function replaceSheet(spec: SheetSpec) {
  const top = ui.sheets[ui.sheets.length - 1];
  ui = { ...ui, sheets: [...ui.sheets.slice(0, -1), { ...spec, key: seq++, origin: top?.origin }] };
  emit();
}

export function closeSheet(key?: number) {
  ui = { ...ui, sheets: key === undefined ? ui.sheets.slice(0, -1) : ui.sheets.filter((s) => s.key !== key) };
  emit();
}

export function closeAllSheets() { ui = { ...ui, sheets: [] }; emit(); }

export function showToast(text: string) { ui = { ...ui, toast: { key: seq++, text } }; emit(); }
export function clearToast() { ui = { ...ui, toast: null }; emit(); }

export function celebrate() { ui = { ...ui, celebrate: seq++ }; emit(); }
export function endCelebrate() { ui = { ...ui, celebrate: null }; emit(); }
