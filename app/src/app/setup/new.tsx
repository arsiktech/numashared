// New household: a name, the currency, and who lives there. Everyone starts in a group of their
// own; the next screen pairs people up.
import { useRef, useState } from 'react';
import { TextInput, View } from 'react-native';
import { useRouter } from 'expo-router';
import { MAX_GROUPS } from '@/core/types';
import { createHousehold } from '@/store/store';
import { Close, Plus } from '@/ui/icons';
import { CTA, IconButton, ListCard, Press, T } from '@/ui/primitives';
import { useTheme } from '@/ui/theme';
import { fonts, isWeb } from '@/ui/tokens';
import { Caption, Field, Label, Screen, ScreenHeader, Select } from '@/features/onboarding/chrome';
import { CURRENCIES, currencyLabel } from '@/features/onboarding/model';

type Row = { key: number; name: string };

export default function NewHousehold() {
  const router = useRouter();
  const { c } = useTheme();
  const [name, setName] = useState('Our place');
  const [currency, setCurrency] = useState('EUR');
  const [youName, setYouName] = useState('');
  const [others, setOthers] = useState<Row[]>([{ key: 1, name: '' }]);
  const seq = useRef(2);
  const inputs = useRef(new Map<number, TextInput | null>());
  const full = others.length + 1 >= MAX_GROUPS;
  const title = name.trim() || 'Our place';

  const add = () => {
    if (full) return;
    const key = seq.current++;
    setOthers((o) => [...o, { key, name: '' }]);
    setTimeout(() => inputs.current.get(key)?.focus(), 50);
  };

  const [problem, setProblem] = useState('');
  const youInput = useRef<TextInput | null>(null);
  const made = useRef(false);
  const create = () => {
    if (made.current) return;
    const named = others.map((o) => o.name.trim()).filter(Boolean);
    if (!youName.trim()) { setProblem('Type your name, so the others know who paid.'); youInput.current?.focus(); return; }
    if (!named.length) {
      setProblem('Add at least one person to share costs with.');
      inputs.current.get(others[0]?.key ?? -1)?.focus();
      if (!others.length) add();
      return;
    }
    made.current = true;
    createHousehold({ name: title, currency, youName: youName.trim(), others: named });
    router.replace('/setup/groups?first=1');
  };

  return (
    <Screen header={<ScreenHeader title="New household" />}
      footer={<CTA label="Create household" accessibilityLabel={`Create household ${title}`} onPress={create} />}>
      <Label nativeID="nh-name" style={{ marginTop: 22 }}>Name</Label>
      <Field value={name} onChangeText={setName} accessibilityLabel="Household name"
        placeholder="Our place" returnKeyType="next" autoCapitalize="words" maxLength={40} />

      <Label>Currency</Label>
      <Select label="Currency" value={currency} onChange={setCurrency}
        options={CURRENCIES.map((x) => ({ value: x.code, label: currencyLabel(x.code) }))} />
      <Caption>Fixed once the first expense is added.</Caption>

      <Label>Who lives here?</Label>
      <ListCard>
        <PersonRow initial="Y" value={youName} onChange={(v) => { setYouName(v); setProblem(''); }} inputRef={(r) => { youInput.current = r; }}
          placeholder="Your name" suffix="(you)" label="Your name" />
        {others.map((o, i) => (
          <PersonRow key={o.key} inputRef={(r) => { inputs.current.set(o.key, r); }}
            initial={(o.name.trim() || '?').slice(0, 1).toUpperCase()} value={o.name}
            onChange={(v) => { setProblem(''); setOthers((all) => all.map((x) => (x.key === o.key ? { ...x, name: v } : x))); }}
            placeholder={i === 0 ? 'Someone you live with' : 'Name'} label={`Person ${i + 2} name`}
            onSubmit={() => (i === others.length - 1 && o.name.trim() ? add() : undefined)}
            onRemove={() => setOthers((all) => all.filter((x) => x.key !== o.key))} />
        ))}
        {!full ? <AddRow onPress={add} /> : null}
      </ListCard>
      {problem ? <T accessibilityRole="alert" style={{ fontFamily: fonts.semibold, fontSize: 14, lineHeight: 20, color: c.bad, marginTop: 10 }}>{problem}</T> : null}
      <Caption>{full ? `Up to ${MAX_GROUPS} people for now. ` : ''}Next, you choose who shares money, like a couple.</Caption>
    </Screen>
  );
}

function PersonRow({ initial, value, onChange, placeholder, suffix, label, onRemove, onSubmit, inputRef }: {
  initial: string; value: string; onChange: (v: string) => void; placeholder: string; suffix?: string; label: string;
  onRemove?: () => void; onSubmit?: () => void; inputRef?: (r: TextInput | null) => void;
}) {
  const { c } = useTheme();
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12, minHeight: 52, paddingLeft: 16, paddingRight: onRemove ? 4 : 16,
      borderBottomWidth: 1, borderBottomColor: c.hair }}>
      <View style={{ width: 32, height: 32, borderRadius: 16, backgroundColor: c.chip, alignItems: 'center', justifyContent: 'center' }}>
        <T style={{ fontFamily: fonts.bold, fontSize: 13 }}>{initial}</T>
      </View>
      <TextInput ref={inputRef} value={value} onChangeText={onChange} placeholder={placeholder} placeholderTextColor={c.ink3}
        accessibilityLabel={label} autoCapitalize="words" maxLength={24} returnKeyType="next" onSubmitEditing={onSubmit}
        selectionColor={c.ink} blurOnSubmit={false}
        style={[{ flex: 1, fontFamily: fonts.regular, fontSize: 16, color: c.ink, paddingVertical: 14, minWidth: 0 },
          isWeb ? ({ outlineStyle: 'none' } as object) : null]} />
      {suffix ? <T style={{ fontSize: 16, color: c.ink2 }}>{suffix}</T> : null}
      {onRemove ? (
        <IconButton label={`Remove ${value.trim() || 'this person'}`} onPress={onRemove}><Close size={18} color={c.ink3} /></IconButton>
      ) : null}
    </View>
  );
}

function AddRow({ onPress }: { onPress: () => void }) {
  const { c } = useTheme();
  return (
    <Press noScale onPress={onPress} accessibilityLabel="Add someone"
      style={{ flexDirection: 'row', alignItems: 'center', gap: 12, minHeight: 52, paddingHorizontal: 16 }}>
      <View style={{ width: 32, height: 32, borderRadius: 16, borderWidth: 1.5, borderColor: c.ink2, alignItems: 'center', justifyContent: 'center' }}>
        <Plus size={16} color={c.ink2} />
      </View>
      <T style={{ fontSize: 16, fontFamily: fonts.medium, color: c.ink2 }}>Add someone</T>
    </Press>
  );
}
