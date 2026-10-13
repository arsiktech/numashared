// TEMPORARY QA harness (delete before handoff): builds a 3-group or 5-single household through the store.
import { useEffect } from 'react';
import { View } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { addExpense, createHousehold, getState, recordSettlement, setGroups } from '@/store/store';
import type { Household } from '@/core/types';
import { T } from '@/ui/primitives';

const cur = (id: string) => getState().households.find((h) => h.id === id)!;
const pid = (h: Household, name: string) => h.people.find((p) => p.name === name)!.id;
const gid = (h: Household, name: string) => h.groups.find((g) => g.id === h.people.find((p) => p.name === name)!.groupId)!.id;
const ex = (id: string, payer: string, amount: number, title: string, category: 'groceries' | 'bills' | 'eating-out' | 'internet', note?: string) => {
  const h = cur(id);
  addExpense(h, { payerId: pid(h, payer), amount, date: new Date().toISOString().slice(0, 10), category, title, note,
    split: { mode: 'equal', groupIds: h.groups.map((g) => g.id), weighting: 'group' } }, title);
};

export default function Harness() {
  const { kind } = useLocalSearchParams<{ kind?: string }>();
  const router = useRouter();
  useEffect(() => {
    const id = createHousehold({ name: kind === '5' ? 'Flat 5' : 'Three groups', currency: 'EUR', youName: 'Ari', others: ['Sam', 'Alex', 'Jo', 'Mia'] });
    if (kind === 'sq') {
      const h0 = cur(id);
      addExpense(h0, { payerId: pid(h0, 'Ari'), amount: 2000, date: new Date().toISOString().slice(0, 10), category: 'groceries', title: 'Milk',
        split: { mode: 'equal', groupIds: h0.groups.slice(0, 2).map((g) => g.id), weighting: 'group' } }, 'Milk');
      const h1 = cur(id);
      recordSettlement(h1, { fromGroupId: gid(h1, 'Sam'), toGroupId: gid(h1, 'Ari'), amount: 1000, date: new Date().toISOString().slice(0, 10), method: 'cash' }, 'Repayment');
      setTimeout(() => router.replace('/home'), 100);
      return;
    }
    if (kind !== '5') {
      const h = cur(id);
      setGroups(id, [{ memberIds: [pid(h, 'Ari'), pid(h, 'Sam')] }, { memberIds: [pid(h, 'Alex'), pid(h, 'Jo')] }, { memberIds: [pid(h, 'Mia')] }]);
    }
    ex(id, 'Alex', 18000, 'Big shop', 'groceries', 'For the whole week');
    ex(id, 'Mia', 4500, 'Pizza night', 'eating-out');
    ex(id, 'Ari', 5000, 'Electricity', 'bills');
    if (kind === '5') ex(id, 'Jo', 12500, 'Internet', 'internet');
    const h = cur(id);
    recordSettlement(h, { fromGroupId: gid(h, 'Mia'), toGroupId: gid(h, 'Alex'), amount: 2000, date: new Date().toISOString().slice(0, 10), method: 'bizum', note: 'Part of the shop' }, 'Repayment');
    setTimeout(() => router.replace('/home'), 100);
  }, []);
  return <View style={{ padding: 40 }}><T>Building…</T></View>;
}
