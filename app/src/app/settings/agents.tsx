// AI agents: let an assistant read this person's households and, switch by switch, change them.
// - Copy setup prompt: one tap makes a secret-link connection for all households and copies a prompt
//   the person pastes into their agent (Claude Code, Codex, Cursor, Hermes, any MCP client). The
//   secret is made on this device; only its SHA-256 reaches the server (features/agents/setupPrompt.ts).
// - Claude and ChatGPT chat apps can't add a connector from a prompt, so they get the bare address
//   and the person approves them on the "Connect to Numa Shared" page (app/src/app/connect.tsx).
// Every connection reads. Three switches per connection (features/agents/permissions.ts) let it add,
// edit, or manage the household as this person; new connections start with all three on and the
// server checks them on every call. No agent can delete the account or a household, leave or
// remove anyone. Numa Shared never moves money.
import { useCallback, useEffect, useState } from 'react';
import { Linking, Share, View } from 'react-native';
import { Redirect } from 'expo-router';
import { Copy, Warn } from '@/ui/icons';
import { Banner, BannerText, CTA, haptic, Press, T, Toggle } from '@/ui/primitives';
import { useTheme } from '@/ui/theme';
import { fonts, isAndroid, isWeb } from '@/ui/tokens';
import { Caption } from '@/features/onboarding/chrome';
import { copyText } from '@/features/onboarding/share';
import { SGroup, SRow, SettingsShell } from '@/features/settings/parts';
import { clock, relativeDay, useHousehold } from '@/features/hooks';
import { explainFailure } from '@/features/account/session';
import { showToast } from '@/store/ui';
import { failureOf } from '@/sync/engine';
import { AGENT_APPS, agentFailure } from '@/features/agents/links';
import { AGENT_SWITCHES, READ_ONLY, permissionSummary, withPermission, type AgentPermission } from '@/features/agents/permissions';
import { copySetupPrompt, writeClipboardLater } from '@/features/agents/setupPrompt';
import { AGENT_MCP_URL, agents, type AgentActivity, type AgentConnection } from '@/sync/runtime';

const COPIED = 'Setup prompt copied. Paste it into your agent.';

function openURL(url: string) {
  if (isWeb) globalThis.open?.(url, '_blank', 'noopener');
  else void Linking.openURL(url).catch(() => showToast('Couldn’t open that app on this device.'));
}

/** The web writes the clipboard inside the tap; a phone hands the prompt to the share sheet, which offers Copy. */
const copyPrompt = isWeb
  ? writeClipboardLater
  : (text: Promise<string>) => text.then((prompt) => copyText(prompt, COPIED));

