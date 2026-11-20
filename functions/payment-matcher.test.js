const test = require('node:test');
const assert = require('node:assert/strict');
const { Address } = require('@ton/core');

function safeRawTonAddress(value) {
  try { return Address.parse(String(value)).toRawString(); }
  catch (_) { return null; }
}
function isMatchingMainnetPayment(tx, order, receiverRaw, createdSeconds, expiresSeconds) {
  if (!tx || typeof tx !== 'object') return false;
  const msg = tx.in_msg || {};
  const destinationRaw = safeRawTonAddress(msg.destination);
  if (!destinationRaw || destinationRaw !== receiverRaw) return false;
  const text = String(msg.message || msg.msg_data?.text || '');
  const time = Number(tx.utime || 0);
  const successful = tx.description?.aborted !== true && tx.description?.compute_ph?.success !== false;
  return successful && String(msg.value) === String(order.amountNano) && text.includes(String(order.memo || '')) && time >= createdSeconds && time <= expiresSeconds;
}
const receiver = 'EQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAM9c';
const receiverRaw = safeRawTonAddress(receiver);
const order = { amountNano: '1000000000', memo: 'VEXO:test-order' };
const base = { utime: 100, in_msg: { destination: receiver, value: '1000000000', message: 'VEXO:test-order' }, description: { aborted: false, compute_ph: { success: true } } };
test('accepts an exact successful payment', () => assert.equal(isMatchingMainnetPayment(base, order, receiverRaw, 90, 110), true));
test('skips malformed destination records without throwing', () => assert.equal(isMatchingMainnetPayment({ ...base, in_msg: { ...base.in_msg, destination: 'not-a-ton-address' } }, order, receiverRaw, 90, 110), false));
test('rejects wrong amount', () => assert.equal(isMatchingMainnetPayment({ ...base, in_msg: { ...base.in_msg, value: '2' } }, order, receiverRaw, 90, 110), false));
test('rejects wrong memo', () => assert.equal(isMatchingMainnetPayment({ ...base, in_msg: { ...base.in_msg, message: 'other' } }, order, receiverRaw, 90, 110), false));
test('rejects failed transactions', () => assert.equal(isMatchingMainnetPayment({ ...base, description: { aborted: true } }, order, receiverRaw, 90, 110), false));
test('rejects transactions outside order time window', () => assert.equal(isMatchingMainnetPayment({ ...base, utime: 120 }, order, receiverRaw, 90, 110), false));
