# gpt-usage-checker

Connect-style MVP for checking multiple GPT/Codex accounts in parallel.

## Product flow
- Open local UI
- Click **Connect account**
- A dedicated account window opens
- User logs into ChatGPT manually
- App detects authenticated session and saves that account
- The dashboard auto-refreshes and can immediately **Run check**

## Important
This is **not official OpenAI OAuth**.
It is an OAuth-like connection UX built on top of isolated browser sessions.

## Run

```bash
npm install
npm start
```

Open http://localhost:3030
