# VEXO Milestone 4 — TON transaction matcher hardening

## Implemented
- Split TON address parsing into strict configured-address parsing and safe parsing of untrusted transaction records.
- Malformed incoming transaction destinations now return `false` for that record rather than throwing and aborting the scan.
- Extracted payment matching into `isMatchingMainnetPayment()` for readability and testability.
- Matching still requires destination, exact nano amount, memo, successful transaction flags, and order time window.
- Added Node test cases for exact match, malformed destination, wrong amount, wrong memo, failed transaction, and out-of-window time.


## Validation
- `node --check functions/index.js`: passed.
- `node --check functions/payment-matcher.test.js`: passed.
- Unit tests were not executed in this environment because installing dependencies did not complete. Run `npm install` then `npm run test:payment-matcher` inside `functions/` before deployment.
- This is a code hardening change, not an authorization to enable mainnet payments. Mainnet release still requires end-to-end transaction verification and recovery testing.
