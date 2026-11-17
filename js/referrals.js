import {auth} from './firebase.js';
import {onAuthStateChanged} from 'https://www.gstatic.com/firebasejs/12.5.0/firebase-auth.js';
import {httpsCallable,getFunctions} from 'https://www.gstatic.com/firebasejs/12.5.0/firebase-functions.js';
const $=id=>document.getElementById(id),fn=getFunctions(undefined,'us-central1');let invite='';
async function load(){try{const {data}=await httpsCallable(fn,'getReferralInfo')({});$('referralCode').textContent=data.code;$('referralCount').textContent=String(data.successful);$('referralReward').textContent=`${data.rewardSilver} Silver`;invite=`${location.origin}${location.pathname.replace(/[^/]*$/,'')}login.html?ref=${encodeURIComponent(data.code)}`;}catch(e){$('referralMessage').textContent=e.message||'Could not load referral details.';}}
onAuthStateChanged(auth,u=>{if(u)load();});$('copyCode')?.addEventListener('click',async()=>{try{await navigator.clipboard.writeText(invite);$('referralMessage').textContent='Invite link copied. Share it with a new player.';}catch(e){$('referralMessage').textContent=invite;}});
