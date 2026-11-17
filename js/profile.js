import{auth}from'./firebase.js';import{onAuthStateChanged}from'https://www.gstatic.com/firebasejs/12.5.0/firebase-auth.js';import{httpsCallable,getFunctions}from'https://www.gstatic.com/firebasejs/12.5.0/firebase-functions.js';
const fn=getFunctions(undefined,'us-central1'),call=n=>httpsCallable(fn,n),$=id=>document.getElementById(id);
onAuthStateChanged(auth,async u=>{if(!u)return;try{const r=(await call('ensurePlayer')({})).data;$('profileName').value=r.profile.displayName;$('profileEmail').textContent=u.email||'';$('profileId').textContent=r.profile.playerId;}catch(e){$('profileMessage').textContent=e.message;}});
$('profileForm')?.addEventListener('submit',async e=>{e.preventDefault();try{const r=(await call('updatePlayerProfile')({displayName:$('profileName').value.trim()})).data;$('profileMessage').textContent='Profile saved. Player ID: '+r.playerId;}catch(err){$('profileMessage').textContent=err.message;}});

const copyButton=$('copyPlayerId');
copyButton?.addEventListener('click',async()=>{
  const id=$('profileId')?.textContent?.trim()||'';
  if(!/^\d{10}$/.test(id)){ $('profileMessage').textContent='Player ID is not ready yet.'; return; }
  try{
    if(navigator.clipboard?.writeText) await navigator.clipboard.writeText(id);
    else { const field=document.createElement('textarea'); field.value=id; document.body.append(field); field.select(); document.execCommand('copy'); field.remove(); }
    $('profileMessage').textContent='Player ID copied: '+id;
  }catch(e){ $('profileMessage').textContent='Copy failed. Please select and copy the ID manually.'; }
});
