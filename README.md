# gpt-usage-checker

Profile-import MVP for checking multiple GPT/Codex web accounts in parallel.

## Flow
- Open local UI
- In your real Chrome/Chromium browser, create/login different profiles manually
- In the app, click **Rescan profiles**
- Select one profile and **Import session**
- Repeat for multiple accounts
- Click **Run check** to probe all imported accounts concurrently

## Run

```bash
node server.js
```

Open http://localhost:3030

## Notes
- No Playwright login flow.
- The app reads existing local browser profile cookies from your real browser profile path.
- This is still MVP: local-only, no DB, no encryption, best-effort cookie parsing.
- Close the target browser profile before import if its cookie DB is locked.
