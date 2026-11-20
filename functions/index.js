const {onCall,HttpsError} = require('firebase-functions/v2/https');
const {initializeApp} = require('firebase-admin/app');
const {getDatabase,ServerValue} = require('firebase-admin/database');
const {getAuth} = require('firebase-admin/auth');
const {defineSecret} = require('firebase-functions/params');
const crypto = require('crypto');
const { Address } = require('@ton/core');

initializeApp();
const db = getDatabase();
const REGION = 'us-central1';
const TONCENTER_MAINNET_API_KEY = defineSecret('TONCENTER_MAINNET_API_KEY');
const DAY_CAP = 100;
const MOVES = ['rock','paper','scissors'];

const clean = (v,n=120) => String(v ?? '').trim().slice(0,n);
const dayKey = () => new Date().toISOString().slice(0,10);

function needAuth(req){if(!req.auth)throw new HttpsError('unauthenticated','Please sign in.');return req.auth.uid;}
function needGod(req){const uid=needAuth(req);if(req.auth.token.god!==true)throw new HttpsError('permission-denied','Verified GOD permission required.');return uid;}
function outcome(a,b){if(a===b)return 'draw';if((a==='rock'&&b==='scissors')||(a==='paper'&&b==='rock')||(a==='scissors'&&b==='paper'))return 'win';return 'loss';}

async function audit(uid,action,target,details={}){await db.ref('adminAudit').push({by:uid,action,target,details,createdAt:ServerValue.TIMESTAMP});}
async function notify(uid,type,title,body){
  await db.ref(`notifications/${uid}`).push({type,title:clean(title,80),body:clean(body,300),read:false,createdAt:ServerValue.TIMESTAMP});
}

async function newPlayerId(uid){
  const index=db.ref('playerIdIndex');
  for(let i=0;i<30;i++){
    // The range is inclusive of 1,000,000,000 and 9,999,999,999.
    const id=String(1000000000+crypto.randomInt(0,9000000000));
    const tx=await index.child(id).transaction(v=>v===null?uid:undefined);
    if(tx.committed && tx.snapshot.val()===uid) return id;
  }
  throw new HttpsError('resource-exhausted','Could not allocate a unique Player ID. Please retry.');
}

async function ensureProfile(uid,token){
  const pRef=db.ref(`profiles/${uid}`);
  const initial=(await pRef.get()).val()||{};
  let playerId=clean(initial.playerId,10);
  let reservedId=null;

  if(!/^\d{10}$/.test(playerId)){
    reservedId=await newPlayerId(uid);
    const proposed={
      playerId:reservedId,
      displayName:clean(initial.displayName||token.name||token.email?.split('@')[0]||'Player',24),
      email:clean(initial.email||token.email,160),
      createdAt:initial.createdAt||Date.now(),
      updatedAt:Date.now()
    };
    // A per-user transaction makes concurrent sign-ins converge on one permanent ID.
    const tx=await pRef.transaction(current=>{
      current=current||{};
      if(/^\d{10}$/.test(String(current.playerId||''))) return current;
      return {...current,...proposed};
    });
    if(!tx.committed) throw new HttpsError('aborted','Could not save your Player ID. Please retry.');
    const saved=tx.snapshot.val()||{};
    playerId=String(saved.playerId||'');
    if(reservedId && playerId!==reservedId){
      const ownReservation=db.ref(`playerIdIndex/${reservedId}`);
      await ownReservation.transaction(v=>v===uid?null:v);
    }
    initial.playerId=playerId;
    initial.displayName=saved.displayName;
    initial.email=saved.email;
    initial.createdAt=saved.createdAt;
    initial.updatedAt=saved.updatedAt;
  }

  if(!/^\d{10}$/.test(playerId)) throw new HttpsError('data-loss','The account Player ID is invalid. Contact VEXO support.');
  // Repair a missing index entry for older accounts without ever overwriting another owner.
  const indexTx=await db.ref(`playerIdIndex/${playerId}`).transaction(v=>v===null?uid:v);
  if(indexTx.snapshot.val()!==uid) throw new HttpsError('data-loss','Player ID index conflict. Contact VEXO support.');

  const displayName=clean(initial.displayName||token.name||token.email?.split('@')[0]||'Player',24);
  const profile={...initial,playerId,displayName,email:clean(initial.email||token.email,160)};
  profile.updatedAt=Date.now();
  const updates={};
  updates[`profiles/${uid}`]=profile;
  updates[`publicProfiles/${uid}`]={playerId,displayName};
  await db.ref().update(updates);

  // Initialize account data only when absent; never reset an existing user's balances or stats.
  const defaults=[
    [`wallets/${uid}`,{gold:0,silver:0,bronze:0,vxb:0,updatedAt:Date.now()}],
    [`playerStats/${uid}`,{wins:0,losses:0,draws:0,rounds:0}],
    [`playerLevels/${uid}`,{level:1,xp:0,updatedAt:Date.now()}]
  ];
  await Promise.all(defaults.map(async ([path,value])=>{
    await db.ref(path).transaction(current=>current===null?value:current);
  }));
  return profile;
}

async function getProfile(uid,token){
  const s=await db.ref(`profiles/${uid}`).get();
  const profile=s.val();
  if(!profile || !/^\d{10}$/.test(String(profile.playerId||''))) return ensureProfile(uid,token);
  const indexed=await db.ref(`playerIdIndex/${profile.playerId}`).get();
  if(!indexed.exists() || indexed.val()!==uid) return ensureProfile(uid,token);
  return profile;
}

async function enforceRateLimit(uid, action, intervalMs=500) {
  const ref = db.ref(`actionRateLimits/${uid}/${action}`);
  const now = Date.now();
  const tx = await ref.transaction(last => {
    if (last && now - Number(last) < intervalMs) return;
    return now;
  });
  if (!tx.committed) throw new HttpsError('resource-exhausted','You are acting too quickly. Please wait a moment.');
}

async function assertNotBanned(uid){
  const s=await db.ref(`bans/${uid}`).get();
  if(s.exists()&&s.val()?.banned)throw new HttpsError('permission-denied','This account is restricted. Contact VEXO support.');
}

async function walletChange(uid,delta,meta,operationId=null){
  for(const key of ['gold','silver','bronze','vxb']){
    const value=Number(delta?.[key]??0);
    if(!Number.isFinite(value)||Math.abs(value)>1000000000||Math.round(value*10000)!==value*10000)
      throw new HttpsError('invalid-argument','Wallet changes must be finite values with at most 4 decimal places.');
  }
  const wref=db.ref(`wallets/${uid}`);
  let after,applied=false;
  const tx=await wref.transaction(w=>{
    w=w||{gold:0,silver:0,bronze:0,vxb:0};
    if(operationId){w._walletOperations=w._walletOperations||{};if(w._walletOperations[operationId]){after={...w};return w;}}
    for(const k of ['gold','silver','bronze','vxb']){
      const next=(Number(w[k])||0)+(Number(delta[k])||0);
      if(next<0){
        if(meta?.type==='bot-match')w[k]=0;
        else return;
      }else w[k]=next;
    }
    if(operationId){w._walletOperations=w._walletOperations||{};w._walletOperations[operationId]=true;}
    applied=true;
    w.updatedAt=ServerValue.TIMESTAMP;
    after={...w};
    return w;
  });
  if(!tx.committed)throw new HttpsError('failed-precondition','Insufficient balance or wallet conflict.');
  if(applied) await db.ref(`transactions/${uid}`).push({...meta,delta,balances:after,createdAt:ServerValue.TIMESTAMP});
  return after;
}


