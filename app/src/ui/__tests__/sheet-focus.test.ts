import { afterEach, expect, test, vi } from 'vitest';
import { escapeSheet, forwardSheetInputKey, ownsSheetFocus, takeSheetFocus } from '../sheet-focus';

// An event-capable DOM substitute exercises the production focus controller in Node.
class Control {
  tabIndex = 0;
  isConnected = true;
  disabled = false;
  hidden = false;
  visibility = 'visible';
  children: Control[] = [];
  constructor(readonly ownerDocument: FocusDocument) {}
  contains(node: unknown): boolean { return node === this || this.children.some((child) => child.contains(node)); }
  querySelectorAll(): Control[] { return this.children.flatMap((child): Control[] => [child, ...child.querySelectorAll()]); }
  matches() { return this.disabled; }
  closest() { return this.hidden; }
  getClientRects() { return this.hidden ? [] : [{}]; }
  focus = vi.fn((_options?: FocusOptions) => {
    if (!this.isConnected || this.disabled || this.hidden || this.visibility === 'hidden') return;
    this.ownerDocument.activeElement = this;
    this.ownerDocument.emit('focusin', { target: this });
  });
}

class FocusDocument {
  activeElement: Control | null = null;
  listeners = new Map<string, Set<(event: unknown) => void>>();
  mutations = new Set<() => void>();
  defaultView = {
    getComputedStyle: (control: Control) => ({ visibility: control.visibility }),
    MutationObserver: class {
      root?: Control;
      constructor(readonly callback: () => void) {}
      observe(root: Control) { this.root = root; root.ownerDocument.mutations.add(this.callback); }
      disconnect() { this.root?.ownerDocument.mutations.delete(this.callback); }
    },
  };
  addEventListener(type: string, callback: (event: unknown) => void) {
    const callbacks = this.listeners.get(type) ?? new Set();
    callbacks.add(callback); this.listeners.set(type, callbacks);
  }
  removeEventListener(type: string, callback: (event: unknown) => void) { this.listeners.get(type)?.delete(callback); }
  emit(type: string, event: unknown) { for (const callback of this.listeners.get(type) ?? []) callback(event); }
  tab(shiftKey = false) {
    const event = { ...escapeEvent('Tab'), shiftKey, ctrlKey: false, altKey: false, metaKey: false };
    this.emit('keydown', event);
    return event;
  }
}

const dom = (control: Control) => control as unknown as HTMLElement;
const cleanups: (() => void)[] = [];
afterEach(() => { while (cleanups.length) cleanups.pop()!(); });
function own(root: Control, opener: Control | null) {
  const release = takeSheetFocus(dom(root), opener && dom(opener));
  let released = false;
  const cleanup = () => { if (!released) { released = true; release(); } };
  cleanups.push(cleanup);
  return cleanup;
}
function fixture() {
  const doc = new FocusDocument();
  const opener = new Control(doc), root = new Control(doc), first = new Control(doc), note = new Control(doc), last = new Control(doc);
  root.tabIndex = -1; root.children = [first, note, last]; opener.focus();
  return { doc, opener, root, first, note, last };
}
function escapeEvent(key = 'Escape') {
  return {
    key, defaultPrevented: false, isComposing: false,
    preventDefault() { this.defaultPrevented = true; }, stopPropagation: vi.fn(),
  };
}

test('opening owns focus and ordinary Tab can leave Note in either direction', () => {
  const { doc, root, opener, first, note, last } = fixture();
  own(root, opener);
  expect(doc.activeElement).toBe(root);
  expect(doc.tab().defaultPrevented).toBe(false);
  note.focus(); expect(doc.tab().defaultPrevented).toBe(false);
  last.focus(); note.focus(); expect(doc.tab(true).defaultPrevented).toBe(false);
  first.focus(); expect(doc.activeElement).toBe(first);
});

test('a blur update does not reclaim a connected Note before Tab finishes', () => {
  const { doc, root, opener, note, last } = fixture();
  own(root, opener); note.focus();
  doc.activeElement = null;
  for (const callback of doc.mutations) callback();
  expect(doc.activeElement).toBeNull();
  last.focus(); expect(doc.activeElement).toBe(last);
});

