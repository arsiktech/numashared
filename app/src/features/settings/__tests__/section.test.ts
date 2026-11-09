import { describe, expect, test } from 'vitest';
import { applySettingsSection, SETTINGS_NAV, settingsSectionFromParam, settingsSectionToParam } from '../section';

describe('settings section URL', () => {
  test('reads You and Account, and treats anything else as Household', () => {
    expect(settingsSectionFromParam('you')).toBe('you');
    expect(settingsSectionFromParam('account')).toBe('account');
    expect(settingsSectionFromParam(['account', 'you'])).toBe('account');
    expect(settingsSectionFromParam(undefined)).toBe('household');
    expect(settingsSectionFromParam('')).toBe('household');
    expect(settingsSectionFromParam('household')).toBe('household');
    expect(settingsSectionFromParam('people')).toBe('household');
  });

  test('writes You and Account, and leaves Household off the query', () => {
    expect(settingsSectionToParam('you')).toBe('you');
    expect(settingsSectionToParam('account')).toBe('account');
    expect(settingsSectionToParam('household')).toBeUndefined();
  });

  test('clicking You then Account then Household updates the URL, and other sections do not', () => {
    const writes: (string | undefined)[] = [];
    const write = (section: string | undefined) => { writes.push(section); };
    expect(applySettingsSection('household', 'you', write)).toBe(true);
    expect(applySettingsSection('you', 'account', write)).toBe(true);
    expect(applySettingsSection('account', 'household', write)).toBe(true);
    expect(applySettingsSection('household', 'household', write)).toBe(true);
    expect(writes).toEqual(['you', 'account', undefined]);
    expect(applySettingsSection('household', 'people', write)).toBe(false);
    expect(applySettingsSection('you', 'data', write)).toBe(false);
    expect(applySettingsSection('household', 'agents', write)).toBe(false);
    expect(writes).toEqual(['you', 'account', undefined]);
  });

  test('AI agents has its own place in the tablet and desk section list', () => {
    expect(SETTINGS_NAV.find((n) => n.key === 'agents')).toEqual({ key: 'agents', label: 'AI agents', href: '/settings/agents' });
  });
});