async function recordMatchOnce(uid, matchKey, match) {
  const matchRef = db.ref(`matches/${uid}/${matchKey}`);
  await matchRef.transaction(v => v || {...match, createdAt: match.createdAt || Date.now()});
  const statsRef = db.ref(`playerStats/${uid}`);
  const tx = await statsRef.transaction(s => {
    s = s || {wins:0,losses:0,draws:0,rounds:0};
    s._processedMatches = s._processedMatches || {};
    if (s._processedMatches[matchKey]) return s;
    s.rounds = (Number(s.rounds)||0) + 1;
    s[match.result === 'win' ? 'wins' : match.result === 'loss' ? 'losses' : 'draws'] =
      (Number(s[match.result === 'win' ? 'wins' : match.result === 'loss' ? 'losses' : 'draws'])||0) + 1;
    s._processedMatches[matchKey] = true;
    const keys = Object.keys(s._processedMatches);
    if (keys.length > 500) delete s._processedMatches[keys[0]];
    return s;
  });
  if (!tx.committed) throw new HttpsError('aborted','Could not update player statistics.');
}

async function settleWalletOnce(uid,key,amount,meta){
  const wref=db.ref(`wallets/${uid}`);
  let applied=false,after;
  const tx=await wref.transaction(w=>{
    w=w||{gold:0,silver:0,bronze:0,vxb:0};
    w._settled=w._settled||{};
    if(w._settled[key]){after=w;return w;}
    const next=(Number(w.vxb)||0)+amount;
    w.vxb=Math.max(0,next);
    w._settled[key]=true;
    // Keep settlement keys durable: pruning allows an old match key to be replayed.
    w.updatedAt=ServerValue.TIMESTAMP;
    after=w;
    applied=true;
    return w;
  });
  if(!tx.committed)throw new HttpsError('aborted','Wallet settlement conflict.');
  if(applied)await db.ref(`transactions/${uid}`).push({...meta,delta:{gold:0,silver:0,bronze:0,vxb:amount},createdAt:ServerValue.TIMESTAMP});
  return after;
}

const VIP_PLANS = {
  free: {priceUsd:0, dailyGames:35},
  hydrogen: {priceUsd:20, dailyGames:250},
  helium: {priceUsd:40, dailyGames:500},
  uranium: {priceUsd:100, dailyGames:null}
};

exports.getSubscriptionPlans = onCall({region:REGION}, async req=>{
  const uid=needAuth(req);
  const sub=(await db.ref(`subscriptions/${uid}`).get()).val()||{plan:'free',status:'inactive'};
  return {plans:VIP_PLANS, subscription:sub};
});

exports.adminSetSubscription = onCall({region:REGION}, async req=>{
  const admin=needGod(req), id=clean(req.data?.playerId,10), plan=clean(req.data?.plan,12);
  if(!/^\d{10}$/.test(id)||!VIP_PLANS[plan]||plan==='free')throw new HttpsError('invalid-argument','Valid player ID and paid plan required.');
  const idx=await db.ref(`playerIdIndex/${id}`).get(); if(!idx.exists())throw new HttpsError('not-found','Player not found.');
  const uid=idx.val(), months=Math.max(1,Math.min(12,Number(req.data?.months)||1));
  const now=Date.now(), old=(await db.ref(`subscriptions/${uid}`).get()).val()||{};
  const start=Math.max(now,Number(old.expiresAt)||0), expiresAt=start+months*30*86400000;
  await db.ref(`subscriptions/${uid}`).set({plan,status:'active',priceUsd:VIP_PLANS[plan].priceUsd,startedAt:old.startedAt||now,expiresAt,months,updatedBy:admin,updatedAt:ServerValue.TIMESTAMP});
  await audit(admin,'subscription-set',uid,{plan,months,expiresAt}); return {ok:true,expiresAt};
});

exports.listMyWithdrawals = onCall({region:REGION},async req=>{
  const uid=needAuth(req);
  const s=await db.ref('withdrawalRequests').orderByChild('uid').equalTo(uid).limitToLast(50).get();
  const items=[];
  s.forEach(x=>items.push({id:x.key,...x.val()}));
  items.sort((a,b)=>(Number(b.createdAt)||0)-(Number(a.createdAt)||0));
  return{items};
});

exports.listMyTransactions = onCall({region:REGION},async req=>{
  const uid=needAuth(req);
  const s=await db.ref(`transactions/${uid}`).limitToLast(100).get();
  const items=[];
  s.forEach(x=>items.push({id:x.key,...x.val()}));
  items.sort((a,b)=>(Number(b.createdAt)||0)-(Number(a.createdAt)||0));
  return{items};
});

exports.requestWithdrawal = onCall({region:REGION},async req=>{
  const uid=needAuth(req); await assertNotBanned(uid); await enforceRateLimit(uid,'withdrawal-request',5000);
  const amount=Number(req.data?.amount), currency=clean(req.data?.currency,8);
  const destination=clean(req.data?.destination,128);
  const tonAddress=/^(?:EQ|UQ|kQ|0Q)[A-Za-z0-9_-]{46}$|^0:[0-9a-fA-F]{64}$/.test(destination);
  if(!['gold','silver','bronze','vxb'].includes(currency)||!Number.isSafeInteger(amount)||amount<=0||amount>1000000000)
    throw new HttpsError('invalid-argument','Enter a valid positive integer amount.');
  if(!tonAddress) throw new HttpsError('invalid-argument','Connect a valid TON wallet before requesting a withdrawal.');
  const wref=db.ref(`wallets/${uid}`); let reserved=false;
  const tx=await wref.transaction(w=>{if(!w)return;const balance=Number(w[currency]||0);if(balance<amount)return;w[currency]=balance-amount;w.updatedAt=ServerValue.TIMESTAMP;reserved=true;return w;});
  if(!tx.committed||!reserved)throw new HttpsError('failed-precondition','Insufficient balance.');
  const id=crypto.randomBytes(12).toString('hex');
  try {
    await db.ref(`withdrawalRequests/${id}`).set({uid,amount,currency,destination,status:'review',createdAt:ServerValue.TIMESTAMP,updatedAt:ServerValue.TIMESTAMP,notice:'Balance reserved; no TON has been transferred.'});
    await db.ref(`transactions/${uid}`).push({type:'withdrawal-request',requestId:id,amount,currency,destination,status:'review',createdAt:ServerValue.TIMESTAMP});
  } catch(e) {
    await wref.transaction(w=>{if(!w)return w;w[currency]=(Number(w[currency])||0)+amount;w.updatedAt=ServerValue.TIMESTAMP;return w;});
    await db.ref(`withdrawalRequests/${id}`).remove(); throw new HttpsError('internal','Could not create request; reserved balance was restored.');
  }
  return {ok:true,requestId:id,status:'review',message:'Request submitted. The amount is reserved and no TON is transferred yet.'};
});


async function creditReferralReward(uid, rewardKey, amount) {
  const wref = db.ref(`wallets/${uid}`);
  let credited = false;
  const tx = await wref.transaction(w => {
    if (!w) return;
    w._referralRewards = w._referralRewards || {};
    if (w._referralRewards[rewardKey]) return w;
    w.silver = (Number(w.silver) || 0) + amount;
    w._referralRewards[rewardKey] = true;
    w.updatedAt = ServerValue.TIMESTAMP;
    credited = true;
    return w;
  });
  if (!tx.committed) throw new HttpsError('aborted', 'Referral reward could not be credited. Retry.');
  if (credited) await db.ref(`transactions/${uid}`).push({
    type: 'referral-reward', rewardKey, delta: { silver: amount }, createdAt: ServerValue.TIMESTAMP
  });
}

