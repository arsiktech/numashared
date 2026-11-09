// "Copy setup prompt" (Settings, AI agents): the prompt an agent reads to connect itself, and the
// one-tap flow that makes the connection and copies it.
import { describe, expect, test, vi } from 'vitest';
import { copySetupPrompt, defaultAgentName, setupCommands, setupPrompt, writeClipboardLater } from '@/features/agents/setupPrompt';

const URL_ = 'https://shared.numaworth.com/mcp/nsag_AbCdEfGhIjKlMnOpQrStUvWxYz0123456789-_abcde';
const count = (text: string, part: string) => text.split(part).length - 1;
const fs = await import(/* @vite-ignore */ ['node', 'fs'].join(':')) as { readFileSync: (p: string, e: string) => string };
const source = (file: string) => fs.readFileSync(expect.getState().testPath!.replace(/features\/__tests__\/setup-prompt\.test\.ts$/, file), 'utf8');

describe('setup prompt', () => {
  const prompt = setupPrompt(URL_);
  const lines = prompt.split('\n');

  test('each harness line carries the link exactly once', () => {
    const commands = setupCommands(URL_);
    expect(commands.map((c) => c.harness)).toEqual(['Claude Code', 'Codex CLI', 'Cursor', 'Hermes Agent']);
    for (const { harness, line } of commands) {
      expect(count(line, URL_)).toBe(1);
      const inPrompt = lines.find((l) => l.startsWith(`- ${harness}: `));
      expect(inPrompt).toBe(`- ${harness}: ${line}`);
    }
    // The endpoint line, then one per command; the generic client points back at the endpoint.
    expect(count(prompt, URL_)).toBe(1 + commands.length);
    expect(lines.find((l) => l.startsWith('- Any MCP client'))).toMatch(/Streamable HTTP.*endpoint above/);
  });

  test('the commands match each harness syntax', () => {
    const [claude, codex, cursor, hermes] = setupCommands(URL_).map((c) => c.line);
    expect(claude).toBe(`claude mcp add --transport http numa-shared ${URL_}`);
    expect(codex).toBe(`in ~/.codex/config.toml, add a [mcp_servers.numa-shared] table with url = "${URL_}"`);
    const snippet = cursor!.match(/add (".*)$/)![1]!;
    expect(JSON.parse(`{${snippet}}`)).toEqual({ 'numa-shared': { url: URL_ } });
    expect(cursor).toContain('~/.cursor/mcp.json');
    const value = hermes!.match(/'(\{.*\})'/)![1]!;
    expect(JSON.parse(value)).toEqual({ url: URL_, enabled: true });
    expect(hermes).toMatch(/^hermes config set mcp_servers\.numa-shared '.*' then run \/reload-mcp$/);
  });

  test('says what Numa Shared is, what the agent may do, and how to treat the secret', () => {
    expect(prompt).toMatch(/who paid and who owes whom/);
    expect(prompt).toMatch(/never moves money/);
    expect(prompt).toMatch(/act as me/);
    expect(prompt).toMatch(/Settings, AI agents/);
    expect(prompt).toMatch(/via you/);
    expect(prompt).toMatch(/request_id/);
    expect(prompt).toMatch(/amount_minor_units 1250 with currency EUR/);
    expect(prompt).toMatch(/link is a secret/);
    expect(prompt).toMatch(/Do not repeat it/);
    expect(prompt).toMatch(/Store it only in your MCP config/);
    expect(prompt).toMatch(/Streamable HTTP/);
    expect(prompt).toMatch(/call list_households to confirm/);
    // Every tool the server offers is named under the switch that allows it.
    const groups: Array<[string, string[]]> = [
      ['- Read, always allowed:', ['list_households', 'list_members', 'get_balances', 'list_records']],
      ['- Add expenses and repayments:', ['add_expense', 'add_repayment']],
      ['- Edit and void records:', ['edit_record', 'void_record']],
      ['- Manage the household:', ['rename_household', 'add_person', 'update_groups', 'create_invite']],
    ];
    for (const [start, tools] of groups) {
      const line = lines.find((l) => l.startsWith(start));
      for (const tool of tools) expect(line).toContain(tool);
    }
  });

  test('is short plain ASCII text with no em or en dashes', () => {
    expect(lines.length).toBeLessThanOrEqual(35);
    expect(prompt).not.toMatch(/[–—]/);
    expect(prompt).toMatch(/^[\x20-\x7e\n]*$/);
  });

  test('the default name carries the date', () => {
    expect(defaultAgentName(Date.UTC(2026, 10, 9, 12))).toBe('Agent, 9 Nov 2026');
  });
});

describe('copy setup prompt', () => {
  test('connects for all households with the default name and copies the prompt', async () => {
    const connect = vi.fn(async () => ({ link: URL_ }));
    let copied = '';
    const copy = vi.fn(async (text: Promise<string>) => { copied = await text; return true; });
    const result = await copySetupPrompt({ connect, copy, now: Date.UTC(2026, 10, 9, 12) });
    expect(connect).toHaveBeenCalledWith('Agent, 9 Nov 2026', null);
    expect(copied).toBe(setupPrompt(URL_));
    expect(result).toEqual({ prompt: setupPrompt(URL_), copied: true });
  });

  test('starts the clipboard write before the connection answers, inside the tap', () => {
    let release!: (value: { link: string }) => void;
    const connect = () => new Promise<{ link: string }>((resolve) => { release = resolve; });
    const copy = vi.fn(async () => true);
    void copySetupPrompt({ connect, copy, now: 0 });
    expect(copy).toHaveBeenCalledTimes(1);
    release({ link: URL_ });
  });

  test('hands back the prompt when the clipboard refused, so the screen can show it once', async () => {
    const result = await copySetupPrompt({ connect: async () => ({ link: URL_ }), copy: async () => { throw new Error('denied'); }, now: 0 });
    expect(result).toEqual({ prompt: setupPrompt(URL_), copied: false });
  });

  test('copies nothing and fails when the connection is refused', async () => {
    const clipboard = { write: vi.fn(async (items: unknown[]) => { await (items[0] as { data: Promise<Blob> }).data; }) };
    class Item { data: Promise<Blob>; constructor(items: Record<string, Promise<Blob>>) { this.data = items['text/plain']!; } }
    const refused = Object.assign(new Error('TOO_MANY_AGENTS'), { data: { code: 'TOO_MANY_AGENTS' } });
    await expect(copySetupPrompt({
      connect: async () => { throw refused; },
      copy: (text) => writeClipboardLater(text, clipboard, Item),
      now: 0,
    })).rejects.toBe(refused);
  });
});

describe('web clipboard', () => {
  class Item { data: Promise<Blob>; constructor(items: Record<string, Promise<Blob>>) { this.data = items['text/plain']!; } }

  test('writes a ClipboardItem holding the promise', async () => {
    let written: Blob | null = null;
    const clipboard = { write: async (items: unknown[]) => { written = await (items[0] as Item).data; } };
    expect(await writeClipboardLater(Promise.resolve('hello'), clipboard, Item)).toBe(true);
    expect(await written!.text()).toBe('hello');
  });

  test('falls back to writeText, and reports a clipboard that refuses both', async () => {
    const writeText = vi.fn(async () => {});
    expect(await writeClipboardLater(Promise.resolve('hi'), { writeText }, undefined)).toBe(true);
    expect(writeText).toHaveBeenCalledWith('hi');
    expect(await writeClipboardLater(Promise.resolve('hi'), { writeText: async () => { throw new Error('no'); } }, undefined)).toBe(false);
    expect(await writeClipboardLater(Promise.resolve('hi'), undefined, undefined)).toBe(false);
  });
});

describe('settings and consent screens', () => {
  const settings = source('app/settings/agents.tsx');
  const consent = source('app/connect.tsx');

  test('Settings leads with Copy setup prompt and asks for no name or household', () => {
    expect(settings).toContain("'Copy setup prompt'");
    expect(settings).toContain('copySetupPrompt(');
    expect(settings.indexOf("'Copy setup prompt'")).toBeLessThan(settings.indexOf('AGENT_APPS.claude.label'));
    expect(settings).not.toMatch(/<Select|<Field|Advanced: terminal agents|Add to Cursor/);
  });

  test('the consent page has no household picker and approves without a scope', () => {
    expect(consent).not.toMatch(/<Select|setScope/);
    expect(consent).toMatch(/agents\.consent\.approve\(request\)/);
  });

  test('screen copy has no em dashes', () => {
    for (const text of [settings, consent]) expect(text).not.toMatch(/—/);
  });
});
