/** Text the person pastes into Numa Pro. The key is a secret and is not stored in the app. */
export function proLinkText(householdId: string, key: string): string {
  return [
    "Numa Pro can read this household. This key cannot change it.",
    `Household: ${householdId}`,
    `Key: ${key}`,
    "In Numa Pro, open Settings and paste both. Keep the key secret.",
  ].join("\n");
}
