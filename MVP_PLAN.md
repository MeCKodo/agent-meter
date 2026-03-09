# GPT Usage Checker MVP v2

## Goal
Validate a better UX for multi-account GPT/Codex checking:
- Add account by login, not manual cookie paste
- Store each account in an isolated browser profile
- Probe all accounts in parallel from one dashboard

## User flow
1. Open local dashboard
2. Click **Add account**
3. Playwright opens a dedicated browser profile
4. User logs into ChatGPT manually
5. App detects authenticated session and saves the account profile
6. Click **Run check** to probe all saved accounts concurrently

## Why this version
- Much better than manual cookie paste
- Still minimal cost
- Good enough to validate whether multi-account checking is possible

## Success criteria
- 2+ accounts can be added independently
- Saved accounts remain isolated
- One click can check all saved accounts
- Per-account result card is visible

## Not in scope
- Official OAuth
- Encryption / secret storage hardening
- Production parsing accuracy
- Desktop packaging