async function applyReferralCode(uid, rawCode) {
  const code = clean(rawCode, 12).toUpperCase();
  if (!code) return { applied: false };
  if (!/^[A-F0-9]{8}$/.test(code)) throw new HttpsError('invalid-argument', 'Referral code is invalid.');
  const existing = await db.ref(`referralsApplied/${uid}`).get();
  if (existing.exists()) return { applied: false, reason: 'already-applied' };
  const ownerSnap = await db.ref(`referralCodes/${code}`).get();
  if (!ownerSnap.exists()) throw new HttpsError('not-found', 'Referral code was not found.');
  const referrer = String(ownerSnap.val());
  if (referrer === uid) throw new HttpsError('failed-precondition', 'You cannot use your own referral code.');
  const referralId = `${code}-${uid}`;
  const lock = await db.ref(`referralsApplied/${uid}`).transaction(v => v || {
    referrer, code, appliedAt: ServerValue.TIMESTAMP, rewardSilver: 100
  });
  const attribution = lock.snapshot.val();
  if (attribution?.referrer !== referrer || attribution?.code !== code) {
    throw new HttpsError('already-exists', 'A referral code has already been applied to this account.');
  }
  await creditReferralReward(uid, `new-${referralId}`, 100);
  await creditReferralReward(referrer, `referrer-${referralId}`, 100);
  await notify(uid,'referral','Referral bonus received','You received 100 Silver for joining with a referral code.');
  await notify(referrer,'referral','A friend joined VEXO','A new player used your referral code. 100 Silver was credited.');
  return { applied: true };
}

exports.ensurePlayer = onCall({region:REGION},async req=>{
  const uid=needAuth(req);
  const requestedName=clean(req.data?.displayName,24);
  if(req.data?.displayName!==undefined && requestedName.length<3)
    throw new HttpsError('invalid-argument','Display name must contain at least 3 characters.');
  const profileBefore = await db.ref(`profiles/${uid}`).get();
  let p=await getProfile(uid,req.auth.token);
  if(!profileBefore.exists() && req.data?.referralCode) await applyReferralCode(uid, req.data.referralCode);
  if(requestedName && p.displayName!==requestedName){
    await db.ref(`profiles/${uid}`).update({displayName:requestedName,updatedAt:ServerValue.TIMESTAMP});
    await db.ref(`publicProfiles/${uid}`).update({displayName:requestedName});
    p={...p,displayName:requestedName};
  }
  const w=(await db.ref(`wallets/${uid}`).get()).val()||{gold:0,silver:0,bronze:0,vxb:0};
  return{profile:p,wallet:w};
});

exports.updatePlayerProfile = onCall({region:REGION},async req=>{
  const uid=needAuth(req);
  const name=clean(req.data?.displayName,24);
  if(name.length<3)throw new HttpsError('invalid-argument','Display name must contain at least 3 characters.');
  const p=await getProfile(uid,req.auth.token);
  await db.ref(`profiles/${uid}`).update({displayName:name,updatedAt:ServerValue.TIMESTAMP});
  await db.ref(`publicProfiles/${uid}`).update({displayName:name});
  return{ok:true,playerId:p.playerId,displayName:name};
});

exports.playBotMatch = onCall({region:REGION,maxInstances:30},async req=>{
  const uid=needAuth(req);await assertNotBanned(uid);await enforceRateLimit(uid,'bot-match',650);
  if(!MOVES.includes(req.data?.move))throw new HttpsError('invalid-argument','Invalid move.');
  const requestId=clean(req.data?.requestId,64);
  if(!/^[A-Za-z0-9_-]{16,64}$/.test(requestId))throw new HttpsError('invalid-argument','A valid match request ID is required.');
  const p=await getProfile(uid,req.auth.token);
  let bot=MOVES[crypto.randomInt(0,3)],result=outcome(req.data.move,bot),day=dayKey();
  const statsRef=db.ref(`gameState/${uid}/${day}`);
  let goldAward=0,matchRecord=null;
  
  const [subSnap,levelSnap,economySnap]=await Promise.all([
    db.ref(`subscriptions/${uid}`).get(),
    db.ref(`playerLevels/${uid}`).get(),
    db.ref('economy/public/dailyGoldCap').get()
  ]);
  const sub=subSnap.val()||{plan:'free',status:'inactive'};
  const levelData=levelSnap.val()||{level:1,xp:0};
  const level=Math.max(1,Number(levelData.level)||1);
  
  // ??? ????: ?? + (??? - ?)
  const active=sub.status==='active'&&Number(sub.expiresAt||0)>Date.now();
  let quota=35+(level-1);
  if(active){
    if(sub.plan==='uranium')quota=Infinity;
    else if(sub.plan==='helium')quota=500;
    else if(sub.plan==='hydrogen')quota=250;
  }
  
  const dailyGoldCap=Math.max(0,Math.min(DAY_CAP,Number(economySnap.val()??DAY_CAP)));
  const tx=await statsRef.transaction(st=>{
    st=st||{goldEarned:0,rounds:0,requests:{}};st.requests=st.requests||{};
    if(st.requests[requestId]){matchRecord=st.requests[requestId];bot=matchRecord.opponentMove;result=matchRecord.result;goldAward=Number(matchRecord.goldAward)||0;return st;}
    if((st.rounds||0)>=quota)return;
    st.rounds=(Number(st.rounds)||0)+1;
    const earned=Math.max(0,Number(st.goldEarned)||0);
    goldAward=result==='win'&&earned<dailyGoldCap?Math.min(1,dailyGoldCap-earned):0;
    st.goldEarned=earned+goldAward;
    matchRecord={requestId,move:req.data.move,opponentMove:bot,result,goldAward,createdAt:Date.now()};
    st.requests[requestId]=matchRecord;
    return st;
  });
  if(!tx.committed)throw new HttpsError('resource-exhausted','Daily game limit reached. Try again tomorrow or review your plan.');
  if(!matchRecord){matchRecord=tx.snapshot.val()?.requests?.[requestId];if(matchRecord){bot=matchRecord.opponentMove;result=matchRecord.result;goldAward=Number(matchRecord.goldAward)||0;}}
  
  // ????? VEXO: ??? = +?? ???? = -?.??
  let delta={gold:0,silver:0,bronze:0,vxb:0};
  if(result==='win')delta.gold=goldAward;
  if(result==='loss')delta.gold=-0.25;
  
  const wallet=await walletChange(uid,delta,{type:'bot-match',requestId,result,move:req.data.move,opponentMove:bot},`bot-${day}-${requestId}`);
  
  // XP updates are deduplicated by the same client request ID.
  const xpGained=result==='win'?15:10;
  const levelRef=db.ref(`playerLevels/${uid}`);let levelAfter;
  const levelTx=await levelRef.transaction(current=>{
    current=current||{level:1,xp:0};current._processedBotRequests=current._processedBotRequests||{};
    if(current._processedBotRequests[requestId]){levelAfter=current;return current;}
    const xp=(Number(current.xp)||0)+xpGained;let lvl=Math.max(1,Number(current.level)||1),rem=xp,need=100+(lvl-1)*50;
    while(rem>=need){rem-=need;lvl++;need=100+(lvl-1)*50;}
    current.level=lvl;current.xp=rem;current._processedBotRequests[requestId]=true;current.updatedAt=ServerValue.TIMESTAMP;levelAfter=current;return current;
  });
  if(!levelTx.committed)throw new HttpsError('aborted','Could not update progression. Retry.');
  let newLevel=Number(levelAfter.level)||level,remainingXp=Number(levelAfter.xp)||0;
  // Level transaction above is the durable source of truth; no overwrite race here.
  const matchKey=`bot-${day}-${requestId}`;
  await recordMatchOnce(uid,matchKey,{
    mode:'bot',move:req.data.move,opponentMove:bot,result,xpGained,createdAt:Date.now()
  });

  return{result,opponentMove:bot,wallet,playerId:p.playerId,reward:delta.gold,dailyGoldCapReached:result==='win'&&goldAward===0,xpGained,newLevel,xp:remainingXp,matchId:matchKey};
});

