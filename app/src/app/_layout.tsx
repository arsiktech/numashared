import '../polyfills';
import { useEffect, useState } from 'react';
import { View } from 'react-native';
import { Stack } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import { useFonts } from 'expo-font';
import { setStatusBarStyle, StatusBar } from 'expo-status-bar';
import Animated, { runOnJS, useAnimatedReaction, useAnimatedStyle } from 'react-native-reanimated';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { hydrate } from '@/store/store';
import { startSyncRuntime } from '@/sync/runtime';
import { ThemeProvider, useTheme } from '@/ui/theme';
import { fontFiles } from '@/ui/tokens';
import { SheetHost } from '@/sheets/host';
import { sheetBackdrop } from '@/ui/sheet';
import { UndoLane } from '@/ui/lane';
import { Celebrate, Toast } from '@/ui/celebrate';

SplashScreen.preventAutoHideAsync().catch(() => {});

export default function RootLayout() {
  const [fontsLoaded, fontError] = useFonts(fontFiles);
  const [ready, setReady] = useState(false);
  useEffect(() => { hydrate().finally(() => { setReady(true); startSyncRuntime(); }); }, []);
  const go = ready && (fontsLoaded || !!fontError);
  useEffect(() => { if (go) SplashScreen.hideAsync().catch(() => {}); }, [go]);
  if (!go) return null;
  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <SafeAreaProvider>
        <ThemeProvider>
          <Shell />
        </ThemeProvider>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}

function Shell() {
  const { c, isDark } = useTheme();
  // While a sheet is up the screen behind shrinks onto black, so the status bar turns light.
  const statusFor = (up: boolean) => setStatusBarStyle(up || isDark ? 'light' : 'dark', true);
  useAnimatedReaction(() => sheetBackdrop.value > 0.5, (up, was) => { if (up !== was) runOnJS(statusFor)(up); }, [isDark]);
  const behind = useAnimatedStyle(() => ({
    borderRadius: 14 * sheetBackdrop.value,
    transform: [{ scale: 1 - 0.07 * sheetBackdrop.value }],
  }));
  return (
    <View style={{ flex: 1, backgroundColor: '#000000' }}>
      <StatusBar style={isDark ? 'light' : 'dark'} />
      <Animated.View style={[{ flex: 1, backgroundColor: c.bg, overflow: 'hidden' }, behind]}>
        <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: c.bg }, animation: 'default' }} />
      </Animated.View>
      <UndoLane />
      <SheetHost />
      <Celebrate />
      <Toast />
    </View>
  );
}
