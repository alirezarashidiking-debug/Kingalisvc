VEXO COIN — MAINNET DEPLOYMENT CANDIDATE
========================================

IMPORTANT STATUS
----------------
This package has been switched from Testnet payment labels and endpoints to a
Mainnet-only payment configuration. It is NOT yet authorized to move real funds.
Payment activation is deliberately OFF by default. Do not set it to true until
the treasury, price sheet, Firebase rules, TON payment verification, legal review,
and an independent security review are complete.

The TON Jetton contract is NOT deployed by this ZIP. The Jetton Master address
must be supplied only after the contract is built, tested, audited, and deployed.
No private key, seed phrase, Firebase Admin credential, or API secret belongs in
the public GitHub Pages folder.

1) FILES YOU MUST EDIT
----------------------
js/firebase-config.js
  Firebase Web App config. The web apiKey is public project configuration, not
  an Admin SDK secret. Keep Firebase Security Rules restrictive.

tonconnect-manifest.json
  Set url and iconUrl to the final public HTTPS GitHub Pages URL.

functions/.env.example
  Copy the values into your private deployment environment. Replace every
  SET_* placeholder with an approved integer nanoTON amount. Do not commit a
  real .env file. The six amounts must be approved and kept in sync with the
  public price display.

2) FIREBASE DEPLOYMENT
----------------------
Use a trusted computer with Node.js 20+ and Firebase CLI. In the functions folder:
  npm install
From the project root:
  firebase use vexo-v2
  firebase deploy --only database
  firebase deploy --only functions

If prompted for project selection, choose vexo-v2. Do not deploy from an unknown
computer or a shared/public PC.

3) MAINNET API SECRET
---------------------
Set the API key in Firebase Secret Manager (never in JavaScript or GitHub):
  firebase functions:secrets:set TONCENTER_MAINNET_API_KEY
Then deploy functions again:
  firebase deploy --only functions

4) TREASURY AND MAINNET AMOUNTS
-------------------------------
Set the following as Functions environment variables using the current supported
Firebase Functions environment configuration method:
  VEXO_MAINNET_PAYMENTS_ENABLED=false
  VEXO_TON_NETWORK=mainnet
  VEXO_TON_TREASURY=YOUR_MAINNET_TREASURY_WALLET_ADDRESS_HERE
  VEXO_PACKAGE_STARTER_NANO=...
  VEXO_PACKAGE_BOOST_NANO=...
  VEXO_PACKAGE_VAULT_NANO=...
  VEXO_PLAN_HYDROGEN_NANO=...
  VEXO_PLAN_HELIUM_NANO=...
  VEXO_PLAN_URANIUM_NANO=...

Amounts are exact nanoTON integers. 1 TON = 1,000,000,000 nanoTON. Do not use
sample values or guess exchange rates. Set amounts from an approved, timestamped
pricing policy. Review price changes regularly.

5) AUTOMATIC WITHDRAWALS — NOT YET LIVE
---------------------------------------
The current withdrawal path reserves the user's internal balance and records a
request for review. It does NOT sign or send an on-chain TON transaction. This is
intentional: a safe automated payout service needs a separately secured hot-wallet
signer, strict currency-to-TON conversion rules, reserve accounting, per-user and
global limits, replay protection, queue retries, idempotency, monitoring, and an
emergency stop. The signer must not be added to the public website or ordinary
Firebase database. Do not promise users automatic payouts until that service has
been implemented, audited, and tested with controlled funds.

Recommended treasury layout:
  MAIN TREASURY: cold / multisig; never exposed to a web server.
  HOT PAYOUT WALLET: limited balance; dedicated to approved automated payouts.
  GAS RESERVE: separately monitored.
  RECEIVING WALLET: receives user purchases; sweep under treasury policy.

6) GOD ADMIN
------------
GOD is assigned using a trusted server-side bootstrap process. Never add a
visible admin password to the website. From a trusted machine, after Firebase
Admin authentication is configured:
  cd functions
  npm install
  node bootstrap-god.js owner@example.com