exports.createPrivateRoom = onCall({region:REGION},async req=>{
  const uid=needAuth(req);await assertNotBanned(uid);await getProfile(uid,req.auth.token);
  if((await db.ref(`userRooms/${uid}`).get()).exists())throw new HttpsError('failed-precondition','Leave your current room before creating another.');
  const code=crypto.randomBytes(4).toString('hex').toUpperCase();
  const room={code,status:'waiting',host:uid,players:{[uid]:{joinedAt:ServerValue.TIMESTAMP}},createdAt:ServerValue.TIMESTAMP,round:0,moves:{}};
  await db.ref(`rooms/${code}`).set(room);
  await db.ref(`userRooms/${uid}`).set(code);
  return{code};
});

exports.joinPrivateRoom = onCall({region:REGION},async req=>{
  const uid=needAuth(req);await assertNotBanned(uid);await getProfile(uid,req.auth.token);
  if((await db.ref(`userRooms/${uid}`).get()).exists())throw new HttpsError('failed-precondition','Leave your current room before joining another.');
  const code=clean(req.data?.code,8).toUpperCase();
  if(!/^[A-F0-9]{8}$/.test(code))throw new HttpsError('invalid-argument','Invalid room code.');
  let error;
  const tx=await db.ref(`rooms/${code}`).transaction(r=>{
    if(!r||r.status!=='waiting'||r.players?.[uid]||Object.keys(r.players||{}).length>=2){error=true;return;}
    r.players=r.players||{};
    r.players[uid]={joinedAt:Date.now()};
    r.status='playing';
    return r;
  });
  if(!tx.committed||error)throw new HttpsError('failed-precondition','Room is unavailable or full.');
  await db.ref(`userRooms/${uid}`).set(code);
  return{code,status:'playing'};
});

exports.joinRandomMatch = onCall({region:REGION},async req=>{
  const uid=needAuth(req);await assertNotBanned(uid);await getProfile(uid,req.auth.token);
  if((await db.ref(`userRooms/${uid}`).get()).exists())throw new HttpsError('failed-precondition','Leave your current room before matchmaking.');
  const qref=db.ref('matchQueue');
  let found=null;
  const tx=await qref.transaction(q=>{
    q=q||{};
    for(const [other,v] of Object.entries(q)){
      if(other!==uid&&v&&Date.now()-v.at<90000){found=other;delete q[other];return q;}
    }
    q[uid]={at:Date.now()};
    return q;
  });
  if(!tx.committed)throw new HttpsError('aborted','Queue busy; retry.');
  if(found){
    const code=crypto.randomBytes(4).toString('hex').toUpperCase();
    await db.ref(`rooms/${code}`).set({
      code,status:'playing',host:found,
      players:{[found]:{joinedAt:ServerValue.TIMESTAMP},[uid]:{joinedAt:ServerValue.TIMESTAMP}},
      round:0,moves:{},createdAt:ServerValue.TIMESTAMP
    });
    await db.ref(`userRooms/${found}`).set(code);
    await db.ref(`userRooms/${uid}`).set(code);
    return{status:'matched',code,opponent:found};
  }
  return{status:'queued'};
});

exports.leaveMatchQueue = onCall({region:REGION},async req=>{
  const uid=needAuth(req);
  await db.ref(`matchQueue/${uid}`).remove();
  return{ok:true};
});

exports.submitMultiplayerMove = onCall({region:REGION},async req=>{
  const uid=needAuth(req);await assertNotBanned(uid);await enforceRateLimit(uid,'multiplayer-move',450);
  const code=clean(req.data?.code,8).toUpperCase(),move=req.data?.move;
  if(!MOVES.includes(move))throw new HttpsError('invalid-argument','Invalid move.');
  let resolved=null;
  const roomRef=db.ref(`rooms/${code}`);
  const tx=await roomRef.transaction(r=>{
    if(!r||r.status!=='playing'||!r.players?.[uid]||r.result?.[r.round])return;
    const round=String(r.round||0);
    r.moves=r.moves||{};
    r.moves[round]=r.moves[round]||{};
    if(r.moves[round][uid])return;
    r.moves[round][uid]=move;
    const ids=Object.keys(r.players);
    if(ids.length===2&&ids.every(id=>r.moves[round][id])){
      const a=ids[0],b=ids[1],res=outcome(r.moves[round][a],r.moves[round][b]);
      r.lastResult={
        round,
        players:{
          [a]:{move:r.moves[round][a],result:res==='win'?'win':res==='loss'?'loss':'draw'},
          [b]:{move:r.moves[round][b],result:res==='win'?'loss':res==='loss'?'win':'draw'}
        },
        at:Date.now()
      };
      r.round=(r.round||0)+1;
      resolved={a,b,result:res,round};
    }
    return r;
  });
  if(!tx.committed)throw new HttpsError('failed-precondition','Move already submitted or room unavailable.');
  if(resolved){
    const settleRef=db.ref(`roomSettlements/${code}/${resolved.round}`);
    const st=await settleRef.transaction(v=>{
      if (v?.status === 'settled') return;
      if (v?.status === 'processing' && Date.now() - Number(v.at||0) < 30000) return;
      return {status:'processing',at:Date.now()};
    });
    if(st.committed){
      const {a,b,result,round}=resolved;
      const ar=result==='win'?'win':result==='loss'?'loss':'draw';
      const br=result==='win'?'loss':result==='loss'?'win':'draw';
      const key=`mp-${code}-${round}`;
      await Promise.all([
        settleWalletOnce(a,key,ar==='win'?20:ar==='loss'?-5:0,{type:'multiplayer-match',room:code,result:ar}),
        settleWalletOnce(b,key,br==='win'?20:br==='loss'?-5:0,{type:'multiplayer-match',room:code,result:br}),
        recordMatchOnce(a,key,{mode:'multiplayer',result:ar,xpGained:0,createdAt:Date.now()}),
        recordMatchOnce(b,key,{mode:'multiplayer',result:br,xpGained:0,createdAt:Date.now()})
      ]);
      await settleRef.update({status:'settled'});
    }
  }
  return{ok:true,room:(await roomRef.get()).val()};
});

exports.getMyRoom = onCall({region:REGION},async req=>{
  const uid=needAuth(req);
  const s=await db.ref(`userRooms/${uid}`).get();
  if(!s.exists())return{room:null};
  const r=await db.ref(`rooms/${s.val()}`).get();
  return{room:r.val()};
});

exports.leaveRoom = onCall({region:REGION},async req=>{
  const uid=needAuth(req);
  await db.ref(`matchQueue/${uid}`).remove();
  const s=await db.ref(`userRooms/${uid}`).get();
  if(s.exists()){
    const code=s.val(),roomRef=db.ref(`rooms/${code}`),room=(await roomRef.get()).val();
    if(room){
      const members=Object.keys(room.players||{});
      await roomRef.update({status:'closed',closedBy:uid,closedAt:ServerValue.TIMESTAMP});
      await Promise.all(members.map(member=>db.ref(`userRooms/${member}`).remove()));
    }else await db.ref(`userRooms/${uid}`).remove();
  }
  return{ok:true};
});

