// Undo policy, ported from Undo.swift. History is append-only; the only deletion allowed is of
// your own just-saved event, inside a short window, before it has been sent anywhere.
import { reduce } from './ledger';
import type { Household, ID, LedgerEvent } from './types';

/** The new app's window. Swift's was 6 seconds. */
export const UNDO_WINDOW_MS = 8000;

/** Whether sync has had any chance to transmit a locally saved event. */
export type EventDispatchState = 'heldLocally' | 'dispatching' | 'dispatched';

/** Elapsed time is in the half-open window [0, windowMs). */
export function canUndo(event: Pick<LedgerEvent, 'at'>, now: number, windowMs = UNDO_WINDOW_MS): boolean {
  const elapsed = now - event.at;
  return elapsed >= 0 && elapsed < windowMs;
}

/** Milliseconds left to undo, 0 when the window has closed. For the Undo countdown. */
export function undoRemainingMs(event: Pick<LedgerEvent, 'at'>, now: number, windowMs = UNDO_WINDOW_MS): number {
  return canUndo(event, now, windowMs) ? windowMs - (now - event.at) : 0;
}

/** Full Swift policy: active Undo affordance, never dispatched, inside the window. */
export function canDeleteLocalEvent(args: {
  savedAt: number;
  now: number;
  dispatchState: EventDispatchState;
  undoSessionIsActive: boolean;
  windowMs?: number;
}): boolean {
  return args.undoSessionIsActive
    && args.dispatchState === 'heldLocally'
    && canUndo({ at: args.savedAt }, args.now, args.windowMs);
}

/**
 * Household-level check before removing an event: it exists, it is the viewer's own, it is inside
 * the window, and no later event depends on it (removing an expense that was since edited or
 * voided would leave those events pointing at nothing).
 */
export function canUndoInHousehold(household: Household, eventId: ID, now: number, windowMs = UNDO_WINDOW_MS): boolean {
  const index = household.events.findIndex((e) => e.id === eventId);
  if (index < 0) return false;
  const event = household.events[index];
  if (event.by !== household.youId || !canUndo(event, now, windowMs)) return false;
  const dependedOn = household.events.slice(index + 1).some((later) =>
    later.recordId === event.recordId
    || (later.kind === 'settlementRecorded' && later.content.reversalOf === event.recordId));
  if (dependedOn) return false;
  try {
    reduce({ ...household, events: household.events.filter((e) => e.id !== eventId) });
    return true;
  } catch {
    return false;
  }
}
