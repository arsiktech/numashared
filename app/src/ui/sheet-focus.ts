// The outer dialog survives the animated panel replacement on web.
const sheets: HTMLElement[] = [];
export const ownsSheetFocus = (root: HTMLElement) => sheets.at(-1) === root;
const coveredSheets = new Map<HTMLElement, { inert: boolean; hidden: string | null }>();

function restoreSheetAccess(root: HTMLElement) {
  const previous = coveredSheets.get(root);
  if (!previous) return;
  root.inert = previous.inert;
  if (previous.hidden === null) root.removeAttribute('aria-hidden');
  else root.setAttribute('aria-hidden', previous.hidden);
  coveredSheets.delete(root);
}

function updateSheetAccess() {
  for (const root of sheets) {
    if (ownsSheetFocus(root)) restoreSheetAccess(root);
    else if (!coveredSheets.has(root)) {
      coveredSheets.set(root, { inert: root.inert, hidden: root.getAttribute('aria-hidden') });
      root.inert = true;
      root.setAttribute('aria-hidden', 'true');
    }
  }
}

/** Escape dismisses a sheet in one step, including from a text field. */
export function escapeSheet(e: Pick<KeyboardEvent, 'key' | 'defaultPrevented' | 'isComposing' | 'preventDefault' | 'stopPropagation'>, close: () => void) {
  if (e.key !== 'Escape' || e.defaultPrevented || e.isComposing) return;
  e.preventDefault();
  e.stopPropagation();
  close();
}

/** RN Web TextInput stops bubbling before calling onKeyPress. */
export function forwardSheetInputKey(e: {
  nativeEvent: { key: string; isComposing?: boolean };
  isDefaultPrevented: () => boolean;
  preventDefault: () => void;
  stopPropagation: () => void;
}, close: () => void) {
  escapeSheet({
    key: e.nativeEvent.key,
    defaultPrevented: e.isDefaultPrevented(),
    isComposing: e.nativeEvent.isComposing ?? false,
    preventDefault: () => e.preventDefault(),
    stopPropagation: () => e.stopPropagation(),
  }, close);
}

function tabStops(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>('a[href],button,input,select,textarea,[tabindex],[contenteditable="true"]'))
    .filter((el) => el.tabIndex >= 0 && !el.matches(':disabled,[aria-disabled="true"]')
      && !el.closest('[hidden],[inert],[aria-hidden="true"]') && el.getClientRects().length > 0
      && root.ownerDocument.defaultView?.getComputedStyle(el).visibility !== 'hidden');
}

/** Keep focus in the foreground sheet and restore its exact connected opener. */
export function takeSheetFocus(root: HTMLElement, opener: HTMLElement | null): () => void {
  const doc = root.ownerDocument;
  let last = root;
  sheets.push(root);
  const focusInside = () => {
    const target = last.isConnected && root.contains(last) ? last : root;
    target.focus({ preventScroll: true });
    if (!root.contains(doc.activeElement)) root.focus({ preventScroll: true });
  };
  const onFocus = (e: FocusEvent) => {
    if (!ownsSheetFocus(root)) return;
    if (root.contains(e.target as Node)) last = e.target as HTMLElement;
    else focusInside();
  };
  const onKey = (e: KeyboardEvent) => {
    if (!ownsSheetFocus(root) || e.key !== 'Tab' || e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey) return;
    const stops = tabStops(root);
    const active = doc.activeElement;
    if (!stops.length) {
      e.preventDefault();
      root.focus({ preventScroll: true });
    } else if (!root.contains(active) || (e.shiftKey && (active === stops[0] || active === root)) || (!e.shiftKey && active === stops.at(-1))) {
      e.preventDefault();
      // Ordinary focus lets the browser reveal the destination at browser zoom.
      (e.shiftKey ? stops[stops.length - 1] : stops[0]).focus();
    }
  };
  doc.addEventListener('focusin', onFocus);
  doc.addEventListener('keydown', onKey, true);
  const observer = doc.defaultView?.MutationObserver ? new doc.defaultView.MutationObserver(() => {
    // Blur can update unrelated content before Tab reaches its destination. Reclaim
    // focus only if the previous control actually disappeared.
    if (ownsSheetFocus(root) && !root.contains(doc.activeElement) && (!last.isConnected || !root.contains(last))) focusInside();
  }) : null;
  observer?.observe(root, { childList: true, subtree: true });
  if (root.contains(doc.activeElement)) last = doc.activeElement as HTMLElement;
  else root.focus({ preventScroll: true });
  updateSheetAccess();

  return () => {
    const wasTop = ownsSheetFocus(root);
    doc.removeEventListener('focusin', onFocus);
    doc.removeEventListener('keydown', onKey, true);
    observer?.disconnect();
    const index = sheets.lastIndexOf(root);
    if (index >= 0) sheets.splice(index, 1);
    restoreSheetAccess(root);
    updateSheetAccess();
    if (!wasTop) return;
    const parent = sheets.at(-1);
    const target = opener?.isConnected && (!parent || parent.contains(opener)) ? opener : parent;
    target?.focus({ preventScroll: true });
    if (parent && !parent.contains(doc.activeElement)) parent.focus({ preventScroll: true });
  };
}
