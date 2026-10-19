/** Sheets whose Save is running or went through (by sheet key). */
const savingSheets = new Set<number>();

/**
 * A Save guard kept outside the component: a sheet's closing animation remounts its content, and
 * a per-mount guard would let a second tap during the animation save twice.
 */
export function saveGuard(key: number): { current: boolean } {
  return {
    get current() { return savingSheets.has(key); },
    set current(v: boolean) { if (v) savingSheets.add(key); else savingSheets.delete(key); },
  };
}
