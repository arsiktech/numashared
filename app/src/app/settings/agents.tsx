// AI agents: let an assistant (Claude, ChatGPT, Cursor, any MCP client) read this person's
// households. The normal way is one step: add the Numa Shared address to the agent, and the agent
// opens the "Connect to Numa Shared" page (app/src/app/connect.tsx) where the person approves it.
// Terminal agents that can't sign in get a secret link instead, made on this device and shown once.
// A connection can only read. It can't add, change or delete anything, and Numa Shared never moves money.
import { useCallback, useEffect, useState } from 'react';
import { Linking, Share, View } from 'react-native';
import { Redirect } from 'expo-router';
import { ChevDown, ChevUp, Copy, Warn } from '@/ui/icons';
import { Banner, BannerText, CTA, haptic, Press, T } from '@/ui/primitives';
import { useTheme } from '@/ui/theme';
import { fonts, isWeb } from '@/ui/tokens';
import { Caption, Field, Label, Select } from '@/features/onboarding/chrome';
import { copyText } from '@/features/onboarding/share';
import { SGroup, SRow, SettingsShell } from '@/features/settings/parts';
import { clock, relativeDay, useHousehold } from '@/features/hooks';
import { explainFailure } from '@/features/account/session';
import { showToast } from '@/store/ui';
import { failureOf } from '@/sync/engine';
import { AGENT_APPS, agentFailure, cursorInstallLink } from '@/features/agents/links';
import { AGENT_MCP_URL, agents, type AgentActivity, type AgentConnection } from '@/sync/runtime';

const ALL = 'all';

function openURL(url: string) {
  if (isWeb) globalThis.open?.(url, '_blank', 'noopener');
  else void Linking.openURL(url).catch(() => showToast('Couldn’t open that app on this device.'));
}

