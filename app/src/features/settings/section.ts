// Desk and tablet settings keep You and Account on /settings. The section lives in the query
// so a reload or a shared link opens the same place. Household is the bare /settings URL.

export type SettingsQuerySection = 'you' | 'account';
export type SettingsInPageSection = 'household' | SettingsQuerySection;

export function settingsSectionFromParam(section: string | string[] | undefined): SettingsInPageSection {
  const raw = Array.isArray(section) ? section[0] : section;
  return raw === 'you' || raw === 'account' ? raw : 'household';
}

/** `undefined` drops the query, which is the Household URL. */
export function settingsSectionToParam(section: SettingsInPageSection): SettingsQuerySection | undefined {
  return section === 'household' ? undefined : section;
}

type SettingsNavSection = SettingsInPageSection | 'people' | 'data';

/**
 * You and Account stay on this screen and are written to the URL. People and Data are other
 * screens, so this returns false and the caller navigates.
 */
export function applySettingsSection(
  current: SettingsInPageSection,
  next: SettingsNavSection,
  write: (section: SettingsQuerySection | undefined) => void,
): boolean {
  if (next !== 'household' && next !== 'you' && next !== 'account') return false;
  const param = settingsSectionToParam(next);
  if (param !== settingsSectionToParam(current)) write(param);
  return true;
}