exports.adminFindPlayer = onCall({region:REGION},async req=>{
  const admin=needGod(req); await enforceRateLimit(admin,'admin-player-search',250);
  const id=clean(req.data?.playerId,10);
  if(!/^\d{10}$/.test(id))throw new HttpsError('invalid-argument','Enter a 10-digit player ID.');
  const s=await db.ref(`playerIdIndex/${id}`).get();
  if(!s.exists())return{found:false};
  const uid=s.val();
  const [p,w,stats,tx,matches]=await Promise.all([
    db.ref(`profiles/${uid}`).get(),
    db.ref(`wallets/${uid}`).get(),
    db.ref(`playerStats/${uid}`).get(),
    db.ref(`transactions/${uid}`).limitToLast(20).get(),
    db.ref(`matches/${uid}`).limitToLast(20).get()
  ]);
  return{
    found:true,uid,
    profile:p.val(),wallet:w.val(),stats:stats.val(),
    transactions:tx.val(),matches:matches.val(),
    ban:(await db.ref(`bans/${uid}`).get()).val()||null
  };
});

exports.adminAdjustWallet = onCall({region:REGION},async req=>{
  const admin=needGod(req); await enforceRateLimit(admin,'admin-wallet-adjustment',750);
  const id=clean(req.data?.playerId,10),currency=clean(req.data?.currency,8),amount=Number(req.data?.amount),reason=clean(req.data?.reason,300);
  if(!/^\d{10}$/.test(id)||!['gold','silver','bronze','vxb'].includes(currency)||!Number.isSafeInteger(amount)||amount===0||Math.abs(amount)>1000000000||reason.length<5)
    throw new HttpsError('invalid-argument','Valid player ID, currency, integer amount and reason (5+ chars) required.');
  const idx=await db.ref(`playerIdIndex/${id}`).get();
  if(!idx.exists())throw new HttpsError('not-found','Player not found.');
  const uid=idx.val(),delta={gold:0,silver:0,bronze:0,vxb:0};
  delta[currency]=amount;
  const wallet=await walletChange(uid,delta,{type:'admin-adjustment',by:admin,reason});
  await audit(admin,'wallet-adjustment',uid,{playerId:id,currency,amount,reason});
  return{ok:true,wallet};
});

exports.adminSetBan = onCall({region:REGION},async req=>{
  const admin=needGod(req);
  const id=clean(req.data?.playerId,10),reason=clean(req.data?.reason,300),banned=!!req.data?.banned;
  if(!/^\d{10}$/.test(id)||reason.length<5)throw new HttpsError('invalid-argument','Player ID and reason required.');
  const s=await db.ref(`playerIdIndex/${id}`).get();
  if(!s.exists())throw new HttpsError('not-found','Player not found.');
  const uid=s.val();
  if(banned)await db.ref(`bans/${uid}`).set({banned:true,reason,by:admin,at:ServerValue.TIMESTAMP});
  else await db.ref(`bans/${uid}`).remove();
  await audit(admin,banned?'ban-player':'unban-player',uid,{reason});
  return{ok:true};
});

exports.adminDashboardStats = onCall({region:REGION},async req=>{
  needGod(req);
  const [profiles,wallets,orders,bans,economy]=await Promise.all([
    db.ref('profiles').get(),
    db.ref('wallets').get(),
    db.ref('paymentOrders').get(),
    db.ref('bans').get(),
    db.ref('economy/public').get()
  ]);
  let goldToday=0;
  const day=dayKey();
  const gs=await db.ref('gameState').get();
  gs.forEach(u=>{goldToday+=Number(u.child(day).child('goldEarned').val()||0)});
  const withdrawals=(await db.ref('withdrawalRequests').get()).val()||{};
  return{
    players:profiles.numChildren(),
    goldToday,
    cap:Number(economy.val()?.dailyGoldCap??DAY_CAP),
    pendingOrders:Object.values(orders.val()||{}).filter(x=>x.status==='pending').length,
    pendingWithdrawals:Object.values(withdrawals).filter(x=>x.status==='review'||x.status==='approved'||x.status==='rejecting').length,
    banned:bans.numChildren()
  };
});

exports.adminSetEconomy = onCall({region:REGION},async req=>{
  const admin=needGod(req);
  const cap=Number(req.data?.dailyGoldCap);
  if(!Number.isInteger(cap)||cap<0||cap>100)throw new HttpsError('invalid-argument','Daily Gold cap must be an integer from 0 to 100.');
  await db.ref('economy/public').update({dailyGoldCap:cap,updatedAt:ServerValue.TIMESTAMP,updatedBy:admin});
  await audit(admin,'economy-settings','public',{dailyGoldCap:cap});
  return{ok:true,dailyGoldCap:cap};
});

exports.updateSiteSettings = onCall({region:REGION},async req=>{
  const admin=needGod(req),d=req.data||{};
  const channels=Array.isArray(d.channels)?d.channels.slice(0,4).map(c=>({name:clean(c.name,32),url:clean(c.url,300)})):[];
  for(const c of channels)if(c.url&&!/^https:\/\//i.test(c.url))throw new HttpsError('invalid-argument','Channel URLs must use HTTPS.');
  await db.ref('siteSettings/public').set({
    ads:{top:clean(d.ads?.top,1200),footer:clean(d.ads?.footer,1200)},
    channels,updatedAt:ServerValue.TIMESTAMP,updatedBy:admin
  });
  await audit(admin,'site-settings','public',{});
  return{ok:true};
});


function readNanoEnv(name) {
  const value = String(process.env[name] || '');
  if (!/^[1-9]\d{0,17}$/.test(value)) {
    throw new HttpsError('failed-precondition', `${name} must be configured as a positive nanoTON integer.`);
  }
  return value;
}

function getMainnetPaymentConfig() {
  if (process.env.VEXO_MAINNET_PAYMENTS_ENABLED !== 'true') {
    throw new HttpsError('failed-precondition', 'Mainnet payments are locked. Complete the launch checklist and explicitly enable them.');
  }
  if (process.env.VEXO_TON_NETWORK !== 'mainnet') {
    throw new HttpsError('failed-precondition', 'VEXO_TON_NETWORK must be mainnet.');
  }
  const receiver = clean(process.env.VEXO_TON_TREASURY, 128);
  if (!/^(?:EQ|UQ|kQ|0Q)[A-Za-z0-9_-]{46}$|^0:[0-9a-fA-F]{64}$/.test(receiver)) {
    throw new HttpsError('failed-precondition', 'Configure a valid Mainnet treasury address.');
  }
  return { receiver };
}

function paymentPackages() {
  return {
    starter: { gold: 1, nano: readNanoEnv('VEXO_PACKAGE_STARTER_NANO') },
    boost: { gold: 5, nano: readNanoEnv('VEXO_PACKAGE_BOOST_NANO') },
    vault: { gold: 10, nano: readNanoEnv('VEXO_PACKAGE_VAULT_NANO') }
  };
}

function rawTonAddress(value) {
  try { return Address.parse(String(value)).toRawString(); }
  catch (_) { throw new HttpsError('failed-precondition', 'A configured TON address is invalid.'); }
}


// Invalid external transaction records are skipped instead of aborting the whole scan.
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
  return successful &&
    String(msg.value) === String(order.amountNano) &&
    text.includes(String(order.memo || '')) &&
    time >= createdSeconds && time <= expiresSeconds;
}


async function findMainnetPayment(order, receiver, apiKey) {
  const url = `https://toncenter.com/api/v2/getTransactions?address=${encodeURIComponent(receiver)}&limit=100&archival=true`;
  const response = await fetch(url, { headers: { 'X-API-Key': apiKey } });
  if (!response.ok) throw new HttpsError('unavailable', 'TON Mainnet transaction service is unavailable.');
  const data = await response.json();
  if (!Array.isArray(data.result)) throw new HttpsError('unavailable', 'TON Mainnet returned an unexpected transaction response.');

  const createdSeconds = Math.floor(Number(order.createdAt || 0) / 1000);
  const expiresSeconds = Math.floor(Number(order.expiresAt || 0) / 1000);
  const receiverRaw = rawTonAddress(receiver);
  const match = data.result.find(tx => isMatchingMainnetPayment(tx, order, receiverRaw, createdSeconds, expiresSeconds));
  if (!match) return null;
  const txHash = match.transaction_id?.hash || '';
  if (!/^[A-Za-z0-9_+=/-]{20,160}$/.test(String(txHash))) {
    throw new HttpsError('unavailable', 'Could not safely identify the Mainnet transaction hash.');
  }
  return { txHash, utime: Number(match.utime || 0) };
}

