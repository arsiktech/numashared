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
