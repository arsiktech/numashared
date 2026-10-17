// Invite links (https://…/join/<token>?code=<CODE>, or /join/<CODE>) open the Join screen with
// the invite filled in.
import { Redirect, useLocalSearchParams } from 'expo-router';

export default function JoinLink() {
  const { credential, code } = useLocalSearchParams<{ credential: string; code?: string }>();
  const link = code ? `/join/${credential}?code=${code}` : String(credential ?? '');
  return <Redirect href={{ pathname: '/join', params: { link } }} />;
}