exports.createTonMainnetOrder = onCall({ region: REGION }, async req => {
  const uid = needAuth(req);
  await assertNotBanned(uid);
  const pkg = clean(req.data?.package, 16);
  const config = getMainnetPaymentConfig();
  const packages = paymentPackages();
  if (!Object.prototype.hasOwnProperty.call(packages, pkg)) {
    throw new HttpsError('invalid-argument', 'Unknown VEXO Gold package.');
  }
  const item = packages[pkg];
  const id = crypto.randomBytes(12).toString('hex');
  const memo = `VEXO:${id}`;
  const now = Date.now();
  const order = {
    uid, package: pkg, gold: item.gold, network: 'mainnet',
    receiver: config.receiver, amountNano: item.nano, memo,
    status: 'pending', createdAt: now, expiresAt: now + 20 * 60 * 1000
  };
  await db.ref(`paymentOrders/${id}`).set(order);
  return {
    orderId: id, receiver: config.receiver, amountNano: item.nano,
    memo, network: 'TON Mainnet', validUntil: Math.floor(order.expiresAt / 1000),
    status: 'pending'
  };
});

exports.verifyTonMainnetOrder = onCall({
  region: REGION, timeoutSeconds: 60, secrets: [TONCENTER_MAINNET_API_KEY]
}, async req => {
  const uid = needAuth(req);
  await assertNotBanned(uid);
  const id = clean(req.data?.orderId, 40);
  if (!/^[a-f0-9]{24}$/.test(id)) throw new HttpsError('invalid-argument', 'Invalid order ID.');
  const ref = db.ref(`paymentOrders/${id}`);
  const snap = await ref.get();
  if (!snap.exists() || snap.val().uid !== uid) throw new HttpsError('not-found', 'Order not found.');
  const order = snap.val();
  if (order.status === 'paid') return { ok: true, status: 'paid', gold: order.gold };
  if (order.network !== 'mainnet') throw new HttpsError('failed-precondition', 'Order network mismatch.');
  if (Date.now() > Number(order.expiresAt || 0)) throw new HttpsError('deadline-exceeded', 'This order expired. Create a new order.');
  const config = getMainnetPaymentConfig();
  const apiKey = TONCENTER_MAINNET_API_KEY.value();
  if (!apiKey) throw new HttpsError('failed-precondition', 'Set TONCENTER_MAINNET_API_KEY in Firebase Secret Manager.');

  const found = await findMainnetPayment(order, config.receiver, apiKey);
  if (!found) return { ok: false, status: 'pending', message: 'No matching successful Mainnet transfer has been found yet.' };

  const lock = await db.ref(`paymentTxIndex/${found.txHash}`).transaction(v => v === null ? id : undefined);
  if (!lock.committed || lock.snapshot.val() !== id) throw new HttpsError('already-exists', 'This TON transaction has already been used.');

  const walletRef = db.ref(`wallets/${uid}`);
  let credited = false;
  const walletTx = await walletRef.transaction(w => {
    if (!w) return;
    w._paidOrders = w._paidOrders || {};
    if (w._paidOrders[id]) return w;
    w.gold = (Number(w.gold) || 0) + Number(order.gold);
    w._paidOrders[id] = true;
    w.updatedAt = ServerValue.TIMESTAMP;
    credited = true;
    return w;
  });
  if (!walletTx.committed) throw new HttpsError('aborted', 'Wallet credit failed. Contact support with your order ID.');
  if (credited) {
    await db.ref(`transactions/${uid}`).push({
      type: 'ton-mainnet-purchase', orderId: id,
      delta: { gold: order.gold }, txHash: found.txHash,
      network: 'mainnet', createdAt: ServerValue.TIMESTAMP
    });
  }
  await ref.update({ status: 'paid', txHash: found.txHash, paidAt: ServerValue.TIMESTAMP });
  return { ok: true, status: 'paid', gold: order.gold, txHash: found.txHash };
});

exports.buySubscription = onCall({ region: REGION }, async req => {
  const uid = needAuth(req);
  await assertNotBanned(uid);
  const plan = clean(req.data?.plan, 12);
  const planConfig = {
    hydrogen: { priceUsd: 20, games: 250, env: 'VEXO_PLAN_HYDROGEN_NANO' },
    helium: { priceUsd: 40, games: 500, env: 'VEXO_PLAN_HELIUM_NANO' },
    uranium: { priceUsd: 100, games: null, env: 'VEXO_PLAN_URANIUM_NANO' }
  };
  if (!planConfig[plan]) throw new HttpsError('invalid-argument', 'Invalid subscription plan.');
  const config = getMainnetPaymentConfig();
  const item = planConfig[plan];
  const amountNano = readNanoEnv(item.env);
  const id = crypto.randomBytes(12).toString('hex');
  const memo = `VEXO-PLAN:${plan}:${id}`;
  const now = Date.now();
  await db.ref(`subscriptionOrders/${id}`).set({
    uid, plan, priceUsd: item.priceUsd, games: item.games,
    network: 'mainnet', receiver: config.receiver, amountNano, memo,
    status: 'pending', createdAt: now, expiresAt: now + 20 * 60 * 1000
  });
  return {
    orderId: id, receiver: config.receiver, amountNano, memo, plan,
    network: 'TON Mainnet', validUntil: Math.floor((now + 20 * 60 * 1000) / 1000)
  };
});

exports.verifySubscriptionOrder = onCall({
  region: REGION, timeoutSeconds: 60, secrets: [TONCENTER_MAINNET_API_KEY]
}, async req => {
  const uid = needAuth(req);
  await assertNotBanned(uid);
  const id = clean(req.data?.orderId, 40);
  if (!/^[a-f0-9]{24}$/.test(id)) throw new HttpsError('invalid-argument', 'Invalid order ID.');
  const ref = db.ref(`subscriptionOrders/${id}`);
  const snap = await ref.get();
  if (!snap.exists() || snap.val().uid !== uid) throw new HttpsError('not-found', 'Subscription order not found.');
  const order = snap.val();
  if (order.status === 'paid') return { ok: true, status: 'paid', plan: order.plan };
  if (order.network !== 'mainnet') throw new HttpsError('failed-precondition', 'Subscription network mismatch.');
  if (Date.now() > Number(order.expiresAt || 0)) throw new HttpsError('deadline-exceeded', 'This subscription order expired.');
  const config = getMainnetPaymentConfig();
  const apiKey = TONCENTER_MAINNET_API_KEY.value();
  if (!apiKey) throw new HttpsError('failed-precondition', 'Set TONCENTER_MAINNET_API_KEY in Firebase Secret Manager.');
  const found = await findMainnetPayment(order, config.receiver, apiKey);
  if (!found) return { ok: false, status: 'pending', message: 'Mainnet payment has not been found yet.' };

  const lock = await db.ref(`subscriptionTxIndex/${found.txHash}`).transaction(v => v === null ? id : undefined);
  if (!lock.committed || lock.snapshot.val() !== id) throw new HttpsError('already-exists', 'This TON transaction has already been used.');

  const now = Date.now();
  const expiresAt = now + 30 * 86400000;
  await db.ref(`subscriptions/${uid}`).set({
    plan: order.plan, status: 'active', priceUsd: order.priceUsd,
    games: order.games, startedAt: now, expiresAt, updatedAt: ServerValue.TIMESTAMP
  });
  await ref.update({ status: 'paid', txHash: found.txHash, paidAt: ServerValue.TIMESTAMP });
  await db.ref(`transactions/${uid}/subscription-${id}`).set({
    type: 'subscription-purchase', plan: order.plan,
    priceUsd: order.priceUsd, status: 'paid', txHash: found.txHash,
    network: 'mainnet', createdAt: ServerValue.TIMESTAMP
  });
  return { ok: true, status: 'paid', plan: order.plan, expiresAt, txHash: found.txHash };
});

