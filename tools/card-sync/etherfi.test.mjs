import assert from 'node:assert/strict';
import { test } from 'node:test';
import { amountOf, cardLast4, isFinal, redacted, spendsFrom } from './etherfi.mjs';

// Shapes like the website's rain_transaction rows; all values made up.
const tx = (over = {}) => ({
  id: 'a1', eventType: 'rain_transaction', status: 'COMPLETED', timestamp: '2026-10-02T10:00:00Z',
  billAmount: 6.04, billCurrency: 'USD', transactionAmount: 5.33, transactionCurrency: 'EUR',
  merchantData: { merchant_name: 'Lidl 102', merchant_city: 'Riga', mcc_category: 'Grocery Stores and Supermarkets' },
  card: { last4: '4242', holderName: 'X' }, ...over,
});

test('finds the card, the final state and the euro amount', () => {
  assert.equal(cardLast4(tx()), '4242');
  assert.equal(cardLast4(tx({ card: undefined, cardNumber: '**** **** **** 3131' })), '3131');
  assert.equal(cardLast4({ id: 'x', amount: 1234 }), null);
  assert.equal(isFinal(tx()), true);
  assert.equal(isFinal(tx({ status: 'PENDING' })), false);
  assert.equal(isFinal(tx({ detailedStatus: 'DECLINED' })), false);
  assert.deepEqual(amountOf(tx(), 'EUR'), { path: 'transactionAmount', amount: 5.33, currency: 'EUR' });
  assert.equal(amountOf(tx({ transactionAmount: undefined, transactionCurrency: undefined }), 'EUR').currency, 'USD');
});

test('sends only final spends on the chosen cards, since the start date', () => {
  const rows = [
    tx(),
    tx({ id: 'other', card: { last4: '0001' } }),
    tx({ id: 'old', timestamp: '2026-09-01T10:00:00Z' }),
    tx({ id: 'pending', status: 'PENDING' }),
    tx({ id: 'usd', transactionAmount: undefined, transactionCurrency: undefined, billAmount: 10 }),
  ];
  const { spends, skipped } = spendsFrom(rows, { cards: ['4242', '3131'], since: Date.parse('2026-10-01T00:00:00Z'), currency: 'EUR', rate: (c) => (c === 'USD' ? 0.9 : null) });
  assert.deepEqual(spends.map((s) => [s.id, s.amount, s.card]), [['etherfi:a1', '5.33', '4242'], ['etherfi:usd', '9.00', '4242']]);
  assert.equal(spends[0].merchant, 'Lidl 102, Riga');
  assert.equal(spends[0].category, 'Grocery Stores and Supermarkets');
  // The other card isn't even mentioned.
  assert.deepEqual(skipped.map((s) => s.id), ['pending']);
});

test('the inspection view hides values but keeps field names', () => {
  const r = redacted(tx({ card: { last4: '4242', pan: '4111111111114242' } }));
  assert.equal(r['card.pan'], '••••••••••••4242');
  assert.equal(r['merchantData.merchant_name'], 'text(8)');
  assert.equal(r.status, 'COMPLETED');
});

test('sends settled refunds and cancellations so Numa Shared can take the money back', () => {
  const rows = [
    tx({ id: 'r1', isRefund: true, status: 'REFUND', detailedStatus: 'REFUND', userStatus: 'CLEARED', statusTag: 'SETTLED',
      transactionAmount: -4.67, merchantData: { merchant_id: 'm-1', merchant_name: 'Shop', merchant_city: 'Riga' } }),
    tx({ id: 'r2', isRefund: true, status: 'REFUND', detailedStatus: 'REFUND', userStatus: 'PENDING', statusTag: 'PENDING', transactionAmount: -1 }),
    tx({ id: 'c1', isRefund: true, status: 'CANCELLED', detailedStatus: 'CANCELLED', userStatus: 'CANCELLED', statusTag: 'CANCELED', transactionAmount: 616.78 }),
    tx({ id: 'd1', status: 'DECLINED', detailedStatus: 'DECLINED' }),
  ];
  const { spends, skipped } = spendsFrom(rows, { cards: ['4242'], since: Date.parse('2026-10-01T00:00:00Z'), currency: 'EUR' });
  assert.deepEqual(spends.map((s) => [s.id, s.kind, s.amount, s.merchantKey]), [
    ['etherfi:r1', 'refund', '4.67', 'm-1'],
    ['etherfi:c1', 'cancel', '616.78', undefined],
  ]);
  assert.deepEqual(skipped.map((s) => [s.id, s.why]), [['r2', 'refund not final yet'], ['d1', 'not final yet']]);
});
