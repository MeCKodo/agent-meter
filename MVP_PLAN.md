# GPT Usage Checker MVP vNext

## Goal
Match the desired UX:
- Click a button
- Connect a GPT account
- Return to dashboard
- Check status immediately
- Repeat for multiple accounts

## UX shape
1. Connect account
2. Open dedicated isolated browser window
3. User logs in manually
4. App detects authenticated session
5. Save account card
6. Run check across all connected accounts

## Truth in implementation
- This is not real OpenAI OAuth
- It is a connect-style session capture flow
- Each account lives in its own isolated persistent browser profile

## Success criteria
- 2+ accounts can be connected independently
- Dashboard auto-updates after connection
- One click checks all connected accounts