exports.adminListWithdrawals = onCall({region:REGION},async req=>{
  needGod(req);
  const status=clean(req.data?.status,16), limit=Math.max(1,Math.min(200,Number(req.data?.limit)||100));
  const snap=await db.ref('withdrawalRequests').limitToLast(500).get();
  const items=[];
  snap.forEach(x=>{const v=x.val()||{};if(!status||status==='all'||v.status===status)items.push({id:x.key,...v});});
  items.sort((a,b)=>(Number(b.createdAt)||0)-(Number(a.createdAt)||0));
  return {items:items.slice(0,limit),total:items.length};
});

exports.adminReviewWithdrawal = onCall({region:REGION},async req=>{
  const admin=needGod(req), id=clean(req.data?.requestId,64), action=clean(req.data?.action,12), reason=clean(req.data?.reason,300);
  if(!/^[a-f0-9]{24}$/.test(id)||!['approve','reject'].includes(action)||reason.length<5)
    throw new HttpsError('invalid-argument','Request ID, action and a reason of at least 5 characters are required.');
  const ref=db.ref(`withdrawalRequests/${id}`); let previous;
  const tx=await ref.transaction(v=>{
    if(!v)return;
    if(action==='reject'&&v.status==='rejecting'){v.updatedAt=ServerValue.TIMESTAMP;return v;}
    if(v.status!=='review')return;
    previous=v;
    v.status=action==='approve'?'approved':'rejecting';
    v.reviewedBy=admin;
    v.reviewReason=reason;
    v.reviewedAt=Date.now();
    v.updatedAt=ServerValue.TIMESTAMP;
    return v;
  });
  if(!tx.committed)throw new HttpsError('failed-precondition','Request is no longer awaiting review.');
  const item=tx.snapshot.val();
  if(action==='reject'){
    const wref=db.ref(`wallets/${item.uid}`);let refunded=false;
    const refund=await wref.transaction(w=>{
      w=w||{gold:0,silver:0,bronze:0,vxb:0};
      w._withdrawalRefunds=w._withdrawalRefunds||{};
      if(w._withdrawalRefunds[id])return w;
      w[item.currency]=(Number(w[item.currency])||0)+Number(item.amount);
      w._withdrawalRefunds[id]=true;
      w.updatedAt=ServerValue.TIMESTAMP;
      refunded=true;
      return w;
    });
    if(!refund.committed)throw new HttpsError('aborted','Refund could not be completed; retry support review.');
    if(refunded)await db.ref(`transactions/${item.uid}`).push({type:'withdrawal-refund',requestId:id,amount:item.amount,currency:item.currency,reason,createdAt:ServerValue.TIMESTAMP});
    await ref.update({status:'rejected',refunded:true,updatedAt:ServerValue.TIMESTAMP});
  } else {
    await ref.update({updatedAt:ServerValue.TIMESTAMP});
  }
  await audit(admin,`withdrawal-${action}`,item.uid,{requestId:id,amount:item.amount,currency:item.currency,reason});
  return {ok:true,status:action==='approve'?'approved':'rejected'};
});

exports.adminMarkWithdrawalPaid = onCall({region:REGION},async req=>{
  const admin=needGod(req), id=clean(req.data?.requestId,64), txHash=clean(req.data?.txHash,160), note=clean(req.data?.note,300);
  if(!/^[a-f0-9]{24}$/.test(id)||txHash.length<20||!/^[A-Za-z0-9_+=-]+$/.test(txHash))
    throw new HttpsError('invalid-argument','A valid request ID and TON transaction hash are required.');
  const ref=db.ref(`withdrawalRequests/${id}`), snap=await ref.get();
  if(!snap.exists())throw new HttpsError('not-found','Withdrawal request not found.');
  const item=snap.val();
  if(item.status==='paid'&&item.txHash===txHash)return{ok:true,status:'paid'};
  if(item.status!=='approved')throw new HttpsError('failed-precondition','Only approved requests can be marked paid.');
  const index=db.ref(`withdrawalTxIndex/${txHash}`);
  const lock=await index.transaction(v=>v===null?id:undefined);
  if(!lock.committed)throw new HttpsError('already-exists','This transaction hash is already recorded.');
  const tx=await ref.transaction(v=>{
    if(!v||v.status!=='approved')return;
    v.status='paid';
    v.txHash=txHash;
    v.paidBy=admin;
    v.paidAt=Date.now();
    v.paymentNote=note;
    v.updatedAt=ServerValue.TIMESTAMP;
    return v;
  });
  if(!tx.committed){
    await index.remove();
    throw new HttpsError('failed-precondition','Request changed before payment was recorded.');
  }
  await db.ref(`transactions/${item.uid}`).push({type:'withdrawal-paid',requestId:id,amount:item.amount,currency:item.currency,destination:item.destination,txHash,status:'paid',createdAt:ServerValue.TIMESTAMP});
  await audit(admin,'withdrawal-paid',item.uid,{requestId:id,amount:item.amount,currency:item.currency,txHash,note});
  return {ok:true,status:'paid',txHash};
});

exports.adminGetAudit = onCall({region:REGION},async req=>{
  needGod(req);
  const s=await db.ref('adminAudit').limitToLast(100).get();
  return{entries:s.val()||{}};
});

exports.adminGrantGodClaim = onCall({region:REGION},async req=>{
  const admin=needGod(req);
  const email=clean(req.data?.email,160).toLowerCase();
  if(!email)throw new HttpsError('invalid-argument','Email required.');
  const user=await getAuth().getUserByEmail(email);
  await getAuth().setCustomUserClaims(user.uid,{...(user.customClaims||{}),god:true});
  await audit(admin,'grant-god',user.uid,{email});
  return{ok:true,uid:user.uid};
});

// Public leaderboard data is assembled server-side; private email and wallet fields are never exposed.
exports.getLeaderboard = onCall({region:REGION}, async req => {
  needAuth(req);
  const [profilesSnap, statsSnap, levelsSnap] = await Promise.all([
    db.ref('publicProfiles').get(), db.ref('playerStats').get(), db.ref('playerLevels').get()
  ]);
  const profiles = profilesSnap.val() || {}, stats = statsSnap.val() || {}, levels = levelsSnap.val() || {};
  const rows = Object.keys(profiles).map(uid => ({
    playerId: profiles[uid]?.playerId || '',
    displayName: clean(profiles[uid]?.displayName || 'Player', 24),
    wins: Number(stats[uid]?.wins || 0),
    rounds: Number(stats[uid]?.rounds || 0),
    level: Number(levels[uid]?.level || 1),
    xp: Number(levels[uid]?.xp || 0)
  }));
  rows.sort((a,b) => b.wins-a.wins || b.level-a.level || b.xp-a.xp);
  return { items: rows.slice(0,50) };
});

const DAILY_MISSIONS = [
  {id:'play-3', title:'Warm up', description:'Play 3 matches today', type:'rounds', target:3, reward:30},
  {id:'win-2', title:'Double victory', description:'Win 2 matches today', type:'wins', target:2, reward:60},
  {id:'play-10', title:'Arena regular', description:'Play 10 matches today', type:'rounds', target:10, reward:120}
];