The owner must sign out and sign in again so the custom claim refreshes.
Protect the Google account with strong MFA. Keep a second recovery admin process.

7) JETTON CONTRACT
------------------
This repository does not contain a deployed Jetton Master contract. Before
mainnet launch you must finalize:
  - TEP-74-compatible Jetton implementation and metadata;
  - total initial supply and whether minting is permanently disabled or governed;
  - owner/admin and multisig policy;
  - mint, burn, transfer, and wallet deployment tests;
  - independent contract audit;
  - deployed Jetton Master address and verified metadata.
A 1,000,000,000 initial supply is not a hard cap if minting remains enabled.

8) REQUIRED BEFORE REAL USERS / REAL MONEY
------------------------------------------
[ ] Confirm Firebase Authentication authorized domains.
[ ] Review and publish database rules; test unauthenticated and cross-user reads.
[ ] Verify all financial writes are server-side only.
[ ] Verify daily Gold cap and game reward logic with automated tests.
[ ] Fix and test multiplayer settlement race conditions and room lifecycle.
[ ] Approve the Gold/Silver/Bronze/VXB conversion and redemption policy.
[ ] Confirm reserve backing, refund policy, fees, and legal eligibility in each market.
[ ] Build and audit the Jetton contract; deploy only after testnet verification.
[ ] Verify Mainnet incoming payment parser against real explorer transactions.
[ ] Implement and audit the hot-wallet payout worker before enabling auto withdrawals.
[ ] Add monitoring, alerts, backup, incident response, and emergency pause.
[ ] Run a small controlled pilot and reconcile every transaction.

NO REAL MAINNET PAYMENTS ARE ENABLED BY DEFAULT.
Do not paste seed phrases, private keys, passwords, or API keys into ChatGPT.


9) NEW VEXO UI MODULES
---------------------
The premium neon interface now includes a Telegram-inspired floating navigation
bar, responsive dashboard cards, an arena match log, leaderboard, daily missions,
and referral pages.

New callable functions:
  getLeaderboard
  getDailyMissions
  claimDailyMission
  getReferralInfo

Referral code is captured from login.html?ref=CODE and applied only when a new
server profile is first created. Both sides receive 100 Silver in the current
server implementation. Daily mission progress is calculated from the user's
server-recorded match history; rewards are credited by a server transaction.

The UI is English-only. New pages:
  leaderboard.html
  missions.html
  referrals.html

After changing Cloud Functions, redeploy:
  firebase deploy --only functions

Additional support/notification functions:
  listMyNotifications, markNotificationRead
  createSupportTicket, listMySupportTickets
  adminListSupportTickets, adminReplySupportTicket
The GOD panel includes a support inbox. Game bot and multiplayer move endpoints
also have basic server-side rate limiting; this is one anti-abuse layer, not a
complete anti-cheat certification.


PLAYER ID SYSTEM
- Every authenticated account receives a permanent 10-digit numeric Player ID from a server-side callable function.
- IDs are reserved transactionally in playerIdIndex and indexed to the Firebase Auth UID.
- The profile transaction prevents concurrent sign-ins from assigning two IDs to the same account.
- Existing balances and player statistics are never reset when a profile is repaired.
- Players can view and copy their ID on profile.html. GOD lookup uses the same playerIdIndex.
- Deploy the updated Cloud Functions before expecting this version to assign IDs: firebase deploy --only functions --project vexo-v2


FINAL PRE-FIREBASE HARDENING (2026-11-17)
- Player IDs are server-generated 10-digit strings. The playerIdIndex reservation is transactional and profile repair does not overwrite another account.
- The GOD panel searches by Player ID. The profile page displays and copies it.
- Daily Gold earning cap is hard-limited to 100 by the server; the admin control cannot raise it above 100.
- Wallet delta validation, server-side request cooldowns, and match-stat recording and duplicate-stat protection for a repeated match key were tightened.
- Read PRODUCTION-STATUS.txt before deployment. This ZIP has not been deployed or tested against the live Firebase project.
