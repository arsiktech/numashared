// The exported file's name. Kept free of React Native so tests can check it.

/** "numa-shared-home.csv" becomes "numa-shared-home-2026-10-19.csv" (local date). */
export function datedName(name: string, now = new Date()) {
  const pad = (n: number) => String(n).padStart(2, '0');
  const day = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  return name.replace(/\.csv$/, `-${day}.csv`);
}
