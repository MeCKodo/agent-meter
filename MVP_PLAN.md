# GPT Usage Checker MVP v3

## Goal
Validate multi-account GPT/Codex checking without Playwright login.

## New approach
- User manually logs into ChatGPT in real Chrome/Chromium profiles
- App scans local browser profiles
- App imports ChatGPT cookies from selected profiles
- App probes all imported accounts concurrently

## Why
- Avoid Playwright login / bot fingerprinting
- Much closer to the real user browser session
- Lower risk of login flow breakage

## Success criteria
- 2+ real browser profiles can be imported
- Imported sessions stay isolated
- One click can check all imported accounts

## Known limitation
- Current MVP only reads plaintext cookie values from Chrome SQLite DB
- If the browser stores only encrypted values on your machine, we need a v4 decryption step
