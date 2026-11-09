// Share text through the system share sheet. Browsers without a share sheet copy it instead.
import { Share } from 'react-native';
import { showToast } from '@/store/ui';
import { isWeb } from '@/ui/tokens';

export async function shareText(message: string, copiedToast: string, title?: string) {
  try {
    await Share.share(title ? { message, title } : { message });
  } catch (e) {
    if ((e as Error)?.name === 'AbortError') return; // the person closed the share sheet
    const clip = isWeb ? (globalThis.navigator as Navigator | undefined)?.clipboard : undefined;
    if (clip) {
      try { await clip.writeText(message); showToast(copiedToast); return; } catch { /* fall through */ }
    }
    showToast('Couldn’t open sharing on this device.');
  }
}

/** Copies text on the web; elsewhere opens the share sheet, which offers Copy. Resolves true when it went somewhere. */
export async function copyText(message: string, copiedToast: string): Promise<boolean> {
  const clip = isWeb ? (globalThis.navigator as Navigator | undefined)?.clipboard : undefined;
  if (clip) {
    try { await clip.writeText(message); showToast(copiedToast); return true; } catch { /* fall through */ }
  }
  try {
    const result = await Share.share({ message });
    return result.action !== Share.dismissedAction;
  } catch {
    showToast('Couldn’t copy on this device.');
    return false;
  }
}
