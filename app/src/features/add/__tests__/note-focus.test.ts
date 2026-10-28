import { expect, test, vi } from 'vitest';
import type { ReactElement } from 'react';
import { NoteLine } from '../parts';

const platform = vi.hoisted(() => ({ web: true, escape: vi.fn() }));
vi.mock('react-native', () => ({ ScrollView: 'ScrollView', TextInput: 'TextInput', View: 'View' }));
vi.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({}) }));
vi.mock('@/store/ids', () => ({ todayISO: () => '2026-01-01' }));
vi.mock('../draft', () => ({ dateLabel: vi.fn(), dateSpoken: vi.fn(), daysAgoISO: vi.fn(), groupInitials: vi.fn(), shiftISO: vi.fn() }));
vi.mock('@/ui/icons', () => ({ ChevDown: 'Icon', ChevUp: 'Icon', Close: 'Icon', Pencil: 'Icon' }));
vi.mock('@/ui/primitives', () => ({ IconButton: 'IconButton', Press: 'Press', T: 'T', TChip: 'TChip', TextButton: 'TextButton' }));
vi.mock('@/ui/sheet', () => ({ SheetHead: 'SheetHead', useSheet: () => ({ escape: platform.escape }) }));
vi.mock('@/ui/theme', () => ({ useTheme: () => ({ largeText: false }) }));
vi.mock('@/ui/tokens', () => ({ alpha: (value: string) => value, fonts: {}, isAndroid: false, get isWeb() { return platform.web; } }));

function render(editing: boolean, setEditing = vi.fn(), onSubmit = vi.fn(), placeholder?: string) {
  return NoteLine({ tone: { ink: '#123456' } as Parameters<typeof NoteLine>[0]['tone'], value: 'A note', onChange: vi.fn(), editing, setEditing, onSubmit, placeholder });
}
type Field = ReactElement<{
  accessibilityLabel: string; autoFocus: boolean; onFocus?: () => void; onBlur: () => void;
  onSubmitEditing: () => void; onKeyPress?: (event: { nativeEvent: { key: string }; isDefaultPrevented: () => boolean; preventDefault: () => void; stopPropagation: () => void }) => void;
  style: object[];
}>;
const field = (tree: ReactElement) => (tree.props as { children: ReactElement[] }).children[1] as Field;

test('web Note retains the input position across focus and blur without autofocus', () => {
  platform.web = true;
  const idle = render(false), editing = render(true), blurred = render(false);
  for (const tree of [idle, editing, blurred]) {
    expect(tree.type).toBe(idle.type);
    expect(field(tree).type).toBe('TextInput'); expect(field(tree).key).toBeNull();
    expect(field(tree).props.autoFocus).toBe(false);
    expect(field(tree).props.accessibilityLabel).toBe('Add a note, optional');
    expect(field(tree).props.style).toContainEqual({ outlineStyle: 'auto' });
  }
  expect(field(render(false, vi.fn(), vi.fn(), 'What happened?')).props.accessibilityLabel).toBe('What happened?, optional');
});

test('Note blur updates editing without submitting and Escape reaches the owning sheet', () => {
  platform.web = true; platform.escape.mockClear();
  const setEditing = vi.fn(), submit = vi.fn(), input = field(render(false, setEditing, submit));
  input.props.onFocus!(); expect(setEditing).toHaveBeenLastCalledWith(true);
  input.props.onBlur(); expect(setEditing).toHaveBeenLastCalledWith(false);
  expect(submit).not.toHaveBeenCalled();
  const event = { nativeEvent: { key: 'Escape' }, isDefaultPrevented: () => false, preventDefault: vi.fn(), stopPropagation: vi.fn() };
  input.props.onKeyPress!(event); expect(platform.escape).toHaveBeenCalledOnce();
  input.props.onSubmitEditing(); expect(submit).toHaveBeenCalledOnce();
});

test('native Note keeps tap to edit and autofocus when its editor opens', () => {
  platform.web = false;
  try {
    const setEditing = vi.fn(), idle = render(false, setEditing);
    expect(idle.type).toBe('Press');
    (idle.props as { onPress: () => void }).onPress(); expect(setEditing).toHaveBeenCalledWith(true);
    const input = field(render(true));
    expect(input.props.autoFocus).toBe(true); expect(input.props.accessibilityLabel).toBe('Note');
    expect(input.props.onFocus).toBeUndefined(); expect(input.props.onKeyPress).toBeUndefined();
  } finally { platform.web = true; }
});
