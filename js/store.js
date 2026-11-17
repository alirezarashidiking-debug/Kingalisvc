import { auth } from './firebase.js';
import { onAuthStateChanged } from 'https://www.gstatic.com/firebasejs/12.5.0/firebase-auth.js';
import { httpsCallable, getFunctions } from 'https://www.gstatic.com/firebasejs/12.5.0/firebase-functions.js';
import { beginCell } from 'https://esm.sh/@ton/core@0.59.1';

const fn = getFunctions(undefined, 'us-central1');
const call = name => httpsCallable(fn, name);
const $ = id => document.getElementById(id);
let user = null;
let order = null;
let tonUI = null;

onAuthStateChanged(auth, current => {
  user = current;
  if (!current) return;
  if (window.TON_CONNECT_UI?.TonConnectUI && !tonUI) {
    tonUI = new window.TON_CONNECT_UI.TonConnectUI({
      manifestUrl: new URL('./tonconnect-manifest.json', document.baseURI).href,
      buttonRootId: 'ton-connect-store'
    });
  }
});

document.querySelectorAll('[data-buy]').forEach(button => {
  button.addEventListener('click', async () => {
    if (!user) { $('storeMessage').textContent = 'Sign in before creating an order.'; return; }
    if (!tonUI?.wallet) { $('storeMessage').textContent = 'Connect Tonkeeper using the wallet button above first.'; return; }
    button.disabled = true;
    try {
      order = (await call('createTonMainnetOrder')({ package: button.dataset.buy })).data;
      $('storeMessage').textContent = `MAINNET ORDER ${order.orderId} · ${Number(order.amountNano) / 1e9} TON · Memo ${order.memo}. Confirm the transaction in your connected wallet.`;
      const payload = beginCell().storeUint(0, 32).storeStringTail(order.memo).endCell().toBoc().toString('base64');
      await tonUI.sendTransaction({
        validUntil: Math.floor(Date.now() / 1000) + 600,
        network: '-239',
        messages: [{ address: order.receiver, amount: order.amountNano, payload }]
      });
      $('verifyPayment').hidden = false;
      $('storeMessage').textContent = 'Wallet submitted the Mainnet transfer. Verify it below after it appears on the explorer.';
    } catch (error) {
      $('storeMessage').textContent = error.message || 'Could not create or send the Testnet order.';
    } finally { button.disabled = false; }
  });
});

$('verifyPayment')?.addEventListener('click', async () => {
  if (!order) return;
  const button = $('verifyPayment'); button.disabled = true;
  try {
    const result = (await call('verifyTonMainnetOrder')({ orderId: order.orderId })).data;
    $('storeMessage').textContent = result.status === 'paid'
      ? `Mainnet payment verified. ${result.gold} Gold credited.`
      : (result.message || 'Payment has not appeared yet. Try again shortly.');
  } catch (error) {
    $('storeMessage').textContent = error.message || 'Payment verification failed.';
  } finally { button.disabled = false; }
});