async function getMissionProgress(uid) {
  const day = dayKey();
  const snap = await db.ref(`matches/${uid}`).limitToLast(500).get();
  let rounds = 0, wins = 0;
  snap.forEach(child => {
    const m = child.val() || {};
    if (new Date(Number(m.createdAt || 0)).toISOString().slice(0,10) === day) {
      rounds++;
      if (m.result === 'win') wins++;
    }
  });
  return {day, rounds, wins};
}

exports.getDailyMissions = onCall({region:REGION}, async req => {
  const uid = needAuth(req); await assertNotBanned(uid);
  const progress = await getMissionProgress(uid);
  const claims = (await db.ref(`missionClaims/${uid}/${progress.day}`).get()).val() || {};
  const items = DAILY_MISSIONS.map(m => {
    const current = m.type === 'wins' ? progress.wins : progress.rounds;
    return {...m, progress:Math.min(current,m.target), claimed:!!claims[m.id], completed:current>=m.target};
  });
  return {day:progress.day, items};
});

exports.claimDailyMission = onCall({region:REGION}, async req => {
  const uid = needAuth(req); await assertNotBanned(uid);
  const id = clean(req.data?.missionId,24);
  const mission = DAILY_MISSIONS.find(m => m.id === id);
  if (!mission) throw new HttpsError('invalid-argument','Unknown daily mission.');
  const progress = await getMissionProgress(uid);
  const current = mission.type === 'wins' ? progress.wins : progress.rounds;
  if (current < mission.target) throw new HttpsError('failed-precondition','Complete the mission before claiming its reward.');
  const claimKey = `${progress.day}-${id}`;
  const wref = db.ref(`wallets/${uid}`);
  let credited = false;
  const walletTx = await wref.transaction(w => {
    if (!w) return;
    w._missionRewards = w._missionRewards || {};
    if (w._missionRewards[claimKey]) return w;
    w.silver = (Number(w.silver)||0) + mission.reward;
    w._missionRewards[claimKey] = true;
    w.updatedAt = ServerValue.TIMESTAMP;
    credited = true;
    return w;
  });
  if (!walletTx.committed) throw new HttpsError('aborted','Reward could not be credited. Retry.');
  const claimRef = db.ref(`missionClaims/${uid}/${progress.day}/${id}`);
  const claimTx = await claimRef.transaction(v => v || {claimedAt:ServerValue.TIMESTAMP,reward:mission.reward});
  if (credited) {
    await db.ref(`transactions/${uid}`).push({
      type:'daily-mission-reward', missionId:id, delta:{silver:mission.reward}, createdAt:ServerValue.TIMESTAMP
    });
    await notify(uid,'mission','Mission reward claimed',`You received ${mission.reward} Silver for completing ${mission.title}.`);
  }
  return {ok:true, claimed:true, reward:mission.reward, alreadyClaimed:!credited};
});

exports.getReferralInfo = onCall({region:REGION}, async req => {
  const uid = needAuth(req); await assertNotBanned(uid);
  const existing = (await db.ref(`referralByUser/${uid}`).get()).val();
  let code = existing;
  if (!code) {
    code = crypto.randomBytes(4).toString('hex').toUpperCase();
    const lock = await db.ref(`referralCodes/${code}`).transaction(v => v === null ? uid : undefined);
    if (!lock.committed) throw new HttpsError('aborted','Could not create referral code. Retry.');
    await db.ref(`referralByUser/${uid}`).set(code);
  }
  const applied = await db.ref(`referralsApplied`).orderByChild('referrer').equalTo(uid).get();
  return {code, successful:applied.numChildren(), referred:applied.numChildren(), rewardSilver:100};
});

exports.listMyNotifications = onCall({region:REGION}, async req => {
  const uid = needAuth(req);
  const snap = await db.ref(`notifications/${uid}`).limitToLast(50).get();
  const items = [];
  snap.forEach(child => items.push({id:child.key,...(child.val()||{})}));
  items.sort((a,b)=>Number(b.createdAt||0)-Number(a.createdAt||0));
  return {items, unread:items.filter(x=>!x.read).length};
});

exports.markNotificationRead = onCall({region:REGION}, async req => {
  const uid = needAuth(req), id = clean(req.data?.notificationId,128);
  if (!/^[A-Za-z0-9_-]{8,128}$/.test(id)) throw new HttpsError('invalid-argument','Invalid notification ID.');
  const ref = db.ref(`notifications/${uid}/${id}`);
  const tx = await ref.transaction(v => v ? {...v,read:true,readAt:Date.now()} : undefined);
  if (!tx.committed) throw new HttpsError('not-found','Notification not found.');
  return {ok:true};
});

exports.createSupportTicket = onCall({region:REGION}, async req => {
  const uid = needAuth(req); await assertNotBanned(uid); await enforceRateLimit(uid,'support-ticket',3000);
  const category = clean(req.data?.category,24);
  const subject = clean(req.data?.subject,100);
  const message = clean(req.data?.message,2000);
  if (!['account','payment','withdrawal','game','other'].includes(category) || subject.length<5 || message.length<20) {
    throw new HttpsError('invalid-argument','Choose a category and enter a subject and message (at least 20 characters).');
  }
  const open = await db.ref('supportTickets').orderByChild('uid').equalTo(uid).limitToLast(30).get();
  let openCount=0;
  open.forEach(x=>{if(['open','answered'].includes(x.val()?.status))openCount++;});
  if(openCount>=5) throw new HttpsError('resource-exhausted','You have 5 open support tickets. Wait for a reply before opening another.');
  const ref = db.ref('supportTickets').push();
  await ref.set({uid,category,subject,message,status:'open',createdAt:ServerValue.TIMESTAMP,updatedAt:ServerValue.TIMESTAMP});
  await notify(uid,'support','Support ticket received',`Ticket ${ref.key} has been created. Our team can review it in the GOD panel.`);
  return {ok:true,ticketId:ref.key,status:'open'};
});

exports.listMySupportTickets = onCall({region:REGION}, async req => {
  const uid=needAuth(req);
  const snap=await db.ref('supportTickets').orderByChild('uid').equalTo(uid).limitToLast(30).get();
  const items=[];
  snap.forEach(x=>items.push({id:x.key,...(x.val()||{})}));
  items.sort((a,b)=>Number(b.createdAt||0)-Number(a.createdAt||0));
  return {items};
});

exports.adminListSupportTickets = onCall({region:REGION}, async req => {
  needGod(req);
  const status=clean(req.data?.status,16);
  const snap=await db.ref('supportTickets').limitToLast(300).get();
  const items=[];
  snap.forEach(x=>{const v=x.val()||{};if(!status||status==='all'||v.status===status)items.push({id:x.key,...v});});
  items.sort((a,b)=>Number(b.createdAt||0)-Number(a.createdAt||0));
  return {items:items.slice(0,100)};
});

exports.adminReplySupportTicket = onCall({region:REGION}, async req => {
  const admin=needGod(req);
  const id=clean(req.data?.ticketId,128), reply=clean(req.data?.reply,2000);
  if(!/^[A-Za-z0-9_-]{8,128}$/.test(id)||reply.length<5)throw new HttpsError('invalid-argument','Ticket ID and reply are required.');
  const ref=db.ref(`supportTickets/${id}`);
  const snap=await ref.get();
  if(!snap.exists())throw new HttpsError('not-found','Ticket not found.');
  const ticket=snap.val();
  await ref.update({status:'answered',reply,answeredBy:admin,answeredAt:ServerValue.TIMESTAMP,updatedAt:ServerValue.TIMESTAMP});
  await notify(ticket.uid,'support','VEXO support replied',`Your ticket "${ticket.subject}" has a new reply.`);
  await audit(admin,'support-reply',ticket.uid,{ticketId:id});
  return {ok:true};
});

