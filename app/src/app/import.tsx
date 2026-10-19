// Import a household from a Google Sheet: paste the sheet's link (shared as "anyone with the link
// can view"), check what was found and the balance it adds up to, say which person you are, then
// create it. Signed in, it is shared right away and the rest of the history uploads in the
// background; otherwise it stays on this phone until you share it.
import { useMemo, useState } from 'react';
import { View } from 'react-native';
import { useRouter } from 'expo-router';
import { formatMoney } from '@/core';
import { Warn } from '@/ui/icons';
import { Banner, BannerText, Chip, CTA, haptic, T } from '@/ui/primitives';
import { useTheme } from '@/ui/theme';
import { fonts, isWeb } from '@/ui/tokens';
import { Caption, Field, Label, Screen, ScreenHeader } from '@/features/onboarding/chrome';
import { explainFailure, SignInButtons, useSession, useSignInOptions } from '@/features/account/session';
import {
  balanceSummary, buildHousehold, exportUrl, htmlViewUrl, ImportError, parseCsv, sheetIdFromLink, tabKind,
  tabsFromHtmlView, titleFromHtmlView, type SheetImport,
} from '@/features/import/sheet';
import { putHousehold, switchHousehold } from '@/store/store';
import { showToast } from '@/store/ui';
import { failureOf } from '@/sync/engine';
import { turnOnSync } from '@/sync/runtime';

type Loaded = { title: string; expenses: string[][]; payments?: string[][] };

async function load(link: string): Promise<Loaded> {
  const id = sheetIdFromLink(link);
  if (!id) throw new ImportError('That isn’t a Google Sheets link. Copy it from the sheet’s Share button.');
  const get = async (url: string) => {
    const res = await fetch(url, { redirect: 'follow' });
    const text = await res.text();
    if (!res.ok || /<html[\s>]/i.test(text.slice(0, 400)) && !url.includes('htmlview')) {
      throw new ImportError('Google didn’t share the sheet. Set it to “Anyone with the link can view” and try again.');
    }
    return text;
  };
  const html = await get(htmlViewUrl(id));
  const tabs = tabsFromHtmlView(html);
  if (!tabs.length) throw new ImportError('Google didn’t share the sheet. Set it to “Anyone with the link can view” and try again.');
  let expenses: string[][] | undefined;
  let payments: string[][] | undefined;
  for (const tab of tabs) {
    const rows = parseCsv(await get(exportUrl(id, tab.gid)));
    const kind = tabKind(rows);
    if (kind === 'expenses' && !expenses) expenses = rows;
    if (kind === 'payments' && !payments) payments = rows;
  }
  if (!expenses) throw new ImportError('No tab with date, what, who and amount columns was found.');
  return { title: titleFromHtmlView(html), expenses, payments };
}

const day = (d?: Date) => (d ? d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) : '');

