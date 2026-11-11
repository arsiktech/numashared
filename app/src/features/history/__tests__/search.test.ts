import { describe, expect, test } from 'vitest';
import { closeHistorySearch, getHistoryQuery, getHistorySearchOpen, onHistorySearchX, requestHistorySearch, setHistoryQuery } from '../search';

describe('history search X', () => {
  test('closes the field after typing instead of leaving it open', () => {
    setHistoryQuery('zzz');
    requestHistorySearch(true);
    const closeField = viClose();
    onHistorySearchX(closeField.fn);
    expect(getHistoryQuery()).toBe('');
    expect(getHistorySearchOpen()).toBe(false);
    expect(closeField.calls).toBe(1);
  });

  test('closes an empty field too', () => {
    closeHistorySearch();
    requestHistorySearch(true);
    const closeField = viClose();
    onHistorySearchX(closeField.fn);
    expect(getHistorySearchOpen()).toBe(false);
    expect(closeField.calls).toBe(1);
  });
});

function viClose() {
  const box = { calls: 0, fn: () => { box.calls += 1; } };
  return box;
}
