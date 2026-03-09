import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

export interface Credentials {
  authMode: string;
  accessToken: string;
  refreshToken: string;
  idToken: string | null;
  accountId: string | null;
  email: string | null;
  planType: string | null;
  lastRefresh: Date | null;
}

export const REFRESH_URL = 'https://auth.openai.com/oauth/token';
export const OAUTH_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';
export const TOKEN_REFRESH_INTERVAL_MS = 8 * 24 * 60 * 60 * 1000;

export function authFilePath(codexHome: string): string {
  return path.join(codexHome, 'auth.json');
}

function parseLastRefresh(raw: unknown): Date | null {
  if (typeof raw !== 'string') return null;
  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function decodeJwtPayload(token: string | null): Record<string, unknown> | null {
  if (!token) return null;
  const parts = token.split('.');
  if (parts.length < 2) return null;
  const normalized = parts[1].replace(/-/g, '+').replace(/_/g, '/');
  const padded = normalized + '='.repeat((4 - (normalized.length % 4 || 4)) % 4);
  try {
    return JSON.parse(Buffer.from(padded, 'base64').toString('utf8')) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function resolveEmailFromTokens(tokens: Record<string, unknown>): string | null {
  const payload = decodeJwtPayload(asString(tokens.id_token)) || decodeJwtPayload(asString(tokens.access_token));
  const profile = payload?.['https://api.openai.com/profile'];
  const email = asString(payload?.email) || asString((profile as Record<string, unknown> | undefined)?.email);
  return email || null;
}

function resolvePlanFromTokens(tokens: Record<string, unknown>): string | null {
  const payload = decodeJwtPayload(asString(tokens.id_token)) || decodeJwtPayload(asString(tokens.access_token));
  const auth = payload?.['https://api.openai.com/auth'];
  return asString((auth as Record<string, unknown> | undefined)?.chatgpt_plan_type) || asString(payload?.chatgpt_plan_type) || null;
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null;
}

export function ensureCodexInstalled(): void {
  const result = spawnSync('codex', ['--version'], {
    stdio: 'ignore',
    env: process.env,
  });
  if (result.error || result.status !== 0) {
    throw new Error('codex CLI not found. Install it first and ensure it is on PATH.');
  }
}

export function runCodexLogin(codexHome: string, verbose: boolean): void {
  ensureCodexInstalled();
  const result = spawnSync('codex', ['login'], {
    stdio: 'inherit',
    env: {
      ...process.env,
      CODEX_HOME: codexHome,
    },
  });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(`codex login failed with exit code ${result.status ?? 1}`);
  }
  if (verbose) {
    process.stderr.write(`login completed for CODEX_HOME=${codexHome}\n`);
  }
}

export function loadCredentials(codexHome: string): Credentials {
  const file = authFilePath(codexHome);
  if (!fs.existsSync(file)) {
    throw new Error('auth.json not found. Run login first.');
  }

  const json = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
  const apiKey = asString(json.OPENAI_API_KEY);
  if (apiKey) {
    return {
      authMode: 'api_key',
      accessToken: apiKey,
      refreshToken: '',
      idToken: null,
      accountId: null,
      email: null,
      planType: null,
      lastRefresh: null,
    };
  }

  const tokens = (json.tokens && typeof json.tokens === 'object') ? json.tokens as Record<string, unknown> : {};
  const accessToken = asString(tokens.access_token);
  if (!accessToken) {
    throw new Error('auth.json exists but tokens are missing');
  }

  return {
    authMode: asString(json.auth_mode) || 'chatgpt',
    accessToken,
    refreshToken: asString(tokens.refresh_token) || '',
    idToken: asString(tokens.id_token),
    accountId: asString(tokens.account_id),
    email: resolveEmailFromTokens(tokens),
    planType: resolvePlanFromTokens(tokens),
    lastRefresh: parseLastRefresh(json.last_refresh),
  };
}

export function saveCredentials(codexHome: string, credentials: Credentials): void {
  const file = authFilePath(codexHome);
  let json: Record<string, unknown> = {};
  if (fs.existsSync(file)) {
    try {
      json = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
    } catch {
      json = {};
    }
  }

  json.auth_mode = credentials.authMode;
  json.tokens = {
    ...(json.tokens && typeof json.tokens === 'object' ? json.tokens as Record<string, unknown> : {}),
    access_token: credentials.accessToken,
    refresh_token: credentials.refreshToken,
    id_token: credentials.idToken,
    account_id: credentials.accountId,
  };
  json.last_refresh = new Date().toISOString();
  fs.writeFileSync(file, JSON.stringify(json, null, 2));
}

export async function refreshCredentialsIfNeeded(codexHome: string, credentials: Credentials): Promise<Credentials> {
  if (!credentials.refreshToken) return credentials;
  if (credentials.lastRefresh && Date.now() - credentials.lastRefresh.getTime() < TOKEN_REFRESH_INTERVAL_MS) {
    return credentials;
  }
  const refreshed = await refreshCredentials(credentials);
  saveCredentials(codexHome, refreshed);
  return refreshed;
}

export async function refreshCredentials(credentials: Credentials): Promise<Credentials> {
  const response = await fetch(REFRESH_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      client_id: OAUTH_CLIENT_ID,
      grant_type: 'refresh_token',
      refresh_token: credentials.refreshToken,
      scope: 'openid profile email',
    }),
  });

  if (response.status === 401) {
    throw new Error('Refresh token expired or revoked. Run relogin.');
  }
  if (!response.ok) {
    throw new Error(`Token refresh failed with HTTP ${response.status}`);
  }

  const json = await response.json() as Record<string, unknown>;
  return {
    ...credentials,
    accessToken: asString(json.access_token) || credentials.accessToken,
    refreshToken: asString(json.refresh_token) || credentials.refreshToken,
    idToken: asString(json.id_token) || credentials.idToken,
    lastRefresh: new Date(),
  };
}