export default function AgentsScreen() {
  const { c } = useTheme();
  const { h } = useHousehold();
  const [list, setList] = useState<AgentConnection[] | undefined>(undefined);
  const [activity, setActivity] = useState<AgentActivity[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // A prompt that didn't reach the clipboard, shown here once so its connection isn't lost.
  const [uncopied, setUncopied] = useState<string | null>(null);

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

  // Not async before copySetupPrompt: the clipboard write has to start inside the tap.
  const copySetup = () => {
    if (busy) return;
    setBusy(true); setError(null); setUncopied(null);
    copySetupPrompt({ connect: agents.connect, copy: copyPrompt, now: Date.now() }).then(
      ({ prompt, copied }) => {
        haptic.success();
        if (!copied) setUncopied(prompt);
        else if (isWeb) showToast(COPIED);
      },
      (e) => { haptic.warn(); const code = failureOf(e).code; setError(agentFailure(code) ?? explainFailure(code)); },
    ).finally(() => { setBusy(false); void refresh(); });
  };
  const addTo = async (app: keyof typeof AGENT_APPS) => {
    const target = AGENT_APPS[app];
    if (await copyText(AGENT_MCP_URL, `Address copied. ${target.paste}`)) openURL(target.open);
  };
  // The switch moves at once; the server's answer confirms it or puts it back.
  const setPermission = async (agent: AgentConnection, key: AgentPermission, allowed: boolean) => {
    const before = agent.permissions ?? READ_ONLY;
    const patch = (permissions: typeof before) => setList((rows) => rows?.map((row) => (row.id === agent.id ? { ...row, permissions } : row)));
    patch(withPermission(before, key, allowed));
    setError(null);
    try { patch((await agents.setPermission(agent.id, key, allowed)).permissions); } catch (e) { patch(before); setError(explainFailure(failureOf(e).code)); }
  };
  const disconnect = async (id: string) => {
    setBusy(true); setError(null);
    try { await agents.disconnect(id); await refresh(); } catch (e) { setError(explainFailure(failureOf(e).code)); }
    finally { setBusy(false); }
  };
  // "today", "yesterday", or a weekday or date, which keep their capitals.
  const day = (ts: number) => { const d = relativeDay(ts); return d === 'Today' || d === 'Yesterday' ? d.toLowerCase() : d; };
  // Each connection has its own Disconnect, so the same agent can appear twice; when it was
  // connected tells them apart. New connections read every household; older ones may read one.
  const details = (agent: AgentConnection) => [
    ...(agent.potId ? [`Only ${agent.potId === h.id ? h.name : 'one household'}`] : []),
    `connected ${day(agent.createdAt)} at ${clock(agent.createdAt)}`,
    agent.lastUsedAt ? `used ${day(agent.lastUsedAt)}` : 'not used yet',
  ].join(' · ');

  return (
    <SettingsShell title="AI agents" back="Settings" active="agents">
      <T style={{ fontSize: 16, lineHeight: 22, color: c.ink2, marginTop: 8, paddingHorizontal: 4 }}>
        An agent you connect acts as you in all your households. It can always read who paid and who owes whom. Its switches below decide what else it can do; its changes show in the history as yours, and recent versions of the app add “via” the agent. No agent can delete your account or a household, or remove anyone. Numa Shared never moves money.
      </T>

      <CTA style={{ marginTop: 20 }} label={busy ? 'Copying…' : 'Copy setup prompt'} disabled={busy}
        icon={<Copy size={18} color={busy ? c.ink3 : c.bg} />} onPress={copySetup} />
      <T style={{ fontSize: 14, lineHeight: 20, color: c.ink2, marginTop: 10, paddingHorizontal: 4 }}>
        Paste it into Claude Code, Codex, Cursor, Hermes or any agent that supports MCP. The agent sets itself up.
      </T>

      {error ? (
        <View style={{ marginTop: 16 }} accessibilityLiveRegion="polite">
          <Banner kind="warn" icon={<Warn size={18} color={c.warnInk} />}><BannerText kind="warn" rest={error} /></Banner>
        </View>
      ) : null}

      {uncopied ? (
        <View style={{ marginTop: 16, backgroundColor: c.card, borderRadius: 18, padding: 16, gap: 10 }} accessibilityLiveRegion="polite">
          <T style={{ fontFamily: fonts.semibold, fontSize: 16 }}>Copy your setup prompt</T>
          <T style={{ fontSize: 14, lineHeight: 20, color: c.ink2 }}>
            It didn’t reach the clipboard. It holds a secret link and is shown only now. If you lose it, disconnect the agent and copy a new one.
          </T>
          <T selectable style={{ fontSize: 13, lineHeight: 18 }}>{uncopied}</T>
          <View style={{ flexDirection: 'row', gap: 16 }}>
            <Press onPress={() => { if (isWeb) void copyText(uncopied, COPIED); else void Share.share({ message: uncopied }); }}
              accessibilityRole="button" style={{ minHeight: 44, justifyContent: 'center' }}>
              <T style={{ fontFamily: fonts.semibold, fontSize: 15, textDecorationLine: 'underline' }}>{isWeb ? 'Copy' : 'Share'}</T>
            </Press>
            <Press onPress={() => setUncopied(null)} accessibilityRole="button" style={{ minHeight: 44, justifyContent: 'center' }}>
              <T style={{ fontFamily: fonts.semibold, fontSize: 15, textDecorationLine: 'underline' }}>Done</T>
            </Press>
          </View>
        </View>
      ) : null}

      <SGroup title="Chat apps">
        <SRow label={AGENT_APPS.claude.label} onPress={() => { void addTo('claude'); }} />
        <SRow label={AGENT_APPS.chatgpt.label} onPress={() => { void addTo('chatgpt'); }} last />
      </SGroup>

      {list?.map((agent) => {
        const permissions = agent.permissions ?? READ_ONLY;
        return (
          <SGroup key={agent.id} title={agent.name}>
            <SRow label="Read households" value="Always" chevron={false} sub={permissionSummary(permissions)} />
            {AGENT_SWITCHES.map((item) => (
              <SRow key={item.key} label={item.label} sub={item.sub} chevron={false}
                right={<Toggle label={`${item.label}, ${agent.name}`} value={permissions[item.key]} android={isAndroid}
                  onChange={(allowed) => { void setPermission(agent, item.key, allowed); }} />} />
            ))}
            <SRow label="Disconnect" danger chevron={false} last sub={details(agent)}
              a11y={`Disconnect ${agent.name}, ${details(agent)}`}
              onPress={busy ? undefined : () => { void disconnect(agent.id); }} />
          </SGroup>
        );
      })}

      {activity.length > 0 ? (
        <SGroup title="Recent activity">
          {activity.map((row, i) => (
            <SRow key={row.id} label={`${row.agent}: ${row.tool.replace(/_/g, ' ')}${row.ok ? '' : ' (refused)'}`} chevron={false}
              last={i === activity.length - 1} right={<T style={{ fontSize: 14, color: c.ink2 }}>{relativeDay(row.at)}</T>} />
          ))}
        </SGroup>
      ) : null}
      {activity.length > 0 ? <Caption>Only the tool is listed, never amounts or names.</Caption> : null}
    </SettingsShell>
  );
}
