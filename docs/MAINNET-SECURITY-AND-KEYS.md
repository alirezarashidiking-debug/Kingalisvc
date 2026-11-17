# VEXO Mainnet security and secrets map

| Item | Where it belongs | Never put it here |
|---|---|---|
| Firebase Web App config | `js/firebase-config.js` | Do not confuse it with Admin credentials |
| Firebase Admin service identity | Google Cloud service identity / ADC | GitHub, frontend, RTDB |
| TONCenter Mainnet API key | Firebase Secret Manager: `TONCENTER_MAINNET_API_KEY` | HTML, JS, ZIP, `.env` committed to Git |
| Main treasury address | Functions environment `VEXO_TON_TREASURY` | N/A; public address is not a secret |
| Hot wallet mnemonic/private key | Dedicated payout signer secret store only, after audit | Website, GitHub, RTDB, this chat |
| Jetton Master address | Public project config after verified deployment | Never invent an address |
| TON Connect manifest | `tonconnect-manifest.json` | Must use final public HTTPS site URL |

## Current operational locks
- `VEXO_MAINNET_PAYMENTS_ENABLED` defaults to `false`.
- Payment functions require `VEXO_TON_NETWORK=mainnet`.
- Purchase amounts must be configured as exact nanoTON integers.
- Automatic withdrawal signing is not implemented in this package. The existing
  request path reserves internal balance and records a review request only.
- No Jetton contract is deployed by this package.

## Key rotation
If a secret was ever committed to a public repository, treat it as compromised:
revoke it at its provider, issue a replacement, update Secret Manager, redeploy,
and inspect repository history. Deleting a file in a later commit does not erase
the key from Git history.
