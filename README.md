# @kodo/agent-meter

CLI tool for managing multiple Codex OAuth accounts and checking their rate limits / usage.

![screenshot](assets/screenshot.png)

## Install

```bash
npm install -g @kodo/agent-meter
```

Or run directly with npx:

```bash
npx @kodo/agent-meter list
```

## Usage

```bash
# Add a new account (opens browser for OAuth login, then auto-checks usage)
agent-meter add

# List all accounts with real-time usage check
agent-meter list

# Remove an account by email
agent-meter delete <email>
```

## How it works

- `add` creates an isolated `CODEX_HOME` directory, runs `codex login`, then immediately checks usage
- `list` concurrently checks all accounts via the OAuth usage API and displays a table with progress bars
- `delete` removes the account and its `CODEX_HOME` directory
- If a token expires during `list`, you'll be prompted to re-login on the spot

## Prerequisites

- [Codex CLI](https://github.com/openai/codex) installed and available on PATH

## Options

| Flag | Description |
|------|-------------|
| `--json` | Output raw JSON |
| `--verbose` | Enable verbose logging |
| `--data-dir <path>` | Override the default `.data` directory |

## License

MIT
