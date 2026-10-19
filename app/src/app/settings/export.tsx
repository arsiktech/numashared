// Export CSV: pick the household and range, see what's included and a preview of the first lines,
// then share the file (native) or download it (web).
import { useMemo, useState } from 'react';
import { Platform, View } from 'react-native';
import { File, Paths } from 'expo-file-system';
import * as Sharing from 'expo-sharing';
import { Redirect } from 'expo-router';
import { useStore } from '@/store/store';
import { showToast } from '@/store/ui';
import { Check, Download } from '@/ui/icons';
import { CTA, haptic, T } from '@/ui/primitives';
import { useTheme } from '@/ui/theme';
import { fonts, isWeb } from '@/ui/tokens';
import { useHousehold } from '@/features/hooks';
import { Caption, Label, Segmented, Select } from '@/features/onboarding/chrome';
import { SettingsShell, usePillBg } from '@/features/settings/parts';
import { buildCsv, csvFileName, recordsInRange, type Range } from '@/features/settings/csv';

const INCLUDED = ['Every expense and repayment', 'Every edit, with old and new values', 'Voids and their reasons', 'Who added what'];
const mono = Platform.select({ ios: 'Menlo', android: 'monospace', default: 'ui-monospace, Menlo, Consolas, monospace' });

/** "numa-shared-home.csv" becomes "numa-shared-home-2026-10-19.csv" (local date). */
function datedName(name: string, now = new Date()) {
  const pad = (n: number) => String(n).padStart(2, '0');
  const day = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  return name.replace(/\.csv$/, `-${day}.csv`);
}

export default function ExportScreen() {
  const { h: active } = useHousehold();
  const { c } = useTheme();
  const households = useStore((s) => s.households);
  const [pick, setPick] = useState<string | null>(null);
  const [range, setRange] = useState<Range>('all');
  const track = usePillBg();
  const h = households.find((x) => x.id === (pick ?? active?.id)) ?? active;
  const { csv, count } = useMemo(() => {
    if (!h) return { csv: '', count: 0 };
    const records = recordsInRange(h, range);
    return { csv: buildCsv(h, records), count: records.length };
  }, [h, range]);
  if (!h) return <Redirect href="/welcome" />;
  const preview = csv.split('\n').slice(0, 4);

  const run = async () => {
    if (!count) return;
    const name = datedName(csvFileName(h));
    if (isWeb) {
      const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = name;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      showToast(`Downloaded ${name}`);
      return;
    }
    try {
      if (!(await Sharing.isAvailableAsync())) throw new Error('sharing unavailable');
      const file = new File(Paths.cache, name);
      file.create({ overwrite: true });
      file.write(csv);
      await Sharing.shareAsync(file.uri, { mimeType: 'text/csv', UTI: 'public.comma-separated-values-text', dialogTitle: name });
      haptic.success();
    } catch {
      showToast('Couldn’t open sharing on this device.');
    }
  };

  const footer = (
    <CTA label={count ? `Export ${count} ${count === 1 ? 'record' : 'records'}` : 'Nothing to export'} disabled={!count} onPress={run}
      icon={<Download size={20} color={count ? c.bg : c.ink3} />} />
  );

  return (
    <SettingsShell title="Export CSV" back="Settings" active="data" footer={footer}>
      <View style={{ paddingHorizontal: 0 }}>
        <Label style={{ marginTop: 8 }}>Household</Label>
        <Select label="Household" value={h.id} onChange={setPick} disabled={households.length < 2} right={households.length < 2 ? <View /> : undefined}
          options={households.map((x) => ({ value: x.id, label: x.name }))} />
        <Label>Range</Label>
        <Segmented label="Range" value={range} onChange={setRange} track={track === c.card ? c.chip2 : undefined}
          options={[{ value: 'month', label: 'This month' }, { value: 'all', label: 'All time' }]} />
        <T accessibilityRole="header" style={{ fontFamily: fonts.semibold, fontSize: 13, color: c.ink2, paddingTop: 18, paddingBottom: 8, paddingHorizontal: 4 }}>Included</T>
        <View style={{ backgroundColor: c.card, borderRadius: 18, overflow: 'hidden' }}>
          {INCLUDED.map((label, i) => (
            <View key={label} accessible accessibilityLabel={`Included: ${label}`}
              style={{ flexDirection: 'row', alignItems: 'center', gap: 14, minHeight: 48, paddingVertical: 10, paddingHorizontal: 16,
                borderBottomWidth: i === INCLUDED.length - 1 ? 0 : 1, borderBottomColor: c.hair }}>
              <View style={{ width: 22, height: 22, borderRadius: 6, backgroundColor: c.ink, alignItems: 'center', justifyContent: 'center' }}>
                <Check size={15} color={c.bg} />
              </View>
              <T style={{ flex: 1, fontSize: 16 }}>{label}</T>
            </View>
          ))}
        </View>
        <Caption style={{ marginTop: 10, lineHeight: 18 }}>Amounts are exact to the cent. Opens in Numbers, Excel or Google Sheets.</Caption>
        <View accessible accessibilityLabel={`Preview of the file: ${preview.join('. ')}`}
          style={{ marginTop: 16, backgroundColor: c.card, borderRadius: 18, padding: 14 }}>
          {preview.map((line, i) => (
            <T key={i} numberOfLines={1} ellipsizeMode="clip" style={{ fontFamily: mono, fontSize: 11, lineHeight: 17, color: c.ink2 }}>{line}</T>
          ))}
          {count === 0 ? <T style={{ fontSize: 13, color: c.ink2, marginTop: 4 }}>No records in this range.</T> : null}
        </View>
      </View>
    </SettingsShell>
  );
}
