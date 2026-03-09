# gpt-usage-checker

Minimal MVP for checking multiple GPT/Codex web accounts in parallel.

## MVP scope
- Local web UI
- Paste multiple account cookie headers manually
- Probe all accounts concurrently
- Show per-account status, detected email, lightweight usage hints, and raw snippet

## Run

```bash
node server.js
```

Open http://localhost:3030

## Input
For each account, paste a full `Cookie:` header copied from an authenticated `chatgpt.com` request.

## Notes
- This MVP is for validation only.
- No DB, no encryption, no auto-login.
- Parsing is best-effort and may need adjustment if OpenAI changes the page.
