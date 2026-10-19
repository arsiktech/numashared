// What the server will accept from this app right now. Swift build 11 is still in use and can read
// only the original contract: no expense note, edit reason or repayment method and note, and budget
// groups of one or two people. The server opens the wider contract once production requires
// build 12 or later (`/app-config` reports `minimumSupportedBuild`), and so does this app.
import { useSyncExternalStore } from 'react';
import { MAX_GROUP_SIZE } from '../core/types';

export const EXTENDED_CONTRACT_MINIMUM_BUILD = 12;

export type ClientContract = {
  /** Expense notes, edit reasons, repayment method and note reach other people. */
  extendedText: boolean;
  /** Largest group of people who pay as one. */
  maxGroupSize: number;
};

export const LEGACY_CONTRACT: ClientContract = { extendedText: false, maxGroupSize: 2 };
export const EXTENDED_CONTRACT: ClientContract = { extendedText: true, maxGroupSize: MAX_GROUP_SIZE };

export function contractFor(minimumSupportedBuild: number | null | undefined): ClientContract {
  return minimumSupportedBuild != null && minimumSupportedBuild >= EXTENDED_CONTRACT_MINIMUM_BUILD
    ? EXTENDED_CONTRACT : LEGACY_CONTRACT;
}

let current: ClientContract = LEGACY_CONTRACT;
const listeners = new Set<() => void>();

export const getContract = () => current;
export const maxGroupSize = () => current.maxGroupSize;

export function setContract(next: ClientContract) {
  if (next === current) return;
  current = next;
  for (const l of listeners) l();
}

export function useContract(): ClientContract {
  return useSyncExternalStore(
    (l) => { listeners.add(l); return () => { listeners.delete(l); }; },
    () => current, () => current,
  );
}

/** "two" or "six", for copy such as "A group is up to six people". */
export function groupLimitWords(size = current.maxGroupSize): string {
  return ['zero', 'one', 'two', 'three', 'four', 'five', 'six'][size] ?? String(size);
}

/** Reads the build floor from the server. Unreachable or malformed answers keep the old contract. */
export async function refreshContract(siteUrl: string, fetcher: typeof fetch = fetch): Promise<ClientContract> {
  try {
    const res = await fetcher(`${siteUrl}/app-config`, { headers: { accept: 'application/json' } });
    if (!res.ok) return current;
    const body = await res.json() as { minimumSupportedBuild?: unknown };
    const build = typeof body.minimumSupportedBuild === 'number' ? body.minimumSupportedBuild : null;
    setContract(contractFor(build));
  } catch { /* offline: keep what we know */ }
  return current;
}
