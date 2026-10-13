import { useEffect, useState } from 'react';
import { View } from 'react-native';
import { Stack } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import { useFonts } from 'expo-font';
import { StatusBar } from 'expo-status-bar';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { hydrate } from '@/store/store';
import { ThemeProvider, useTheme } from '@/ui/theme';
import { fontFiles } from '@/ui/tokens';
import { SheetHost } from '@/sheets/host';
import { UndoLane } from '@/ui/lane';
import { Celebrate, Toast } from '@/ui/celebrate';

SplashScreen.preventAutoHideAsync().catch(() => {});

export default function RootLayout() {
  const [fontsLoaded, fontError] = useFonts(fontFiles);
  const [ready, setReady] = useState(false);
  useEffect(() => { hydrate().finally(() => setReady(true)); }, []);
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
  return (
    <View style={{ flex: 1, backgroundColor: c.bg }}>
      <StatusBar style={isDark ? 'light' : 'dark'} />
      <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: c.bg }, animation: 'default' }} />
      <UndoLane />
      <SheetHost />
      <Celebrate />
      <Toast />
    </View>
  );
}
