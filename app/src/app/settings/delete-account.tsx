// Delete account (App Store guideline 5.1.1(v); docs/ACCOUNT-DELETION.md). First the server says
// what happens to each household, then one confirm deletes the account and removes its
// households from this phone. Households that live only on this phone stay.
import { useEffect, useState } from 'react';
import { View } from 'react-native';
import { Redirect, useRouter } from 'expo-router';
import { Warn } from '@/ui/icons';
import { Banner, BannerText, CTA, haptic, T } from '@/ui/primitives';
import { useTheme } from '@/ui/theme';
import { fonts } from '@/ui/tokens';
import { Caption } from '@/features/onboarding/chrome';
import { SettingsShell } from '@/features/settings/parts';
import { explainFailure, useSession } from '@/features/account/session';
import { getState } from '@/store/store';
import { failureOf } from '@/sync/engine';
import type { DeletionPreview } from '@/sync/accountDeletion';
import { outcomeText } from '@/features/settings/deletion';
import { accountDeletionPreview, deleteAccount, unsentCount } from '@/sync/runtime';

export default function DeleteAccountScreen() {
  const { c } = useTheme();
  const router = useRouter();
  const session = useSession();
  const [preview, setPreview] = useState<DeletionPreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const unsent = unsentCount();

  useEffect(() => {
    if (!session) return;
    accountDeletionPreview().then(setPreview, (e) => setError(explainFailure(failureOf(e).code)));
  }, [session]);

  if (!session && !busy) return <Redirect href="/settings" />;

  const confirm = async () => {
    setBusy(true);
    setError(null);
    try {
      await deleteAccount();
      haptic.success();
      router.replace(getState().households.length ? '/home' : '/welcome');
    } catch (e) {
      haptic.warn();
      setError(explainFailure(failureOf(e).code));
      setBusy(false);
    }
  };

  const footer = (
    <CTA variant="danger" label={busy ? 'Deleting…' : 'Delete my account'} disabled={busy || !preview} onPress={confirm}
      accessibilityLabel="Delete my account. This can’t be undone" />
  );

  return (
    <SettingsShell title="Delete account" back="Settings" active="account" footer={footer}>
      <T style={{ fontSize: 16, lineHeight: 22, color: c.ink2, marginTop: 8, paddingHorizontal: 4 }}>
        This deletes your Numa Shared account and signs you out on every device. It can’t be undone.
      </T>
      <T accessibilityRole="header" style={{ fontFamily: fonts.semibold, fontSize: 13, color: c.ink2, paddingTop: 18, paddingBottom: 8, paddingHorizontal: 4 }}>
        Your shared households
      </T>
      <View style={{ backgroundColor: c.card, borderRadius: 18, overflow: 'hidden' }} accessibilityLiveRegion="polite">
        {!preview && !error ? <T style={{ padding: 16, color: c.ink2 }}>Checking your households…</T> : null}
        {preview && preview.pots.length === 0 ? <T style={{ padding: 16, color: c.ink2 }}>You aren’t in any shared household.</T> : null}
        {preview?.pots.map((p, i) => (
          <T key={p.potId} style={{ padding: 16, fontSize: 15, lineHeight: 21, borderTopWidth: i ? 1 : 0, borderTopColor: c.hair }}>{outcomeText(p)}</T>
        ))}
      </View>
      {unsent > 0 ? (
        <View style={{ marginTop: 16 }}>
          <Banner kind="warn" icon={<Warn size={18} color={c.warnInk} />}>
            <BannerText kind="warn" strong={`${unsent} ${unsent === 1 ? 'change hasn’t' : 'changes haven’t'} reached the others yet.`} rest=" They’re lost if you delete now." />
          </Banner>
        </View>
      ) : null}
      {error ? (
        <View style={{ marginTop: 16 }} accessibilityLiveRegion="polite">
          <Banner kind="bad" icon={<Warn size={18} color={c.bad} />}><BannerText kind="bad" rest={error} /></Banner>
        </View>
      ) : null}
      <Caption style={{ marginTop: 12, lineHeight: 18 }}>
        Your notes and titles are erased everywhere. Amounts stay in the others’ history so their balances still add up.
      </Caption>
    </SettingsShell>
  );
}
