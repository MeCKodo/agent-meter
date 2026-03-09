# GPT Usage Checker MVP

## Goal
Validate that multiple GPT/Codex accounts can be checked in parallel from one local UI.

## Success criteria
- Paste 2+ account cookie headers
- Run one check
- Get independent per-account results on one screen
- See whether each account is authenticated/invalid and any usage hints we can parse

## Scope
- Local Node server
- Zero database
- Manual cookie input
- Best-effort parsing of `https://chatgpt.com/codex/settings/usage`

## Not in scope
- Auto login
- Encrypted storage
- Full polished parsing
- Production-ready auth management
