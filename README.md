# gpt-usage-checker

Login-based MVP for checking multiple GPT/Codex web accounts in parallel.

## Flow
- Open local UI
- Click **Add account**
- A dedicated Playwright browser profile opens
- You log in to ChatGPT manually
- App stores that isolated session as one account
- Click **Run check** to probe all accounts concurrently

## Run

```bash
npm install
npm start
```

Open http://localhost:3030

## Notes
- MVP only: local-only, no database, no encryption.
- Each account uses its own persistent browser profile under `.profiles/`.
- Best-effort parsing of `https://chatgpt.com/codex/settings/usage`.
- This is not official OAuth; it captures your authenticated session from an isolated local browser context you log into yourself.