export default function AgentsScreen() {
  const { c } = useTheme();
  const { h } = useHousehold();
  const [list, setList] = useState<AgentConnection[] | undefined>(undefined);
  const [activity, setActivity] = useState<AgentActivity[]>([]);
  const [advanced, setAdvanced] = useState(false);
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
      <SettingsShell title="AI agents" back="Settings" active="agents">
        <T style={{ fontSize: 16, lineHeight: 22, color: c.ink2, marginTop: 12 }}>Share {h.name} first. Agents connect to your account, so you need to be signed in with a shared household.</T>
      </SettingsShell>
    );
  }

  const addTo = async (app: keyof typeof AGENT_APPS) => {
    const target = AGENT_APPS[app];
    if (await copyText(AGENT_MCP_URL, `Address copied. ${target.paste}`)) openURL(target.open);
  };
  const makeLink = async () => {
    setBusy(true); setError(null);
    try {
      const made = await agents.connect(name.trim() || 'Terminal agent', scope === ALL ? null : h.id);
      setLink(made.link); setName('');
      haptic.success();
      await refresh();
    } catch (e) { haptic.warn(); const code = failureOf(e).code; setError(agentFailure(code) ?? explainFailure(code)); }
    finally { setBusy(false); }
  };
  const disconnect = async (id: string) => {
    setBusy(true); setError(null);
    try { await agents.disconnect(id); await refresh(); } catch (e) { setError(explainFailure(failureOf(e).code)); }
    finally { setBusy(false); }
  };
  const scopeLabel = (agent: AgentConnection) => (agent.potId ? `Only ${agent.potId === h.id ? h.name : 'one household'}` : 'All my households');
  // "today", "yesterday", or a weekday or date, which keep their capitals.
  const day = (ts: number) => { const d = relativeDay(ts); return d === 'Today' || d === 'Yesterday' ? d.toLowerCase() : d; };
  // Each approval is its own connection, so the same agent can appear twice; when it was
  // connected tells them apart.
  const details = (agent: AgentConnection) => [
    scopeLabel(agent),
    `connected ${day(agent.createdAt)} at ${clock(agent.createdAt)}`,
    agent.lastUsedAt ? `used ${day(agent.lastUsedAt)}` : 'not used yet',
  ].join(' · ');

  return (
    <SettingsShell title="AI agents" back="Settings" active="agents">
      <T style={{ fontSize: 16, lineHeight: 22, color: c.ink2, marginTop: 8, paddingHorizontal: 4 }}>
        An agent you connect can read who paid, who owes whom and the records in your households. It can’t add, change or delete anything, and Numa Shared never moves money.
      </T>

      {error ? (
        <View style={{ marginTop: 16 }} accessibilityLiveRegion="polite">
          <Banner kind="warn" icon={<Warn size={18} color={c.warnInk} />}><BannerText kind="warn" rest={error} /></Banner>
        </View>
      ) : null}

      <SGroup title="Connect an agent">
        <SRow label={AGENT_APPS.claude.label} onPress={() => { void addTo('claude'); }} />
        <SRow label={AGENT_APPS.chatgpt.label} onPress={() => { void addTo('chatgpt'); }} />
        <SRow label="Add to Cursor" onPress={() => openURL(cursorInstallLink(AGENT_MCP_URL))} last />
      </SGroup>

      <SGroup title="Any other agent">
        <SRow label={AGENT_MCP_URL} a11y={`Copy the address ${AGENT_MCP_URL}`} chevron={false} last
          onPress={() => { void copyText(AGENT_MCP_URL, 'Address copied.'); }}
          right={<View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}><Copy size={18} color={c.ink2} /><T style={{ fontFamily: fonts.semibold, fontSize: 15, color: c.ink2 }}>Copy</T></View>} />
      </SGroup>

      {list && list.length > 0 ? (
        <SGroup title="Connected">
          {list.map((agent, i) => (
            <SRow key={agent.id} label={agent.name} chevron={false} last={i === list.length - 1}
              sub={details(agent)}
              right={(
                <Press onPress={busy ? undefined : () => { void disconnect(agent.id); }} accessibilityRole="button" accessibilityLabel={`Disconnect ${agent.name}, ${details(agent)}`}
                  style={{ minHeight: 44, justifyContent: 'center', paddingLeft: 8 }}>
                  <T style={{ fontFamily: fonts.semibold, fontSize: 15, color: c.bad }}>Disconnect</T>
                </Press>
              )} />
          ))}
        </SGroup>
      ) : null}

      {activity.length > 0 ? (
        <SGroup title="Recent activity">
          {activity.map((row, i) => (
            <SRow key={row.id} label={`${row.agent}: ${row.tool.replace(/_/g, ' ')}${row.ok ? '' : ' (refused)'}`} chevron={false}
              last={i === activity.length - 1} right={<T style={{ fontSize: 14, color: c.ink2 }}>{relativeDay(row.at)}</T>} />
          ))}
        </SGroup>
      ) : null}
      {activity.length > 0 ? <Caption>Only the tool is listed, never amounts or names.</Caption> : null}

      <Press onPress={() => setAdvanced(!advanced)} accessibilityRole="button" accessibilityState={{ expanded: advanced }}
        style={{ minHeight: 44, flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 20, paddingHorizontal: 4 }}>
        <T style={{ fontFamily: fonts.semibold, fontSize: 15, color: c.ink2 }}>Advanced: terminal agents</T>
        {advanced ? <ChevUp size={16} color={c.ink2} /> : <ChevDown size={16} color={c.ink2} />}
      </Press>
      {advanced ? (
        link ? (
          <View style={{ marginTop: 8, backgroundColor: c.card, borderRadius: 18, padding: 16, gap: 10 }} accessibilityLiveRegion="polite">
            <T style={{ fontFamily: fonts.semibold, fontSize: 16 }}>Your agent link</T>
            <T selectable style={{ fontFamily: fonts.semibold, fontSize: 13, letterSpacing: 0.2 }}>{link}</T>
            <T style={{ fontSize: 14, lineHeight: 20, color: c.ink2 }}>
              Anyone with this link can read your households, so keep it private. It’s shown only now. If you lose it, disconnect the agent and make a new one.
            </T>
            <View style={{ flexDirection: 'row', gap: 16 }}>
              <Press onPress={() => { void Share.share({ message: link }); }} accessibilityRole="button" style={{ minHeight: 44, justifyContent: 'center' }}>
                <T style={{ fontFamily: fonts.semibold, fontSize: 15, textDecorationLine: 'underline' }}>Share the link</T>
              </Press>
              <Press onPress={() => setLink(null)} accessibilityRole="button" style={{ minHeight: 44, justifyContent: 'center' }}>
                <T style={{ fontFamily: fonts.semibold, fontSize: 15, textDecorationLine: 'underline' }}>Done</T>
              </Press>
            </View>
          </View>
        ) : (
          <View style={{ gap: 4 }}>
            <T style={{ fontSize: 14, lineHeight: 20, color: c.ink2, paddingHorizontal: 4 }}>
              For agents that can’t open a sign-in page. You get a secret link to paste into the agent.
            </T>
            <Label>Name</Label>
            <Field value={name} onChangeText={setName} maxLength={60} placeholder="Terminal agent" accessibilityLabel="Agent name" />
            <Label>It can read</Label>
            <Select label="It can read" value={scope} onChange={setScope}
              options={[{ value: ALL, label: 'All my households' }, { value: h.id, label: `Only ${h.name}` }]} />
            <CTA style={{ marginTop: 16 }} label={busy ? 'Making…' : 'Make a secret link'} disabled={busy} onPress={() => { void makeLink(); }} />
          </View>
        )
      ) : null}
    </SettingsShell>
  );
}
