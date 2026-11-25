/** Text the person pastes into Numa Pro. The key is a secret and is not stored in the app. */
export function proLinkText(householdId: string, key: string): string {
  return [
    "The Pro app can read this household. This key cannot change it.",
    `Household: ${householdId}`,
    `Key: ${key}`,
    "In the Pro app, open Settings and paste both. Keep the key secret.",
  ].join("\n");
}
