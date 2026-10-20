import { useEffect, useState } from 'react';
import { View } from 'react-native';
import { useStore } from '@/store/store';
import { Checks, Clock, CloudOff, Warn } from '@/ui/icons';
import { Press, T } from '@/ui/primitives';
import { useTheme } from '@/ui/theme';
import { fonts } from '@/ui/tokens';
import { online, useSyncStatus } from '@/sync/runtime';
import { putHousehold } from '@/store/store';
import { explainFailure } from '../account/session';
import { useHousehold } from '../hooks';

/** One quiet line under "Latest" that says where the data is. */
export function SyncLine() {
  const { c } = useTheme();
  const { h } = useHousehold();
  const recent = useStore((s) => s.recent);
  const status = useSyncStatus();
  // Re-render when the undo window closes, so the line doesn't keep promising an undo.
  const latest = h ? Math.max(0, ...recent.filter((r) => r.householdId === h.id).map((r) => r.at)) : 0;
  const [, tick] = useState(0);
  useEffect(() => {
    const left = latest + 8000 - Date.now();
    if (left <= 0) return;
    const t = setTimeout(() => tick((n) => n + 1), left + 50);
    return () => clearTimeout(t);
  }, [latest]);
  if (!h) return null;
  const undoOpen = Date.now() - latest < 8000;
  const queued = h.events.filter((e) => e.seq === undefined).length;
  const rejected = h.sync?.rejected ?? [];

  let icon = <Checks size={15} color={c.ink2} />;
  let text = 'Saved on this device';
  let onPress: (() => void) | undefined;
  let a11y: string | undefined;
  if (undoOpen) {
    icon = <Clock size={15} color={c.ink2} />;
    text = 'Saved · Undo is open for a few seconds';
  } else if (h.sync?.paused) {
    icon = <Warn size={15} color={c.warnInk} />;
    text = `Sync paused: ${explainFailure(h.sync.paused.code)} Tap to try again`;
    onPress = () => { void online.retry(h); };
    a11y = 'Sync paused. Try again';
  } else if (h.sync && (!status.signedIn || !status.connected) && (queued > 0 || h.sync.setup)) {
    icon = <CloudOff size={15} color={c.ink2} />;
    text = status.signedIn ? `Offline · ${queued || 'Changes'} waiting to send` : 'Signed out · changes wait on this phone';
  } else if (h.sync && queued > 0 && status.throttled?.split(',').includes(h.id)) {
    icon = <Clock size={15} color={c.ink2} />;
    text = `${queued} changes left to upload. The server takes 2,000 an hour, so the rest follow by themselves.`;
  } else if (h.sync && (queued > 0 || h.sync.setup)) {
    icon = <Clock size={15} color={c.ink2} />;
    text = queued > 1 ? `Sending ${queued} changes…` : 'Sending…';
  } else if (h.sync) {
    text = status.connected ? 'Shared · everyone sees the same' : 'Shared · last synced on this phone';
  }

  const line = (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, minHeight: 22 }} accessibilityLiveRegion="polite">
      {icon}
      <T style={{ fontSize: 13, color: c.ink2, fontFamily: fonts.medium, flexShrink: 1 }}>{text}</T>
    </View>
  );

  return (
    <View>
      {onPress ? <Press noScale onPress={onPress} accessibilityLabel={a11y} style={{ minHeight: 44, justifyContent: 'center' }}>{line}</Press> : line}
      {rejected.length ? (
        <Press noScale accessibilityLabel={`${rejected.length} change${rejected.length > 1 ? 's' : ''} couldn’t be saved. Dismiss`}
          onPress={() => putHousehold({ ...h, sync: { ...h.sync!, rejected: [] } })}
          style={{ marginTop: 6, padding: 12, borderRadius: 14, backgroundColor: c.warnBg, gap: 2 }}>
          <T style={{ fontFamily: fonts.semibold, fontSize: 14, color: c.warnInk }}>
            {rejected.length === 1 ? `${rejected[0].label} couldn’t be saved` : `${rejected.length} changes couldn’t be saved`}
          </T>
          <T style={{ fontSize: 13, color: c.warnInk }}>Someone changed the same thing at the same time. Check the history and add it again if needed. Tap to dismiss.</T>
        </Press>
      ) : null}
    </View>
  );
}
