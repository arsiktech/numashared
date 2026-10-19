import { Redirect } from 'expo-router';
import { activeHousehold, useStore } from '@/store/store';

export default function Index() {
  const h = useStore(activeHousehold);
  const locked = useStore((s) => s.locked && s.households.length > 0);
  if (locked) return <Redirect href="/welcome" />;
  return <Redirect href={h ? '/home' : '/welcome'} />;
}
