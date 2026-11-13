// The desk history: newest first, one row per record and a quiet line per edit or void, under a
// heading for each day. The same record row as the phone's Home, so amounts line up in a column.
import { useMemo, useState } from 'react';
import { ScrollView, View } from 'react-native';
import type { ID } from '@/core/types';
import { Press, T } from '@/ui/primitives';
import { useTheme } from '@/ui/theme';
import { space, text } from '@/ui/scale';
import { isWeb } from '@/ui/tokens';
import { RecordRow } from '../records';
import { DayStamp } from '../home/stamp';
import { useHousehold } from '../hooks';
import { dayLabel, sameDay, threadItems, type Filter } from './model';
import { closeHistorySearch, useHistoryQuery, useHistorySearchOpen } from './search';
import { EmptyThread, Filters, SearchField } from './thread';

const column = { width: '100%', maxWidth: 720, alignSelf: 'center' } as const;
/** Change lines start where row titles start: past the 40 pt tile and its gap. */
const titleInset = 40 + space[3];

export function DeskHistory({ selectedId, onSelect }: { selectedId: ID | null; onSelect: (id: ID) => void }) {
  const { h, ledger, hide } = useHousehold();
  const { ui } = useTheme();
  const [filter, setFilter] = useState<Filter>('all');
  const query = useHistoryQuery();
  const searchOpen = useHistorySearchOpen();
  const items = useMemo(() => (h && ledger ? threadItems(h, ledger.records, filter, query, hide).reverse() : []), [h, ledger, filter, query, hide]);
  if (!h || !ledger) return null;
  return (
    <View style={{ flex: 1, minHeight: 0 }}>
      <View style={{ paddingHorizontal: space[5], paddingTop: space[5], paddingBottom: space[2], gap: space[3] }}>
        <View style={[column, { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: space[4], flexWrap: 'wrap' }]}>
          <T accessibilityRole="header" style={text.heading}>History</T>
          <Filters filter={filter} setFilter={setFilter} />
        </View>
        {query || searchOpen ? (
          <View style={[column, { flexDirection: 'row' }]}>
            <SearchField query={query} autoFocus={searchOpen} onDone={closeHistorySearch} />
          </View>
        ) : null}
      </View>
      <ScrollView style={{ flex: 1 }} contentContainerStyle={{ paddingHorizontal: space[5], paddingBottom: space[6] }}>
        <View accessibilityRole={isWeb ? ('list' as never) : undefined} style={column}>
          {items.length ? items.map((it, i) => (
            <View key={it.key}>
              {i === 0 || !sameDay(items[i - 1].at, it.at) ? (
                <DayStamp label={dayLabel(it.at, true)} first={i === 0} />
              ) : null}
              {it.kind === 'change' ? (
                <Press noScale onPress={() => onSelect(it.record.id)} accessibilityLabel={`${it.text}. Open details`}
                  style={{ minHeight: 44, justifyContent: 'center', paddingLeft: titleInset }}>
                  <T style={[text.meta, { color: ui.muted }]}>{it.text}</T>
                </Press>
              ) : (
                <RecordRow h={h} r={it.record} hide={hide} day={it.at} selected={selectedId === it.record.id} onPress={() => onSelect(it.record.id)} />
              )}
            </View>
          )) : <EmptyThread empty={ledger.records.length === 0} query={query} filter={filter} shared={!!h.sync} />}
        </View>
      </ScrollView>
    </View>
  );
}
