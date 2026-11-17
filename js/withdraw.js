import { auth } from './firebase.js';
import { onAuthStateChanged } from 'https://www.gstatic.com/firebasejs/12.5.0/firebase-auth.js';
import { httpsCallable, getFunctions } from 'https://www.gstatic.com/firebasejs/12.5.0/firebase-functions.js';

const $ = id => document.getElementById(id);
const functions = getFunctions(undefined, 'us-central1');
const call = name => httpsCallable(functions, name);
const manifestUrl = new URL('./tonconnect-manifest.json', document.baseURI).href;
let currentUser = null;
let tonConnectUI = null;
let connectedAddress = '';

function message(text, isError = false) {
  const el = $('message');
  if (el) {
    el.textContent = text;
    el.classList.toggle('yellow', isError);
  }
}

function safeText(value) {
  return String(value ?? '');
}

function renderRows(container, items, emptyText, formatter) {
  if (!container) return;
  container.replaceChildren();
  if (!items.length) {
    container.textContent = emptyText;
    return;
  }
  for (const item of items) {
    const row = document.createElement('div');
    row.className = 'req';
    const content = document.createElement('span');
    content.textContent = formatter(item);
    row.append(content);
    container.append(row);
  }
}

async function refreshHistory() {
  if (!currentUser) return;
  try {
    const [withdrawals, transactions] = await Promise.all([
      call('listMyWithdrawals')({}),
      call('listMyTransactions')({})
    ]);
    renderRows($('requests'), withdrawals.data.items || [], 'No withdrawal requests yet.', item =>
      `${safeText(item.currency).toUpperCase()} · ${item.amount} · ${item.status} · ${item.destination || ''} · ${item.txHash || ''}`
    );
    renderRows($('transactions'), transactions.data.items || [], 'No transactions yet.', item =>
      `${safeText(item.type || 'Transaction')} · ${safeText(item.currency || '')} ${safeText(item.amount ?? '')} · ${new Date(Number(item.createdAt) || Date.now()).toLocaleString()}`
    );
  } catch (error) {
    message(error.message || 'Could not load wallet history.', true);
  }
}

function initTonConnect() {
  if (!window.TON_CONNECT_UI?.TonConnectUI) {
    $('walletState').textContent = 'Wallet connector could not load. Refresh the page or check your connection.';
    return;
  }
  try {
    tonConnectUI = new window.TON_CONNECT_UI.TonConnectUI({
      manifestUrl,
      buttonRootId: 'ton-connect'
    });
    tonConnectUI.onStatusChange(wallet => {
      connectedAddress = wallet?.account?.address || '';
      $('walletState').textContent = connectedAddress ? 'TON wallet connected.' : 'No TON wallet connected.';
      $('walletAddress').textContent = connectedAddress;
    });
    const existing = tonConnectUI.wallet;
    if (existing?.account?.address) {
      connectedAddress = existing.account.address;
      $('walletState').textContent = 'TON wallet connected.';
      $('walletAddress').textContent = connectedAddress;
    } else {
      $('walletState').textContent = 'Connect Tonkeeper or another TON-compatible wallet.';
    }
  } catch (error) {
    $('walletState').textContent = error.message || 'Wallet connection could not be initialized.';
  }
}

$('withdrawForm')?.addEventListener('submit', async event => {
  event.preventDefault();
  if (!currentUser) return message('Sign in before requesting a withdrawal.', true);
  if (!connectedAddress) return message('Connect your TON wallet first.', true);
  const amount = Number($('amount').value);
  const currency = $('currency').value;
  if (!Number.isSafeInteger(amount) || amount <= 0) return message('Enter a positive whole-number amount.', true);
  const submit = $('withdrawForm').querySelector('[type="submit"]');
  submit.disabled = true;
  try {
    const result = (await call('requestWithdrawal')({ amount, currency, destination: connectedAddress })).data;
    message(`Request ${result.requestId} submitted. ${result.message}`);
    $('amount').value = '';
    await refreshHistory();
  } catch (error) {
    message(error.message || 'Withdrawal request failed.', true);
  } finally {
    submit.disabled = false;
  }
});

$('refresh')?.addEventListener('click', refreshHistory);

onAuthStateChanged(auth, user => {
  currentUser = user;
  if (!user) {
    location.replace('login.html');
    return;
  }
  initTonConnect();
  refreshHistory();
});
