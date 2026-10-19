// Turning ether.fi Cash card transactions (the website's own transaction-history API, which is
// undocumented) into spends for Numa Shared's card sync. Pure functions only, so they can be tested
// without anyone's account. The field names below are the ones the website returns today; anything
// unexpected is reported rather than guessed.

/** Every string or number in the object, with its dotted path. */
function* leaves(value, path = '') {
  if (value === null || value === undefined) return;
  if (typeof value === 'string' || typeof value === 'number') { yield [path, value]; return; }
  if (Array.isArray(value)) { for (let i = 0; i < value.length; i++) yield* leaves(value[i], `${path}[${i}]`); return; }
  if (typeof value === 'object') for (const [k, v] of Object.entries(value)) yield* leaves(v, path ? `${path}.${k}` : k);
}

/**
 * The card's last four digits. Looks at fields whose name mentions the card ("card", "last4",
 * "pan", "mask") and takes the trailing four digits. Returns null when there's no such field, so
 * the caller can stop instead of charging the wrong person.
 */
export function cardLast4(tx) {
  for (const [path, value] of leaves(tx)) {
    if (!/card|last ?4|last_?four|pan|mask/i.test(path)) continue;
    const m = /(\d{4})\s*$/.exec(String(value));
    if (m && !/amount|limit|id$|time|date/i.test(path)) return m[1];
  }
  return null;
}

/** Not final yet, or never will be: pending, declined, reversed and the like. */
export function isFinal(tx) {
  const states = [tx.status, tx.userStatus, tx.detailedStatus].filter((s) => typeof s === 'string');
  if (tx.isRefund === true) return false;
  return states.length > 0 && !states.some((s) => /pend|declin|reject|cancel|fail|revers|void|refund|authori[sz]/i.test(s));
}

export const isRefund = (tx) => tx.isRefund === true || [tx.status, tx.detailedStatus].some((s) => typeof s === 'string' && /refund/i.test(s));

/** Cancelled or reversed after the fact: the same transaction, which must not count any more. */
export const isCancelled = (tx) => [tx.status, tx.detailedStatus, tx.userStatus].some((s) => typeof s === 'string' && /cancel|revers|void/i.test(s));

/** Money that has actually come back to the card (not one still on its way). */
export const isSettledRefund = (tx) => isRefund(tx) && !isCancelled(tx)
  && [tx.userStatus, tx.statusTag].some((s) => typeof s === 'string' && /clear|settl|complet/i.test(s))
  && ![tx.userStatus, tx.statusTag].some((s) => typeof s === 'string' && /pend|declin|fail/i.test(s));

/**
 * The amount in the household's currency if the transaction carries it (the merchant's own
 * currency), else the billed amount and its currency for the caller to convert.
 */
export function amountOf(tx, currency) {
  const pairs = [];
  const flat = Object.fromEntries(leaves(tx));
  for (const [path, value] of Object.entries(flat)) {
    const m = /^(.*?)(Amount|_amount|amount)$/.exec(path);
    if (!m) continue;
    const base = m[1];
    const cur = flat[`${base}Currency`] ?? flat[`${base}_currency`] ?? flat[`${base}currency`];
    if (typeof cur === 'string' && /^[A-Z]{3}$/.test(cur.toUpperCase())) pairs.push({ path, amount: Math.abs(Number(value)), currency: cur.toUpperCase() });
  }
  const valid = pairs.filter((p) => Number.isFinite(p.amount) && p.amount > 0);
  return valid.find((p) => p.currency === currency) ?? valid.find((p) => /bill/i.test(p.path)) ?? valid[0] ?? null;
}

export function merchantOf(tx) {
  const m = tx.merchantData ?? {};
  const name = [m.merchant_name, m.merchant_city].filter((x) => typeof x === 'string' && x.trim()).join(', ');
  return name.replace(/\s+/g, ' ').trim() || 'Card payment';
}

export const categoryOf = (tx) => (typeof tx.merchantData?.mcc_category === 'string' ? tx.merchantData.mcc_category : undefined);

/** "12.3456" → "12.35" in a 2-decimal currency. */
export const decimal = (n, digits = 2) => (Math.round(n * 10 ** digits) / 10 ** digits).toFixed(digits);

/**
 * Spends to send: final card payments on the given cards since `since`, in `currency`. Returns what
 * was skipped and why, so a run can say exactly what it did.
 */
export function spendsFrom(transactions, { cards, since, currency, rate }) {
  const spends = [];
  const skipped = [];
  for (const tx of transactions) {
    const id = String(tx.id ?? '');
    const at = Date.parse(tx.timestamp);
    if (!id || !Number.isFinite(at)) { skipped.push({ id, why: 'no id or time' }); continue; }
    if (at < since) continue;
    const card = cardLast4(tx);
    if (card === null) { skipped.push({ id, why: 'no card number in the transaction' }); continue; }
    if (!cards.includes(card)) continue;                       // someone else's card: not even counted
    // The spend itself was cancelled or reversed: undo it if it was already sent.
    const kind = isCancelled(tx) ? 'cancel' : isRefund(tx) ? 'refund' : 'spend';
    if (kind === 'refund' && !isSettledRefund(tx)) { skipped.push({ id, card, why: 'refund not final yet' }); continue; }
    if (kind === 'spend' && !isFinal(tx)) { skipped.push({ id, card, why: 'not final yet' }); continue; }
    const money = amountOf(tx, currency);
    if (!money) { skipped.push({ id, card, why: 'no amount' }); continue; }
    let amount = money.amount;
    if (money.currency !== currency) {
      const r = rate?.(money.currency, new Date(at));
      if (!r) { skipped.push({ id, card, why: `no ${money.currency}→${currency} rate yet` }); continue; }
      amount = money.amount * r;
    }
    const merchantKey = typeof tx.merchantData?.merchant_id === 'string' && tx.merchantData.merchant_id ? tx.merchantData.merchant_id : undefined;
    spends.push({
      id: `etherfi:${id}`, card, occurredAt: new Date(at).toISOString(), merchant: merchantOf(tx),
      amount: decimal(amount), currency, ...(categoryOf(tx) ? { category: categoryOf(tx) } : {}),
      ...(kind !== 'spend' ? { kind } : {}), ...(merchantKey ? { merchantKey } : {}),
    });
  }

  return { spends, skipped };
}

/** One transaction with every text value masked, to show which fields exist without exposing them. */
export function redacted(tx) {
  const out = {};
  for (const [path, value] of leaves(tx)) {
    out[path] = typeof value === 'number' ? 'number'
      : /card|last|pan|mask/i.test(path) ? String(value).replace(/\d(?=\d{4})/g, '•')
      : /status|currency|type|refund/i.test(path) ? value : `text(${String(value).length})`;
  }
  return out;
}
