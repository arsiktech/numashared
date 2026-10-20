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

// On the web, the browser's Back button closes an Add or Repay sheet instead of leaving the screen
// and the draft behind. Opening one adds a history entry for the same address; Back takes it off.
const web = typeof window !== 'undefined' && typeof window.history?.pushState === 'function' && typeof document !== 'undefined';
const keepsDraft = (s: SheetSpec) => s.type === 'add' || s.type === 'repay';
let held: number | null = null; // the sheet that owns the history entry
let swallow = false; // our own history.back(), which the router must not see

function hold(key: number) {
  if (!web || held !== null) return;
  held = key;
  window.history.pushState({ ...(window.history.state ?? {}), numaSheet: key }, '');
}

function release() {
  if (!web || held === null) return;
  const key = held;
  held = null;
  if (window.history.state?.numaSheet === key) { swallow = true; window.history.back(); }
}

if (web) {
  window.addEventListener('popstate', (e) => {
    if (swallow) { swallow = false; e.stopImmediatePropagation(); return; }
    if (held === null) return;
    const at = ui.sheets.findIndex((s) => s.key === held);
    held = null;
    if (at < 0) return;
    e.stopImmediatePropagation();
    ui = { ...ui, sheets: ui.sheets.slice(0, at) };
    emit();
  });
}

export function openSheet(spec: SheetSpec, origin?: Origin) {
  const key = seq++;
  ui = { ...ui, sheets: [...ui.sheets, { ...spec, key, origin }] };
  if (keepsDraft(spec)) hold(key);
  emit();
}

/** Replace the top sheet (for example Detail -> Edit) without a close animation. */
export function replaceSheet(spec: SheetSpec) {
  const top = ui.sheets[ui.sheets.length - 1];
  const key = seq++;
  ui = { ...ui, sheets: [...ui.sheets.slice(0, -1), { ...spec, key, origin: top?.origin }] };
  if (top && held === top.key) {
    if (keepsDraft(spec)) { held = key; window.history.replaceState({ ...(window.history.state ?? {}), numaSheet: key }, ''); }
    else release();
  } else if (keepsDraft(spec)) hold(key);
  emit();
}

export function closeSheet(key?: number) {
  const gone = key === undefined ? ui.sheets[ui.sheets.length - 1]?.key : key;
  ui = { ...ui, sheets: key === undefined ? ui.sheets.slice(0, -1) : ui.sheets.filter((s) => s.key !== key) };
  if (gone !== undefined && gone === held) release();
  emit();
}

export function closeAllSheets() { ui = { ...ui, sheets: [] }; release(); emit(); }

export function showToast(text: string) { ui = { ...ui, toast: { key: seq++, text } }; emit(); }
export function clearToast() { ui = { ...ui, toast: null }; emit(); }

export function celebrate() { ui = { ...ui, celebrate: seq++ }; emit(); }
export function endCelebrate() { ui = { ...ui, celebrate: null }; emit(); }
