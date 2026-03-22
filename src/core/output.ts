import type { AccountStore, LastCheck } from './accounts.js';

const RESET = '\x1b[0m';
const BOLD = '\x1b[1m';
const DIM = '\x1b[2m';
const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';
const RED = '\x1b[31m';
const CYAN = '\x1b[36m';
const WHITE = '\x1b[37m';
const BG_GREEN = '\x1b[42m';
const BG_YELLOW = '\x1b[43m';
const BG_RED = '\x1b[41m';
const BG_GRAY = '\x1b[100m';

function colorEnabled(): boolean {
  return process.stdout.isTTY !== false && !process.env.NO_COLOR;
}

function c(color: string, text: string): string {
  return colorEnabled() ? `${color}${text}${RESET}` : text;
}

function formatDate(value: string | null): string {
  if (!value) return '-';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  const now = Date.now();
  const diffMs = now - date.getTime();
  const diffMin = Math.floor(diffMs / 60_000);
  if (diffMin < 1) return 'just now';
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  const diffDay = Math.floor(diffHr / 24);
  return `${diffDay}d ago`;
}

function progressBar(remainingPercent: number, width = 12): string {
  const clamped = Math.max(0, Math.min(100, remainingPercent));
  const filled = Math.round((clamped / 100) * width);
  const empty = width - filled;

  let barColor: string;
  if (clamped <= 20) barColor = BG_RED;
  else if (clamped <= 50) barColor = BG_YELLOW;
  else barColor = BG_GREEN;

  if (!colorEnabled()) {
    return `[${'█'.repeat(filled)}${'░'.repeat(empty)}]`;
  }

  return `${barColor}${' '.repeat(filled)}${RESET}${BG_GRAY}${' '.repeat(empty)}${RESET}`;
}

function formatUsage(usedPercent: number | null, remainingPercent: number | null, resetAt: string | null): string {
  if (usedPercent == null && remainingPercent == null) return c(DIM, '-');
  const remaining = remainingPercent ?? (100 - (usedPercent ?? 0));
  const bar = progressBar(remaining);
  const pctText = `${remaining}%`;

  let coloredPct: string;
  if (remaining <= 20) coloredPct = c(RED + BOLD, pctText);
  else if (remaining <= 50) coloredPct = c(YELLOW, pctText);
  else coloredPct = c(GREEN, pctText);

  let resetText = '';
  if (resetAt) {
    const resetDate = new Date(resetAt);
    if (!Number.isNaN(resetDate.getTime())) {
      const diffMs = resetDate.getTime() - Date.now();
      if (diffMs > 0) {
        const totalMin = Math.floor(diffMs / 60_000);
        const days = Math.floor(totalMin / 1440);
        const hours = Math.floor((totalMin % 1440) / 60);
        const mins = totalMin % 60;
        const parts: string[] = [];
        if (days > 0) parts.push(`${days}d`);
        if (hours > 0) parts.push(`${hours}h`);
        parts.push(`${mins}m`);
        resetText = c(DIM, ` ↻${parts.join('')}`);
      }
    }
  }

  return `${bar} ${coloredPct}${resetText}`;
}

function formatPlan(plan: string | null): string {
  if (!plan) return c(DIM, '-');
  const upper = plan.charAt(0).toUpperCase() + plan.slice(1);
  if (plan === 'plus') return c(CYAN + BOLD, upper);
  if (plan === 'team') return c(GREEN + BOLD, upper);
  if (plan === 'pro') return c(YELLOW + BOLD, upper);
  return c(WHITE + BOLD, upper);
}

function formatStatus(lastCheck: LastCheck | null): string {
  if (!lastCheck) return c(DIM, 'Not checked');
  if (lastCheck.ok) return c(GREEN + BOLD, '● OK');
  return c(RED + BOLD, '✗ ') + c(RED, (lastCheck.error || 'Unknown').slice(0, 30));
}

function stripAnsi(str: string): string {
  return str.replace(/\x1b\[[0-9;]*m/g, '');
}

function visibleLength(str: string): number {
  return stripAnsi(str).length;
}

function padVisible(value: string, width: number): string {
  const vLen = visibleLength(value);
  if (vLen >= width) return value;
  return value + ' '.repeat(width - vLen);
}

const BOX_TOP_LEFT = '┌';
const BOX_TOP_RIGHT = '┐';
const BOX_BOTTOM_LEFT = '└';
const BOX_BOTTOM_RIGHT = '┘';
const BOX_H = '─';
const BOX_V = '│';
const BOX_T_DOWN = '┬';
const BOX_T_UP = '┴';
const BOX_T_RIGHT = '├';
const BOX_T_LEFT = '┤';
const BOX_CROSS = '┼';

function renderTable(headers: string[], rows: string[][]): string {
  const colWidths = headers.map((header, i) => {
    const headerLen = visibleLength(header);
    const maxRowLen = rows.reduce((max, row) => Math.max(max, visibleLength(row[i] ?? '')), 0);
    return Math.max(headerLen, maxRowLen) + 2;
  });

  const hLine = (left: string, mid: string, right: string) =>
    left + colWidths.map(w => BOX_H.repeat(w)).join(mid) + right;

  const dataLine = (parts: string[]) =>
    BOX_V + parts.map((part, i) => ' ' + padVisible(part, colWidths[i] - 1)).join(BOX_V) + BOX_V;

  const lines: string[] = [];
  lines.push(c(DIM, hLine(BOX_TOP_LEFT, BOX_T_DOWN, BOX_TOP_RIGHT)));
  lines.push(c(DIM, BOX_V) + headers.map((h, i) => ' ' + c(BOLD, padVisible(h, colWidths[i] - 1))).join(c(DIM, BOX_V)) + c(DIM, BOX_V));
  lines.push(c(DIM, hLine(BOX_T_RIGHT, BOX_CROSS, BOX_T_LEFT)));

  for (const row of rows) {
    lines.push(c(DIM, BOX_V) + row.map((cell, i) => ' ' + padVisible(cell, colWidths[i] - 1)).join(c(DIM, BOX_V)) + c(DIM, BOX_V));
  }

  lines.push(c(DIM, hLine(BOX_BOTTOM_LEFT, BOX_T_UP, BOX_BOTTOM_RIGHT)));
  return lines.join('\n');
}

export function renderAccountsTable(store: AccountStore): string {
  if (store.accounts.length === 0) {
    return c(DIM, 'No accounts configured. Run `add` to get started.');
  }

  const rows = store.accounts.map(account => {
    const isDefault = store.defaultAccountId === account.id;
    return [
      c(isDefault ? WHITE + BOLD : WHITE, `${isDefault ? '* ' : '  '}${account.email || '-'}`),
      formatUsage(account.lastCheck?.primaryUsedPercent ?? null, account.lastCheck?.primaryRemainingPercent ?? null, account.lastCheck?.primaryResetAt ?? null),
      formatUsage(account.lastCheck?.secondaryUsedPercent ?? null, account.lastCheck?.secondaryRemainingPercent ?? null, account.lastCheck?.secondaryResetAt ?? null),
      formatStatus(account.lastCheck),
    ];
  });

  const title = c(BOLD, `Accounts (${store.accounts.length})`);
  return `${title}\n${renderTable(['Email', '5h Remaining', 'Weekly Remaining', 'Status'], rows)}`;
}

export function printJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}
