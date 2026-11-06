// AI agents: let an assistant (Claude, ChatGPT, Cursor, any MCP client) read this person's
// households. The link is made on the phone and shown once; only its hash reaches the server.
// A connection can only read. It cannot add, change or delete anything, and it never moves money.
import { useCallback, useEffect, useState } from 'react';
import { Share, View } from 'react-native';
import { Redirect } from 'expo-router';
import { Warn } from '@/ui/icons';
import { Banner, BannerText, CTA, haptic, Press, T } from '@/ui/primitives';
import { useTheme } from '@/ui/theme';
import { fonts } from '@/ui/tokens';
import { Caption, Field, Label, Select } from '@/features/onboarding/chrome';
import { SettingsShell } from '@/features/settings/parts';
import { relativeDay, useHousehold } from '@/features/hooks';
import { explainFailure } from '@/features/account/session';
import { failureOf } from '@/sync/engine';
import { agents, type AgentActivity, type AgentConnection } from '@/sync/runtime';

const ALL = 'all';

export default function AgentsScreen() {
  const { c } = useTheme();
  const { h } = useHousehold();
  const [list, setList] = useState<AgentConnection[] | undefined>(undefined);
  const [activity, setActivity] = useState<AgentActivity[]>([]);
  const [name, setName] = useState('');
  const [scope, setScope] = useState<string>(ALL);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [link, setLink] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!h?.sync || h.sync.setup) return;
    try {
      const [connections, recent] = await Promise.all([agents.list(), agents.activity()]);
      setList(connections);
      setActivity(recent.slice(0, 8));
    } catch (e) { setError(explainFailure(failureOf(e).code)); }
  }, [h?.sync]);
  useEffect(() => { void refresh(); }, [refresh]);

  if (!h) return <Redirect href="/welcome" />;
  if (!h.sync || h.sync.setup) {
    return (
      <SettingsShell title="AI agents" back="Settings" active="household">
        <T style={{ fontSize: 16, lineHeight: 22, color: c.ink2, marginTop: 12 }}>Share {h.name} first. Agents connect to your account, so you need to be signed in with a shared household.</T>
      </SettingsShell>
    );
  }

  const connect = async () => {
    setBusy(true); setError(null);
    try {
      const made = await agents.connect(name.trim() || 'My agent', scope === ALL ? null : h.id);
      setLink(made.link); setName('');
      haptic.success();
      await refresh();
    } catch (e) { haptic.warn(); setError(explainFailure(failureOf(e).code)); }
    finally { setBusy(false); }
  };
  const disconnect = async (id: string) => {
    setBusy(true); setError(null);
    try { await agents.disconnect(id); await refresh(); } catch (e) { setError(explainFailure(failureOf(e).code)); }
    finally { setBusy(false); }
  };

  const footer = link ? (
    <CTA label="Share the link" onPress={() => { void Share.share({ message: link }); }} />
  ) : (
    <CTA label={busy ? 'Connecting…' : 'Connect an agent'} disabled={busy} onPress={() => { void connect(); }} />
  );

  return (
    <SettingsShell title="AI agents" back="Settings" active="household" footer={footer}>
      <T style={{ fontSize: 16, lineHeight: 22, color: c.ink2, marginTop: 8, paddingHorizontal: 4 }}>
        An agent you connect can read who paid, who owes whom and the records in your households. It can’t add, change or delete anything, and Numa Shared never moves money.
      </T>

      {error ? (
        <View style={{ marginTop: 16 }} accessibilityLiveRegion="polite">
          <Banner kind="warn" icon={<Warn size={18} color={c.warnInk} />}><BannerText kind="warn" rest={error} /></Banner>
        </View>
      ) : null}

      {link ? (
        <View style={{ marginTop: 18, backgroundColor: c.card, borderRadius: 18, padding: 16, gap: 10 }} accessibilityLiveRegion="polite">
          <T style={{ fontFamily: fonts.semibold, fontSize: 16 }}>Your agent link</T>
          <T selectable style={{ fontFamily: fonts.semibold, fontSize: 13, letterSpacing: 0.2 }}>{link}</T>
          <T style={{ fontSize: 14, lineHeight: 20, color: c.ink2 }}>
            Paste it into your agent as an MCP server. Anyone with this link can read your households, so keep it private. It’s shown only now. If you lose it, disconnect the agent and make a new one.
          </T>
          <Press onPress={() => setLink(null)} accessibilityRole="button" style={{ minHeight: 44, justifyContent: 'center', alignSelf: 'flex-start' }}>
            <T style={{ fontFamily: fonts.semibold, fontSize: 15, textDecorationLine: 'underline' }}>Done</T>
          </Press>
        </View>
      ) : (
        <View style={{ marginTop: 18, gap: 4 }}>
          <Label>Name</Label>
          <Field value={name} onChangeText={setName} maxLength={60} placeholder="Claude, ChatGPT…" accessibilityLabel="Agent name" />
          <Label>It can read</Label>
          <Select label="It can read" value={scope} onChange={setScope}
            options={[{ value: ALL, label: 'All my households' }, { value: h.id, label: `Only ${h.name}` }]} />
        </View>
      )}

      {list && list.length > 0 ? (
        <View style={{ marginTop: 22, gap: 10 }}>
          <Label>Connected</Label>
          <View style={{ backgroundColor: c.card, borderRadius: 18, overflow: 'hidden' }}>
            {list.map((agent, i) => (
              <View key={agent.id} style={{ padding: 16, gap: 4, borderTopWidth: i ? 1 : 0, borderTopColor: c.hair }}>
                <T style={{ fontFamily: fonts.semibold, fontSize: 16 }}>{agent.name}</T>
                <T style={{ fontSize: 14, color: c.ink2 }}>
                  {agent.potId ? `Only ${agent.potId === h.id ? h.name : 'one household'}` : 'All my households'}
                  {` · ${agent.lastUsedAt ? `used ${relativeDay(agent.lastUsedAt).toLowerCase()}` : 'not used yet'}`}
                </T>
                <Press onPress={busy ? undefined : () => { void disconnect(agent.id); }} accessibilityRole="button" accessibilityLabel={`Disconnect ${agent.name}`}
                  style={{ minHeight: 44, justifyContent: 'center', alignSelf: 'flex-start' }}>
                  <T style={{ fontFamily: fonts.semibold, fontSize: 15, color: c.bad, textDecorationLine: 'underline' }}>Disconnect</T>
                </Press>
              </View>
            ))}
          </View>
        </View>
      ) : null}

      {activity.length > 0 ? (
        <View style={{ marginTop: 18, gap: 10 }}>
          <Label>Recent activity</Label>
          <View style={{ backgroundColor: c.card, borderRadius: 18, overflow: 'hidden' }}>
            {activity.map((row, i) => (
              <View key={row.id} style={{ flexDirection: 'row', justifyContent: 'space-between', gap: 12, padding: 14, borderTopWidth: i ? 1 : 0, borderTopColor: c.hair }}>
                <T style={{ fontSize: 15, flexShrink: 1 }}>{row.agent}: {row.tool.replace(/_/g, ' ')}{row.ok ? '' : ' (refused)'}</T>
                <T style={{ fontSize: 14, color: c.ink2 }}>{relativeDay(row.at)}</T>
              </View>
            ))}
          </View>
          <Caption>Only the tool is listed, never amounts or names.</Caption>
        </View>
      ) : null}
    </SettingsShell>
  );
}