test('wrapped focus permits scrolling while closing restores the opener without scrolling', () => {
  const { doc, root, opener, first, last } = fixture();
  const release = own(root, opener);
  expect(doc.tab(true).defaultPrevented).toBe(true);
  expect(last.focus).toHaveBeenLastCalledWith();
  expect(doc.activeElement).toBe(last);
  doc.tab(); expect(first.focus).toHaveBeenLastCalledWith();
  expect(doc.activeElement).toBe(first);
  release(); expect(opener.focus).toHaveBeenLastCalledWith({ preventScroll: true });
  expect(doc.activeElement).toBe(opener);
});

test('nested sheets keep foreground ownership and return to the exact opener', () => {
  const { doc, root, opener, note, last } = fixture();
  const releaseParent = own(root, opener); note.focus();
  const child = new Control(doc), childButton = new Control(doc);
  child.tabIndex = -1; child.children = [childButton];
  const releaseChild = own(child, note);
  expect(ownsSheetFocus(dom(root))).toBe(false);
  expect(ownsSheetFocus(dom(child))).toBe(true);
  last.focus(); expect(doc.activeElement).toBe(child);
  childButton.focus(); doc.tab(); expect(doc.activeElement).toBe(childButton);
  const parentClose = vi.fn(), childClose = vi.fn();
  const event = escapeEvent();
  if (ownsSheetFocus(dom(root))) escapeSheet(event, parentClose);
  if (ownsSheetFocus(dom(child))) escapeSheet(event, childClose);
  expect(parentClose).not.toHaveBeenCalled(); expect(childClose).toHaveBeenCalledOnce();
  releaseChild(); expect(doc.activeElement).toBe(note);
  expect(ownsSheetFocus(dom(root))).toBe(true);
  releaseParent(); expect(doc.activeElement).toBe(opener);
  expect([...doc.listeners.values()].every((listeners) => listeners.size === 0)).toBe(true);
  expect(doc.mutations.size).toBe(0);
});

test('removing a background sheet does not take focus from the foreground sheet', () => {
  const { doc, root, opener, note } = fixture();
  const releaseParent = own(root, opener), child = new Control(doc);
  own(child, note); releaseParent();
  expect(doc.activeElement).toBe(child);
});

test('closing a nested sheet falls back to its parent when the opener cannot take focus', () => {
  const { doc, root, opener, note } = fixture(); own(root, opener); note.focus();
  const child = new Control(doc), releaseChild = own(child, note);
  note.disabled = true; releaseChild();
  expect(doc.activeElement).toBe(root);
});

test('disabled and hidden controls cannot receive wrapped focus', () => {
  const { doc, root, opener, first, note, last } = fixture();
  first.disabled = true; note.tabIndex = -1;
  const hidden = new Control(doc), invisible = new Control(doc);
  hidden.hidden = true; invisible.visibility = 'hidden'; root.children.push(hidden, invisible);
  own(root, opener); doc.tab(true); expect(doc.activeElement).toBe(last);
  last.disabled = true; doc.tab(); expect(doc.activeElement).toBe(root);
});

test('panel replacement restores the stable dialog without focusing a detached opener', () => {
  const { doc, root, opener, note } = fixture(); const release = own(root, opener);
  note.focus(); note.isConnected = false; root.children = []; doc.activeElement = null;
  for (const callback of doc.mutations) callback();
  expect(doc.activeElement).toBe(root);
  opener.isConnected = false; opener.focus.mockClear(); release();
  expect(opener.focus).not.toHaveBeenCalled();
});

test('one Escape dismisses a field without a preliminary blur', () => {
  const event = { ...escapeEvent(), target: { blur: vi.fn() } }, close = vi.fn();
  escapeSheet(event, close);
  expect(close).toHaveBeenCalledOnce(); expect(event.defaultPrevented).toBe(true);
  expect(event.stopPropagation).toHaveBeenCalledOnce();
  expect(event.target.blur).not.toHaveBeenCalled();
});

test('field forwarding preserves typing, navigation, handled keys and composition cancellation', () => {
  const close = vi.fn();
  const forward = (key: string, isComposing = false, prevented = false) => {
    const event = { nativeEvent: { key, isComposing }, isDefaultPrevented: () => prevented, preventDefault: vi.fn(), stopPropagation: vi.fn() };
    forwardSheetInputKey(event, close); return event;
  };
  for (const key of ['n', '1', 'Enter', 'Tab', 'Backspace']) expect(forward(key).preventDefault).not.toHaveBeenCalled();
  forward('Escape', true); forward('Escape', false, true);
  expect(close).not.toHaveBeenCalled();
  expect(forward('Escape').preventDefault).toHaveBeenCalledOnce();
  expect(close).toHaveBeenCalledOnce();
});
