import { auth, db } from './firebase.js';
import { ref, query, limitToLast, onValue } from 'https://www.gstatic.com/firebasejs/12.5.0/firebase-database.js';
import { onAuthStateChanged } from 'https://www.gstatic.com/firebasejs/12.5.0/firebase-auth.js';
import { httpsCallable, getFunctions } from 'https://www.gstatic.com/firebasejs/12.5.0/firebase-functions.js';

const $ = id => document.getElementById(id);
const fn = getFunctions(undefined, 'us-central1');
const call = name => httpsCallable(fn, name);
let user = null;
let botBusy = false;
let multiplayerBusy = false;
let queued = false;
let activeRoomCode = '';
let lastShownRound = -1;
const icons = { rock: '✊', paper: '✋', scissors: '✌️' };

function status(text) { if ($('result')) $('result').textContent = text; }
function mpStatus(text) { if ($('mpStatus')) $('mpStatus').textContent = text; }
function setBotBusy(value) {
  botBusy = value;
  document.querySelectorAll('[data-move]').forEach(button => { button.disabled = value; });
}

async function botMove(move) {
  if (botBusy) return;
  setBotBusy(true);
  try {
    const result = (await call('playBotMatch')({ move })).data;
    $('you').textContent = icons[move];
    $('bot').textContent = icons[result.opponentMove];
    let text = result.result.toUpperCase();
    if (result.result === 'win') text += result.reward > 0 ? ` · +${result.reward} Gold` : ' · Daily Gold cap reached';
    if (result.result === 'loss') text += ' · −0.25 Gold';
    if (result.result === 'draw') text += ' · No change';
    text += ` · XP: +${result.xpGained || 10}`;
    status(text);
    $('wins').textContent = result.result === 'win' ? Number($('wins').textContent) + 1 : $('wins').textContent;
    $('losses').textContent = result.result === 'loss' ? Number($('losses').textContent) + 1 : $('losses').textContent;
    $('rounds').textContent = Number($('rounds').textContent) + 1;
  } catch (error) {
    status(error.message || 'The match could not be completed.');
  } finally { setBotBusy(false); }
}

document.querySelectorAll('[data-move]').forEach(button => button.addEventListener('click', () => botMove(button.dataset.move)));

async function refreshRoom() {
  if (!user) return;
  try {
    const result = (await call('getMyRoom')({})).data;
    const room = result.room;
    if (!room) {
      activeRoomCode = '';
      if (!queued) mpStatus('Not in a multiplayer room.');
      return;
    }
    activeRoomCode = room.code;
    queued = false;
    $('roomCode').value = room.code;
    const players = Object.keys(room.players || {}).length;
    let text = `Room ${room.code} · ${room.status} · ${players}/2 players · Round ${room.round || 0}`;
    if (room.lastResult && room.lastResult.round > lastShownRound) {
      const mine = room.lastResult.players?.[user.uid]?.result;
      if (mine) {
        text += ` · Previous round: ${mine.toUpperCase()}`;
        lastShownRound = room.lastResult.round;
      }
    }
    if (room.status === 'waiting') text += ' · Waiting for another player.';
    if (room.status === 'playing' && room.moves?.[String(room.round || 0)]?.[user.uid]) text += ' · Move submitted; waiting for opponent.';
    mpStatus(text);
  } catch (error) {
    mpStatus(error.message || 'Could not refresh multiplayer room.');
  }
}

$('createRoom')?.addEventListener('click', async () => {
  try {
    const result = (await call('createPrivateRoom')({})).data;
    queued = false; activeRoomCode = result.code; lastShownRound = -1;
    $('roomCode').value = result.code;
    mpStatus(`Private room created. Share code ${result.code} with your opponent.`);
  } catch (error) { mpStatus(error.message || 'Could not create room.'); }
});

$('joinRoom')?.addEventListener('click', async () => {
  const code = $('roomCode').value.trim().toUpperCase();
  try {
    const result = (await call('joinPrivateRoom')({ code })).data;
    queued = false; activeRoomCode = result.code; lastShownRound = -1;
    mpStatus(`Joined room ${result.code}. Choose your move when both players are ready.`);
  } catch (error) { mpStatus(error.message || 'Could not join room.'); }
});

$('randomMatch')?.addEventListener('click', async () => {
  try {
    const result = (await call('joinRandomMatch')({})).data;
    if (result.status === 'queued') {
      queued = true;
      mpStatus('Searching for an opponent… Keep this page open.');
    } else {
      queued = false; activeRoomCode = result.code; lastShownRound = -1;
      mpStatus(`Opponent found. Room ${result.code} is ready.`);
    }
    await refreshRoom();
  } catch (error) { mpStatus(error.message || 'Could not join matchmaking.'); }
});

$('leaveRoom')?.addEventListener('click', async () => {
  try {
    await call('leaveRoom')({});
    await call('leaveMatchQueue')({});
    queued = false; activeRoomCode = ''; lastShownRound = -1;
    mpStatus('You left the room and matchmaking queue.');
  } catch (error) { mpStatus(error.message || 'Could not leave.'); }
});

document.querySelectorAll('[data-mp-move]').forEach(button => button.addEventListener('click', async () => {
  if (multiplayerBusy) return;
  if (!activeRoomCode) { mpStatus('Create or join a room first.'); return; }
  multiplayerBusy = true;
  document.querySelectorAll('[data-mp-move]').forEach(item => { item.disabled = true; });
  try {
    const result = (await call('submitMultiplayerMove')({ code: activeRoomCode, move: button.dataset.mpMove })).data;
    const room = result.room;
    if (room?.lastResult?.players?.[user.uid]) {
      mpStatus(`Your move: ${button.dataset.mpMove}. Round result: ${room.lastResult.players[user.uid].result.toUpperCase()}.`);
    } else {
      mpStatus(`Your move (${button.dataset.mpMove}) was submitted. Waiting for your opponent…`);
    }
    await refreshRoom();
  } catch (error) { mpStatus(error.message || 'Could not submit your move.'); }
  finally {
    multiplayerBusy = false;
    document.querySelectorAll('[data-mp-move]').forEach(item => { item.disabled = false; });
  }
}));


function watchMatchHistory(uid) {
  const host = $('matchHistory');
  if (!host) return;
  const q = query(ref(db, `matches/${uid}`), limitToLast(12));
  onValue(q, snap => {
    const items = [];
    snap.forEach(child => items.push(child.val() || {}));
    items.sort((a,b) => Number(b.createdAt||0)-Number(a.createdAt||0));
    host.replaceChildren();
    if (!items.length) { host.textContent = 'No matches played yet.'; return; }
    items.forEach(item => {
      const row = document.createElement('div');
      row.className = 'row';
      const left = document.createElement('span');
      left.textContent = `${item.mode === 'multiplayer' ? 'Online match' : 'Bot match'} · ${item.move || 'RPS'}`;
      const right = document.createElement('b');
      right.className = item.result === 'win' ? 'pink' : '';
      right.textContent = String(item.result || 'played').toUpperCase();
      row.append(left,right); host.append(row);
    });
  });
}

onAuthStateChanged(auth, async current => {
  user = current;
  if (!current) return;
  watchMatchHistory(current.uid);
  try { await call('ensurePlayer')({}); } catch (error) { status(error.message || 'Could not load player profile.'); }
  await refreshRoom();
});

setInterval(() => { if (user) refreshRoom(); }, 3000);
