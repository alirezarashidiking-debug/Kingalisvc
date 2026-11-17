import { auth } from './firebase.js';
import { httpsCallable, getFunctions } from 'https://www.gstatic.com/firebasejs/12.5.0/firebase-functions.js';
import { onAuthStateChanged } from 'https://www.gstatic.com/firebasejs/12.5.0/firebase-auth.js';
import { beginCell } from 'https://esm.sh/@ton/core@0.59.1';

const $ = id => document.getElementById(id);
const fn = getFunctions(undefined, 'us-central1');
const buyPlan = httpsCallable(fn, 'buySubscription');
const verifyPlan = httpsCallable(fn, 'verifySubscriptionOrder');
let user = null;
let order = null;
let tonUI = null;

onAuthStateChanged(auth, current => {
  user = current;
  if (!current) return;
  if (window.TON_CONNECT_UI?.TonConnectUI && !tonUI) {
    tonUI = new window.TON_CONNECT_UI.TonConnectUI({
      manifestUrl: new URL('./tonconnect-manifest.json', document.baseURI).href,
      buttonRootId: 'ton-connect-plans'
    });
  }
});

document.querySelectorAll('[data-plan]').forEach(button => {
  button.addEventListener('click', async () => {
    if (!user) { $('planMessage').textContent = 'Sign in first.'; return; }
    if (!tonUI?.wallet) { $('planMessage').textContent = 'Connect Tonkeeper using the wallet button above first.'; return; }
    button.disabled = true;
    try {
      order = (await buyPlan({ plan: button.dataset.plan })).data;
      const payload = beginCell().storeUint(0, 32).storeStringTail(order.memo).endCell().toBoc().toString('base64');
      await tonUI.sendTransaction({
        validUntil: Math.floor(Date.now() / 1000) + 600,
        network: '-239',
        messages: [{ address: order.receiver, amount: order.amountNano, payload }]
      });
      $('verifyPlanPayment').hidden = false;
      $('planMessage').textContent = `Mainnet order ${order.orderId} submitted. Verify it below after it appears on the explorer.`;
    } catch (error) {
      $('planMessage').textContent = error.message || 'Could not create or send subscription order.';
    } finally { button.disabled = false; }
  });
});

$('verifyPlanPayment')?.addEventListener('click', async () => {
  if (!order) return;
  const button = $('verifyPlanPayment'); button.disabled = true;
  try {
    const result = (await verifyPlan({ orderId: order.orderId })).data;
    $('planMessage').textContent = result.status === 'paid' ? 'Mainnet subscription payment verified.' : (result.message || 'Payment not found yet.');
  } catch (error) {
    $('planMessage').textContent = error.message || 'Verification failed.';
  } finally { button.disabled = false; }
});
