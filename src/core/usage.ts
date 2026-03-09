import type { Account, LastCheck } from './accounts.js';
import type { Credentials } from './auth.js';
import { loadCredentials, refreshCredentialsIfNeeded } from './auth.js';

const DEFAULT_USAGE_URL = 'https://chatgpt.com/backend-api/wham/usage';
const FALLBACK_USAGE_URL = 'https://chatgpt.com/api/codex/usage';

interface UsagePayload {
  plan_type?: string;
  rate_limit?: {
    primary_window?: {
      used_percent?: number;
      reset_at?: number;
    };
    secondary_window?: {
      used_percent?: number;
      reset_at?: number;
    };
  };
  credits?: {
    balance?: number | string;
    unlimited?: boolean;
  };
}

export interface CheckResult {
  account: Account;
  result: LastCheck;
}

function numberOrNull(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function clampPercent(value: number): number {
  return Math.max(0, Math.min(100, Math.round(value)));
}

function usageHeaders(credentials: Credentials): Record<string, string> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${credentials.accessToken}`,
    Accept: 'application/json',
    'User-Agent': 'codex-cli',
  };
  if (credentials.accountId) {
    headers['ChatGPT-Account-Id'] = credentials.accountId;
  }
  return headers;
}

async function fetchUsage(credentials: Credentials): Promise<{ payload: UsagePayload; elapsedMs: number }> {
  const startedAt = Date.now();
  let response = await fetch(DEFAULT_USAGE_URL, { headers: usageHeaders(credentials) });
  if (response.status === 404) {
    response = await fetch(FALLBACK_USAGE_URL, { headers: usageHeaders(credentials) });
  }
  if (response.status === 401 || response.status === 403) {
    throw new Error('Unauthorized. Run relogin.');
  }
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Usage API failed with HTTP ${response.status}: ${text.slice(0, 200)}`);
  }
  return {
    payload: await response.json() as UsagePayload,
    elapsedMs: Date.now() - startedAt,
  };
}

function normalizeSuccess(account: Account, credentials: Credentials, usage: { payload: UsagePayload; elapsedMs: number }): LastCheck {
  const primary = usage.payload.rate_limit?.primary_window;
  const secondary = usage.payload.rate_limit?.secondary_window;
  const credits = usage.payload.credits;
  const primaryUsed = numberOrNull(primary?.used_percent);
  const secondaryUsed = numberOrNull(secondary?.used_percent);
  return {
    ok: true,
    planType: usage.payload.plan_type || credentials.planType || null,
    primaryUsedPercent: primaryUsed,
    primaryRemainingPercent: primaryUsed == null ? null : clampPercent(100 - primaryUsed),
    primaryResetAt: primary?.reset_at ? new Date(primary.reset_at * 1000).toISOString() : null,
    secondaryUsedPercent: secondaryUsed,
    secondaryRemainingPercent: secondaryUsed == null ? null : clampPercent(100 - secondaryUsed),
    secondaryResetAt: secondary?.reset_at ? new Date(secondary.reset_at * 1000).toISOString() : null,
    creditsBalance: numberOrNull(credits?.balance),
    creditsUnlimited: credits?.unlimited == null ? null : Boolean(credits.unlimited),
    sourceUsed: 'oauth',
    checkedAt: new Date().toISOString(),
    elapsedMs: usage.elapsedMs,
    error: null,
  };
}

function normalizeFailure(error: Error): LastCheck {
  return {
    ok: false,
    planType: null,
    primaryUsedPercent: null,
    primaryRemainingPercent: null,
    primaryResetAt: null,
    secondaryUsedPercent: null,
    secondaryRemainingPercent: null,
    secondaryResetAt: null,
    creditsBalance: null,
    creditsUnlimited: null,
    sourceUsed: 'oauth',
    checkedAt: new Date().toISOString(),
    elapsedMs: 0,
    error: error.message,
  };
}

export async function checkAccount(account: Account): Promise<CheckResult> {
  try {
    let credentials = loadCredentials(account.codexHome);
    credentials = await refreshCredentialsIfNeeded(account.codexHome, credentials);
    const usage = await fetchUsage(credentials);
    return {
      account: {
        ...account,
        email: credentials.email || account.email,
        accountId: credentials.accountId || account.accountId,
      },
      result: normalizeSuccess(account, credentials, usage),
    };
  } catch (error) {
    return {
      account,
      result: normalizeFailure(error as Error),
    };
  }
}