export default function ImportSheet() {
  const { c } = useTheme();
  const router = useRouter();
  const session = useSession();
  const signIn = useSignInOptions();
  const [link, setLink] = useState('');
  const [busy, setBusy] = useState<'reading' | 'creating' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [name, setName] = useState('');
  const [you, setYou] = useState<string | null>(null);
  const [created, setCreated] = useState<string | null>(null);

  const preview = useMemo<SheetImport | null>(() => {
    if (!loaded) return null;
    try {
      return buildHousehold({ name: name || loaded.title, expenses: loaded.expenses, payments: loaded.payments, youName: you ?? undefined });
    } catch (e) {
      setTimeout(() => setError(e instanceof Error ? e.message : 'The sheet couldn’t be read.'), 0);
      return null;
    }
  }, [loaded, name, you]);

  const read = async () => {
    if (busy) return;
    setBusy('reading'); setError(null); setLoaded(null);
    try {
      const l = await load(link.trim());
      setLoaded(l);
      setName((n) => n || l.title.slice(0, 40));
      haptic.success();
    } catch (e) {
      haptic.warn();
      setError(e instanceof ImportError ? e.message
        : isWeb ? 'Reading Google Sheets works in the Numa Shared app on your phone, not in the browser.'
          : 'Couldn’t reach Google. Check the connection and try again.');
    } finally { setBusy(null); }
  };

  const share = async (id: string) => {
    try {
      const serverId = await turnOnSync(id);
      showToast('Shared. The rest of the history is uploading.');
      router.replace('/home');
      return serverId;
    } catch (e) {
      setError(explainFailure(failureOf(e).code));
    }
  };

  const create = async () => {
    if (!preview || busy) return;
    setBusy('creating');
    const h = preview.household;
    putHousehold(h);
    switchHousehold(h.id);
    setCreated(h.id);
    haptic.success();
    if (session) await share(h.id);
    setBusy(null);
  };

  const balance = preview ? balanceSummary(preview.household) : null;
  const people = preview ? preview.household.people.map((p) => p.name) : [];
  const groups = preview ? preview.household.groups.map((g) => g.memberIds.map((id) => preview.household.people.find((p) => p.id === id)!.name).join(' + ')) : [];

  const footer = created ? (
    session ? null : <CTA variant="second" label="Not now, keep it on this phone" onPress={() => router.replace('/home')} />
  ) : preview ? (
    <CTA label={busy === 'creating' ? 'Creating…' : `Create ${(name || 'household').trim()}`} disabled={!!busy} onPress={create} />
  ) : (
    <CTA label={busy === 'reading' ? 'Reading the sheet…' : 'Read the sheet'} disabled={!link.trim() || !!busy} onPress={read} />
  );

  return (
    <Screen header={<ScreenHeader title="Import a sheet" />} footer={footer}>
      <T style={{ fontSize: 16, lineHeight: 22, color: c.ink2, marginTop: 12 }}>
        Bring a shared-expenses Google Sheet into Numa Shared: every expense and payment, with the same balance.
      </T>

      <Label nativeID="imp-link" style={{ marginTop: 22 }}>Google Sheets link</Label>
      <Field value={link} onChangeText={(v) => { setLink(v); setLoaded(null); setError(null); }} accessibilityLabel="Google Sheets link"
        placeholder="https://docs.google.com/spreadsheets/d/…" autoCapitalize="none" autoCorrect={false} keyboardType="url"
        returnKeyType="go" onSubmitEditing={read} editable={!created} />
      <Caption>The sheet needs “Anyone with the link can view”. It is read once, on this phone.</Caption>

      {error ? (
        <View style={{ marginTop: 16 }} accessibilityLiveRegion="polite">
          <Banner kind="warn" icon={<Warn size={18} color={c.warnInk} />}><BannerText kind="warn" rest={error} /></Banner>
        </View>
      ) : null}

      {preview ? (
        <View accessibilityLiveRegion="polite">
          <Label nativeID="imp-name" style={{ marginTop: 26 }}>Household name</Label>
          <Field value={name} onChangeText={setName} accessibilityLabel="Household name" maxLength={40} editable={!created} />

          <Label style={{ marginTop: 22 }}>Which one is you?</Label>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
            {people.map((n) => (
              <Chip key={n} label={n} on={(you ?? people[0]) === n} onPress={created ? undefined : () => { haptic.tick(); setYou(n); }} />
            ))}
          </View>

          <Label style={{ marginTop: 22 }}>Found in the sheet</Label>
          <View style={{ backgroundColor: c.card, borderRadius: 18, padding: 16, gap: 8 }}>
            <T style={{ fontSize: 16 }}>{preview.expenses} expenses and {preview.payments} payments</T>
            <T style={{ fontSize: 15, color: c.ink2 }}>{day(preview.from)} – {day(preview.to)}</T>
            <T style={{ fontSize: 15, color: c.ink2 }}>Groups: {groups.join('  ·  ')}</T>
            {balance ? (
              <T style={{ fontFamily: fonts.semibold, fontSize: 17, marginTop: 4 }}>
                {balance.owing} owe {balance.owed} {formatMoney(balance.cents, preview.currency)}
              </T>
            ) : <T style={{ fontFamily: fonts.semibold, fontSize: 17, marginTop: 4 }}>Everyone is square</T>}
            <T style={{ fontSize: 13.5, color: c.ink2 }}>Check this against the balance in your sheet before you create the household.</T>
          </View>

          {preview.skipped.length ? (
            <>
              <Label style={{ marginTop: 22 }}>{`Left out (${preview.skipped.length})`}</Label>
              <View style={{ backgroundColor: c.card, borderRadius: 18, padding: 16, gap: 6 }}>
                {preview.skipped.slice(0, 20).map((s) => (
                  <T key={`${s.tab}${s.row}`} style={{ fontSize: 14, color: c.ink2 }}>
                    Row {s.row}, {s.reason}: {s.text.slice(0, 80)}
                  </T>
                ))}
              </View>
            </>
          ) : null}
        </View>
      ) : null}

      {created && !session ? (
        <View style={{ marginTop: 24, gap: 12 }}>
          <T style={{ fontSize: 16, lineHeight: 22 }}>Created on this phone. Sign in to share it with everyone in it.</T>
          {signIn.any ? <SignInButtons verb="to share it" onSignedIn={() => { void share(created); }} /> : null}
        </View>
      ) : null}
    </Screen>
  );
}
