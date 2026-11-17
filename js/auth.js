import { auth } from './firebase.js';
import {
  createUserWithEmailAndPassword, signInWithEmailAndPassword,
  GoogleAuthProvider, signInWithPopup, onAuthStateChanged, signOut,
  updateProfile
} from 'https://www.gstatic.com/firebasejs/12.5.0/firebase-auth.js';
import { httpsCallable, getFunctions } from 'https://www.gstatic.com/firebasejs/12.5.0/firebase-functions.js';

const $ = id => document.getElementById(id);
const incomingReferral = new URLSearchParams(location.search).get('ref');
if (incomingReferral) sessionStorage.setItem('vexo_referral_code', incomingReferral.toUpperCase());
const functions = getFunctions(undefined, 'us-central1');
const ensurePlayer = httpsCallable(functions, 'ensurePlayer');
const msg = value => { const el = $('message'); if (el) el.textContent = value; };
const friendlyError = error => {
  const code = error?.code || '';
  const messages = {
    'auth/email-already-in-use': 'This email is already registered. Sign in instead.',
    'auth/invalid-email': 'Enter a valid email address.',
    'auth/weak-password': 'Password must be at least 8 characters.',
    'auth/user-not-found': 'No account was found for this email.',
    'auth/wrong-password': 'Incorrect password.',
    'auth/invalid-credential': 'Incorrect email or password.',
    'auth/popup-closed-by-user': 'Google sign-in was closed.',
    'auth/unauthorized-domain': 'This domain is not authorized in Firebase Authentication.',
    'auth/network-request-failed': 'Check your internet connection.',
    'functions/not-found': 'The ensurePlayer function is not deployed. Deploy Firebase Cloud Functions first.',
    'functions/unavailable': 'The server is temporarily unavailable.'
  };
  return messages[code] || error?.message || 'Authentication failed.';
};

async function completeLogin(user, displayName = '') {
  msg('Account verified. Preparing your VEXO profile…');
  // ensurePlayer creates the server-side profile, unique Player ID and initial wallet.
  const referralCode = new URLSearchParams(location.search).get('ref') || sessionStorage.getItem('vexo_referral_code') || '';
  await ensurePlayer({ ...(displayName ? { displayName } : {}), ...(referralCode ? { referralCode } : {}) });
  if (referralCode) sessionStorage.removeItem('vexo_referral_code');
  location.replace('dashboard.html');
}

const form = $('loginForm');
if (form) {
  const mode = $('mode');
  const syncMode = () => {
    const signup = mode.value === 'signup';
    $('username').required = signup;
    $('confirm').required = signup;
    $('username').closest('.field').hidden = !signup;
    $('confirm').closest('.field').hidden = !signup;
    $('password').autocomplete = signup ? 'new-password' : 'current-password';
  };
  mode.addEventListener('change', syncMode);
  syncMode();

  form.addEventListener('submit', async event => {
    event.preventDefault();
    const email = $('email').value.trim();
    const password = $('password').value;
    const signup = mode.value === 'signup';
    const displayName = $('username').value.trim();
    if (signup && displayName.length < 3) return msg('Display name must contain at least 3 characters.');
    if (signup && password !== $('confirm').value) return msg('Password confirmation does not match.');
    const submit = form.querySelector('button[type="submit"]');
    submit.disabled = true;
    msg(signup ? 'Creating your Firebase account…' : 'Signing in…');
    try {
      let credential;
      if (signup) {
        credential = await createUserWithEmailAndPassword(auth, email, password);
        await updateProfile(credential.user, { displayName });
        await completeLogin(credential.user, displayName);
      } else {
        credential = await signInWithEmailAndPassword(auth, email, password);
        await completeLogin(credential.user);
      }
    } catch (error) {
      console.error('VEXO authentication:', error);
      msg(friendlyError(error));
      submit.disabled = false;
    }
  });
}

if ($('google')) $('google').addEventListener('click', async () => {
  const button = $('google'); button.disabled = true;
  try {
    const credential = await signInWithPopup(auth, new GoogleAuthProvider());
    await completeLogin(credential.user, credential.user.displayName || '');
  } catch (error) { console.error(error); msg(friendlyError(error)); button.disabled = false; }
});

if ($('logout')) $('logout').addEventListener('click', async () => {
  await signOut(auth); location.replace('login.html');
});

// Route authenticated visitors away from the login screen; guard every protected page.
onAuthStateChanged(auth, user => {
  document.querySelectorAll('[data-user-email]').forEach(el => el.textContent = user?.email || 'Guest');
  const protectedPage = document.body.dataset.protected === 'true';
  if (protectedPage && !user) location.replace('login.html');
  if (form && user) location.replace('dashboard.html');
});
