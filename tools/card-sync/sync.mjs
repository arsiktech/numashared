#!/usr/bin/env node
// Numa Shared card sync for ether.fi Cash, meant to run on your own computer every hour.
//
// It opens ether.fi's transaction history in a browser profile where you are logged in, reads the
// card transactions the page loads, keeps only final spends on the cards you chose, and sends them
// to your Numa Shared household. Your ether.fi login stays in that browser profile on this
// computer; Numa Shared only ever receives the chosen cards' spends.
//
//   node sync.mjs --login     open a window to log in to ether.fi (once, and when it logs you out)
//   node sync.mjs --inspect   show which fields ether.fi returns (values masked); sends nothing
//   node sync.mjs             sync (what the hourly job runs)
//
// Settings: ~/.config/numa-card-sync/config.json
//   { "url": "https://<deployment>.convex.site/card-sync/spends", "cards": ["1234"], "currency": "EUR",
//     "since": "2026-10-01T00:00:00Z" }
// The key comes from NUMA_SHARED_KEY, or on a Mac from the Keychain item "numa-shared-card-sync".
//
// Exit codes: 0 synced, 2 log in again (run --login), 1 anything else.
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { redacted, spendsFrom } from './etherfi.mjs';

const DIR = join(homedir(), '.config', 'numa-card-sync');
const HISTORY = 'https://www.ether.fi/app/cash/transaction-history';
const API = /\/app\/cash\/api\/v\d+\/account-safe\/[^/]+\/transaction-history/;
const mode = process.argv.includes('--login') ? 'login' : process.argv.includes('--inspect') ? 'inspect' : 'sync';

function config() {
  const c = JSON.parse(readFileSync(join(DIR, 'config.json'), 'utf8'));
  if (!c.url || !Array.isArray(c.cards) || !c.cards.length) throw new Error('config.json needs "url" and "cards".');
  return { currency: 'EUR', since: '2026-01-01T00:00:00Z', pages: 20, ...c };
}

function key() {
  if (process.env.NUMA_SHARED_KEY) return process.env.NUMA_SHARED_KEY.trim();
  try {
    return execFileSync('security', ['find-generic-password', '-s', 'numa-shared-card-sync', '-w'], { encoding: 'utf8' }).trim();
  } catch {
    throw new Error('No key: set NUMA_SHARED_KEY or add the Keychain item "numa-shared-card-sync".');
  }
}

/** Daily ECB rates (frankfurter.app) for the rare charge in another currency. */
async function rates(currency, needed) {
  const out = new Map();
  for (const [from, day] of needed) {
    const k = `${from}:${day}`;
    if (out.has(k)) continue;
    const res = await fetch(`https://api.frankfurter.app/${day}?from=${from}&to=${currency}`);
    const json = res.ok ? await res.json() : null;
    out.set(k, json?.rates?.[currency] ?? null);
  }
  return (from, date) => out.get(`${from}:${date.toISOString().slice(0, 10)}`) ?? null;
}

async function readHistory(cfg, { headless }) {
  const { chromium } = await import('playwright');
  mkdirSync(join(DIR, 'browser'), { recursive: true });
  const context = await chromium.launchPersistentContext(join(DIR, 'browser'), { headless, viewport: { width: 1200, height: 900 } });
  try {
    const page = context.pages()[0] ?? await context.newPage();
    const first = page.waitForResponse((r) => API.test(r.url()) && r.request().method() === 'GET', { timeout: headless ? 60_000 : 600_000 });
    await page.goto(HISTORY, { waitUntil: 'domcontentloaded' });
    if (!headless) console.log('Log in to ether.fi in the window. It closes by itself once your transactions load.');
    let response;
    try { response = await first; } catch { return { loggedOut: true, rows: [] }; }
    if (response.status() === 401 || response.status() === 403) return { loggedOut: true, rows: [] };
    const request = response.request();
    const headers = await request.allHeaders();
    const rows = [];
    let body = await response.json();
    const since = Date.parse(cfg.since);
    for (let pageNo = 1; ; pageNo++) {
      const data = Array.isArray(body?.data) ? body.data.filter((x) => x?.eventType === undefined || x.eventType === 'rain_transaction') : [];
      rows.push(...data);
      const oldest = Math.min(...data.map((x) => Date.parse(x.timestamp)).filter(Number.isFinite));
      const next = body?.meta?.nextPage;
      if (!next || oldest < since || pageNo >= cfg.pages) break;
      const url = new URL(request.url());
      url.searchParams.set('page', String(next));
      const res = await context.request.get(url.toString(), { headers });
      if (res.status() === 401 || res.status() === 403) return { loggedOut: true, rows: [] };
      body = await res.json();
    }
    return { loggedOut: false, rows };
  } finally {
    await context.close();
  }
}

async function main() {
  const cfg = config();
  if (mode === 'login') {
    const r = await readHistory(cfg, { headless: false });
    console.log(r.loggedOut ? 'Not logged in yet. Run --login again.' : `Logged in. ${r.rows.length} recent transactions visible.`);
    return r.loggedOut ? 2 : 0;
  }
  const { loggedOut, rows } = await readHistory(cfg, { headless: true });
  if (loggedOut) { console.error('ether.fi logged you out. Run: node sync.mjs --login'); return 2; }

  const needed = [];
  const probe = spendsFrom(rows, { ...cfg, since: Date.parse(cfg.since), rate: (from, d) => { needed.push([from, d.toISOString().slice(0, 10)]); return null; } });
  const rate = needed.length ? await rates(cfg.currency, needed) : undefined;
  const { spends, skipped } = needed.length ? spendsFrom(rows, { ...cfg, since: Date.parse(cfg.since), rate }) : probe;

  if (mode === 'inspect') {
    console.log(`${rows.length} transactions read. Fields of the newest one (values masked):`);
    console.log(JSON.stringify(rows[0] ? redacted(rows[0]) : {}, null, 2));
    const perCard = {};
    for (const s of spends) perCard[s.card] = (perCard[s.card] ?? 0) + 1;
    console.log('Would send, per card:', perCard, ' Skipped:', skipped.map((s) => `${s.id} ${s.why}`));
    return 0;
  }

  const cardless = skipped.filter((s) => s.why === 'no card number in the transaction');
  if (cardless.length && cardless.length === rows.length) {
    console.error('No transaction says which card it was on; nothing sent. Run --inspect and check the card field.');
    return 1;
  }
  let added = 0;
  for (let i = 0; i < spends.length; i += 50) {
    const res = await fetch(cfg.url, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key()}` },
      body: JSON.stringify({ spends: spends.slice(i, i + 50) }),
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) { console.error(`Numa Shared refused the spends (${res.status}): ${json.error ?? 'unknown error'}`); return 1; }
    added += json.outcomes.filter((o) => o.result === 'added').length;
    for (const o of json.outcomes.filter((x) => x.result === 'ignored')) console.log(`Not added ${o.id}: ${o.reason}`);
  }
  for (const s of skipped.filter((x) => x.why !== 'not final yet')) console.log(`Skipped ${s.id}: ${s.why}${s.merchant ? ` (${s.merchant})` : ''}`);
  console.log(`${new Date().toISOString()} read ${rows.length}, sent ${spends.length}, added ${added}.`);
  return 0;
}

main().then((code) => process.exit(code), (e) => { console.error(e.message); process.exit(1); });
