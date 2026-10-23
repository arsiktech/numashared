// Keep private machine, account and planning details out of this public repository.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
const self = 'scripts/tests/public-hygiene-test.mjs';

const patterns = {
  'home directory path': /\/Users\/(?!private\b)[A-Za-z0-9._-]+\/|\/home\/[a-z][a-z0-9_-]+\//,
  'Tailscale address': /\b100\.(?:6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.\d{1,3}\.\d{1,3}\b/,
  'Tailscale network name': /[a-z0-9-]+\.ts\.net\b/,
  'private tracker link': /app\.notion\.com\/|notion\.so\/|linear\.app\//,
  'agent session link': /claude\.ai\/code\/session_|chatgpt\.com\/c\//,
  'private key': /-----BEGIN [A-Z ]*PRIVATE KEY-----\s*\n\s*[A-Za-z0-9+/]{40,}/,
  'personal secrets folder': /Secrets\/numashared/,
};

test('agent instructions and project skills stay outside the public repository', () => {
  const files = execFileSync('git', ['-C', root, 'ls-files', '-z']).toString('utf8').split('\0').filter(Boolean);
  const forbidden = files.filter((rel) => {
    const parts = rel.toLowerCase().split('/');
    return parts.includes('.claude') || parts.includes('.agents') ||
      ['agents.md', 'claude.md', 'skill.md', 'copilot-instructions.md'].includes(parts.at(-1));
  });
  assert.deepEqual(forbidden, []);
});

test('tracked text files contain no private details', () => {
  const files = execFileSync('git', ['-C', root, 'ls-files', '-z']).toString('utf8').split('\0').filter(Boolean);
  const hits = [];
  for (const rel of files) {
    if (rel === self) continue;
    let text;
    try {
      text = readFileSync(root + rel, 'utf8');
    } catch {
      continue;
    }
    if (text.includes('\u0000')) continue; // binary
    for (const [label, pattern] of Object.entries(patterns)) {
      const match = pattern.exec(text);
      if (match) hits.push(`${rel}:${text.slice(0, match.index).split('\n').length}: ${label}`);
    }
  }
  assert.deepEqual(hits, []);
});
