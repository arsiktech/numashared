// The history search text, shared so the web top bar's "Search history" field can drive the
// desk thread. Phone History keeps its own field but reads and writes the same value.
import { useSyncExternalStore } from 'react';

let query = '';
const listeners = new Set<() => void>();

export function setHistoryQuery(q: string) {
  if (q === query) return;
  query = q;
  for (const l of listeners) l();
}

export function getHistoryQuery() { return query; }

export function useHistoryQuery(): string {
  return useSyncExternalStore((l) => { listeners.add(l); return () => { listeners.delete(l); }; }, () => query, () => query);
}
