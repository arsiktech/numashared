// Web-only feedback. Hidden unless the three public env values are set and the service says this
// app may send notes. A screenshot is taken on every screen the service's capture list allows.
import { useEffect, useRef, useState } from 'react';
import { Image, TextInput, View } from 'react-native';
import Svg, { Circle, Path } from 'react-native-svg';
import { usePathname } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { showToast } from '@/store/ui';
import { useStore } from '@/store/store';
import { Press, T } from '@/ui/primitives';
import { useTheme } from '@/ui/theme';
import { fonts, isWeb } from '@/ui/tokens';
import {
  captureFeedbackView, fetchFeedbackConfig, sendFeedback,
  type FeedbackCapture, type FeedbackCaptureConfig, type FeedbackMood,
} from './feedback-client';
import { feedbackContext, feedbackEndpoint, feedbackLocale, shouldCaptureFeedback } from './config';

const MOODS: readonly { id: FeedbackMood; label: string }[] = [
  { id: 'happy', label: 'Happy' },
  { id: 'neutral', label: 'Neutral' },
  { id: 'unhappy', label: 'Unhappy' },
  { id: 'exclamation', label: 'Exclamation' },
];

const endpoint = feedbackEndpoint();

export function FeedbackButton() {
  const { c, isDark, layout, width } = useTheme();
  const insets = useSafeAreaInsets();
  const pathname = usePathname();
  const last = useStore((s) => s.recent[s.recent.length - 1] ?? null);
  const [now, setNow] = useState(() => Date.now());
  const [config, setConfig] = useState<FeedbackCaptureConfig | null>(null);
  const [open, setOpen] = useState(false);
  const [note, setNote] = useState('');
  const [mood, setMood] = useState<FeedbackMood | null>(null);
  const [shot, setShot] = useState<FeedbackCapture | null>(null);
  const [sending, setSending] = useState(false);
  const rootRef = useRef<View>(null);
  const buttonRef = useRef<View>(null);
  const noteRef = useRef<TextInput>(null);
  const openRef = useRef(false);
  const sendRef = useRef<() => void>(() => {});
  const captureSeq = useRef(0);
  openRef.current = open;

  useEffect(() => {
    if (!isWeb || !endpoint) return;
    let cancel = false;
    fetchFeedbackConfig(endpoint).then((next) => { if (!cancel) setConfig(next); });
    return () => { cancel = true; };
  }, []);

  useEffect(() => {
    if (!last) return;
    const timer = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(timer);
  }, [last]);

  const close = () => {
    setOpen(false);
    const node = buttonRef.current as unknown as { focus?: () => void } | null;
    node?.focus?.();
  };

  const send = async () => {
    if (!endpoint || sending || !note.trim()) return;
    setSending(true);
    const path = pathname.startsWith('/') ? pathname : `/${pathname}`;
    const locale = feedbackLocale(typeof navigator === 'undefined' ? undefined : navigator.language);
    const result = await sendFeedback(endpoint, {
      note,
      path,
      ...(locale ? { locale } : {}),
      ...(mood ? { mood } : {}),
      ...(shot ? { shot } : {}),
      context: feedbackContext(isDark ? 'dark' : 'light'),
    });
    setSending(false);
    if (!result.ok) { showToast('Couldn’t send'); return; }
    setNote('');
    setMood(null);
    setShot(null);
    close();
    showToast('Sent');
  };
  sendRef.current = () => { void send(); };

  useEffect(() => {
    if (!isWeb || typeof window === 'undefined') return;
    const onKey = (e: KeyboardEvent) => {
      if (!openRef.current) return;
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopImmediatePropagation();
        close();
      } else if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        e.stopImmediatePropagation();
        sendRef.current();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, []);

  useEffect(() => {
    if (!open || !isWeb || typeof window === 'undefined') return;
    const onPointer = (e: PointerEvent) => {
      const root = rootRef.current as unknown as HTMLElement | null;
      if (root && e.composedPath().includes(root)) return;
      close();
    };
    window.addEventListener('pointerdown', onPointer, true);
    const frame = requestAnimationFrame(() => noteRef.current?.focus());
    return () => {
      window.removeEventListener('pointerdown', onPointer, true);
      cancelAnimationFrame(frame);
    };
  }, [open]);

  if (!isWeb || !endpoint || !config?.enabled) return null;

  const path = pathname.startsWith('/') ? pathname : `/${pathname}`;
  const undoUp = !!last && now - last.at < 8000;
  const bottom = insets.bottom + (undoUp && layout === 'phone' ? 84 : 16);
  const panelWidth = Math.min(320, Math.max(240, width - 32));

  const toggle = () => {
    if (open) { close(); return; }
    setOpen(true);
    if (!shouldCaptureFeedback(config, path)) return;
    const seq = ++captureSeq.current;
    captureFeedbackView().then((next) => {
      if (captureSeq.current === seq) setShot(next);
    });
  };

  const removeShot = () => {
    captureSeq.current += 1;
    setShot(null);
  };

  return (
    <View ref={rootRef} pointerEvents="box-none" style={{ position: 'absolute', left: 16, bottom, zIndex: 40, width: panelWidth }}>
      {open ? (
        <View
          {...{ dataSet: { fbSelf: true }, role: 'dialog' }}
          accessibilityLabel="Feedback"
          style={{
            marginBottom: 8, backgroundColor: c.card, borderRadius: 18, borderWidth: 1, borderColor: c.hair, padding: 12, gap: 10,
            shadowColor: '#1E2420', shadowOpacity: 0.16, shadowRadius: 24, shadowOffset: { width: 0, height: 12 },
          }}
        >
          <TextInput
            ref={noteRef}
            value={note}
            onChangeText={setNote}
            multiline
            maxLength={2000}
            accessibilityLabel="Feedback"
            style={[{
              minHeight: 96, maxHeight: 180, borderRadius: 12, borderWidth: 1, borderColor: c.hair, backgroundColor: c.bg,
              paddingHorizontal: 12, paddingTop: 10, paddingBottom: 10, fontFamily: fonts.regular, fontSize: 16, color: c.ink,
              textAlignVertical: 'top',
            }, { outlineStyle: 'none' } as object]}
          />
          {shot ? (
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
              <View>
                <Image source={{ uri: shot.dataUrl }} accessibilityLabel="Screenshot" style={{ width: 96, height: 64, borderRadius: 8, backgroundColor: c.chip }} />
                <Press accessibilityLabel="Remove screenshot" onPress={removeShot}
                  style={{ position: 'absolute', right: -8, top: -8, width: 28, height: 28, borderRadius: 14, backgroundColor: c.ink, alignItems: 'center', justifyContent: 'center' }}>
                  <T style={{ color: c.bg, fontFamily: fonts.semibold, fontSize: 16, lineHeight: 18 }}>×</T>
                </Press>
              </View>
              <T style={{ flex: 1, fontSize: 13, lineHeight: 17, color: c.ink2 }}>Others on the team can see this screenshot.</T>
            </View>
          ) : null}
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
            {MOODS.map((item) => {
              const on = mood === item.id;
              return (
                <Press key={item.id} accessibilityLabel={item.label} accessibilityState={{ selected: on }}
                  onPress={() => setMood(on ? null : item.id)}
                  style={{ width: 36, height: 36, borderRadius: 18, alignItems: 'center', justifyContent: 'center', backgroundColor: on ? c.ink : c.chip }}>
                  <Face kind={item.id} color={on ? c.bg : c.ink} />
                </Press>
              );
            })}
            <View style={{ flex: 1 }} />
            <Press accessibilityLabel="Send" disabled={sending || !note.trim()} onPress={sending || !note.trim() ? undefined : () => { void send(); }}
              style={{ height: 36, paddingHorizontal: 16, borderRadius: 18, alignItems: 'center', justifyContent: 'center', backgroundColor: note.trim() && !sending ? c.ink : c.chip }}>
              <T style={{ fontFamily: fonts.semibold, fontSize: 15, color: note.trim() && !sending ? c.bg : c.ink3 }}>Send</T>
            </Press>
          </View>
        </View>
      ) : null}
      <Press ref={buttonRef} accessibilityLabel="Feedback" accessibilityState={{ expanded: open }} onPress={toggle}
        style={{ alignSelf: 'flex-start', height: 40, paddingLeft: 12, paddingRight: 14, borderRadius: 20, backgroundColor: c.card, borderWidth: 1, borderColor: c.hair,
          flexDirection: 'row', alignItems: 'center', gap: 8,
          shadowColor: '#1E2420', shadowOpacity: 0.08, shadowRadius: 12, shadowOffset: { width: 0, height: 6 } }}>
        <Bubble color={c.ink} />
        <T style={{ fontFamily: fonts.semibold, fontSize: 15 }}>Feedback</T>
      </Press>
    </View>
  );
}

function Bubble({ color }: { color: string }) {
  return (
    <Svg width={18} height={18} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" {...hidden()}>
      <Path d="M5 6.5A2.5 2.5 0 0 1 7.5 4h9A2.5 2.5 0 0 1 19 6.5v7A2.5 2.5 0 0 1 16.5 16H12l-4 3.5V16H7.5A2.5 2.5 0 0 1 5 13.5z" />
    </Svg>
  );
}

function Face({ kind, color }: { kind: FeedbackMood; color: string }) {
  const box = { width: 22, height: 22, viewBox: '0 0 24 24', fill: 'none' as const, stroke: color, strokeWidth: 1.8, strokeLinecap: 'round' as const, ...hidden() };
  if (kind === 'exclamation') {
    return (
      <Svg {...box}>
        <Circle cx="12" cy="12" r="9" />
        <Path d="M12 7.5v6" />
        <Circle cx="12" cy="16.6" r="0.9" fill={color} stroke="none" />
      </Svg>
    );
  }
  const mouth = kind === 'happy' ? 'M8 13.2c1.1 1.7 2.5 2.4 4 2.4s2.9-.7 4-2.4'
    : kind === 'unhappy' ? 'M8 16c1.1-1.7 2.5-2.4 4-2.4s2.9.7 4 2.4'
      : 'M8.5 14.5h7';
  return (
    <Svg {...box}>
      <Circle cx="12" cy="12" r="9" />
      <Circle cx="9" cy="10" r="0.9" fill={color} stroke="none" />
      <Circle cx="15" cy="10" r="0.9" fill={color} stroke="none" />
      <Path d={mouth} />
    </Svg>
  );
}

function hidden() {
  return isWeb ? ({ 'aria-hidden': true } as object) : { accessibilityElementsHidden: true, importantForAccessibility: 'no-hide-descendants' as const };
}
