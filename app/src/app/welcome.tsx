// Temporary welcome used until the onboarding screens land.
import { View } from 'react-native';
import { useRouter } from 'expo-router';
import { loadSample } from '@/store/store';
import { CTA, T } from '@/ui/primitives';

export default function Welcome() {
  const router = useRouter();
  return (
    <View style={{ flex: 1, justifyContent: 'center', padding: 24, gap: 12 }}>
      <T>Numa Shared</T>
      <CTA label="Look around a sample household" onPress={() => { loadSample(); router.replace('/home'); }} />
    </View>
  );
}
