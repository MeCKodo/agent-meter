import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export type SourceUsed = 'oauth';

export interface LastCheck {
  ok: boolean;
  planType: string | null;
  primaryUsedPercent: number | null;
  primaryRemainingPercent: number | null;
  primaryResetAt: string | null;
  secondaryUsedPercent: number | null;
  secondaryRemainingPercent: number | null;
  secondaryResetAt: string | null;
  creditsBalance: number | null;
  creditsUnlimited: boolean | null;
  sourceUsed: SourceUsed;
  checkedAt: string;
  elapsedMs: number;
  error: string | null;
}

export interface Account {
  id: string;
  label: string;
  email: string | null;
  accountId: string | null;
  codexHome: string;
  createdAt: string;
  lastUsedAt: string | null;
  lastCheck: LastCheck | null;
}

export interface AccountStore {
  version: number;
  defaultAccountId: string | null;
  accounts: Account[];
}

export interface DataPaths {
  dataDir: string;
  accountsFile: string;
  codexHomesDir: string;
}

const STORE_VERSION = 1;
const PRIMARY_CODEX_CONFIG = path.join(os.homedir(), '.codex', 'config.toml');

function hasConfigContent(value: string | null): boolean {
  return Boolean(value && value.trim().length > 0);
}

export function createDataPaths(dataDir: string): DataPaths {
  return {
    dataDir,
    accountsFile: path.join(dataDir, 'accounts.json'),
    codexHomesDir: path.join(dataDir, 'codex-homes'),
  };
}

export function ensureDataPaths(paths: DataPaths): void {
  fs.mkdirSync(paths.dataDir, { recursive: true });
  fs.mkdirSync(paths.codexHomesDir, { recursive: true });
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function makeId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function numberOrNull(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function normalizeLastCheck(lastCheck: unknown): LastCheck | null {
  if (!lastCheck || typeof lastCheck !== 'object') return null;
  const input = lastCheck as Record<string, unknown>;
  return {
    ok: Boolean(input.ok),
    planType: typeof input.planType === 'string' ? input.planType : null,
    primaryUsedPercent: numberOrNull(input.primaryUsedPercent),
    primaryRemainingPercent: numberOrNull(input.primaryRemainingPercent),
    primaryResetAt: typeof input.primaryResetAt === 'string' ? input.primaryResetAt : null,
    secondaryUsedPercent: numberOrNull(input.secondaryUsedPercent),
    secondaryRemainingPercent: numberOrNull(input.secondaryRemainingPercent),
    secondaryResetAt: typeof input.secondaryResetAt === 'string' ? input.secondaryResetAt : null,
    creditsBalance: numberOrNull(input.creditsBalance),
    creditsUnlimited: input.creditsUnlimited == null ? null : Boolean(input.creditsUnlimited),
    sourceUsed: 'oauth',
    checkedAt: typeof input.checkedAt === 'string' ? input.checkedAt : nowIso(),
    elapsedMs: numberOrNull(input.elapsedMs) ?? 0,
    error: typeof input.error === 'string' ? input.error : null,
  };
}

export function normalizeAccount(account: Partial<Account> & { id: string; codexHome: string }): Account {
  return {
    id: String(account.id),
    label: account.label?.trim() || 'Codex Account',
    email: account.email ?? null,
    accountId: account.accountId ?? null,
    codexHome: account.codexHome,
    createdAt: account.createdAt || nowIso(),
    lastUsedAt: account.lastUsedAt ?? null,
    lastCheck: normalizeLastCheck(account.lastCheck),
  };
}

function migrateStore(raw: unknown): AccountStore {
  if (Array.isArray(raw)) {
    const accounts = raw
      .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object')
      .filter(item => typeof item.id === 'string' && typeof item.codexHome === 'string')
      .map(item => normalizeAccount({
        id: item.id as string,
        label: typeof item.label === 'string' ? item.label : 'Codex Account',
        email: typeof item.email === 'string' ? item.email : null,
        accountId: typeof item.accountId === 'string' ? item.accountId : null,
        codexHome: item.codexHome as string,
        createdAt: typeof item.createdAt === 'string' ? item.createdAt : nowIso(),
        lastUsedAt: typeof item.lastUsedAt === 'string' ? item.lastUsedAt : null,
        lastCheck: item.lastCheck as LastCheck | null | undefined,
      }));
    return {
      version: STORE_VERSION,
      defaultAccountId: accounts[0]?.id ?? null,
      accounts,
    };
  }

  const input = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {};
  const accounts = Array.isArray(input.accounts)
    ? input.accounts
        .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object')
        .filter(item => typeof item.id === 'string' && typeof item.codexHome === 'string')
        .map(item => normalizeAccount({
          id: item.id as string,
          label: typeof item.label === 'string' ? item.label : 'Codex Account',
          email: typeof item.email === 'string' ? item.email : null,
          accountId: typeof item.accountId === 'string' ? item.accountId : null,
          codexHome: item.codexHome as string,
          createdAt: typeof item.createdAt === 'string' ? item.createdAt : nowIso(),
          lastUsedAt: typeof item.lastUsedAt === 'string' ? item.lastUsedAt : null,
          lastCheck: item.lastCheck as LastCheck | null | undefined,
        }))
    : [];

  const defaultAccountId = typeof input.defaultAccountId === 'string' ? input.defaultAccountId : null;
  return {
    version: STORE_VERSION,
    defaultAccountId: accounts.some(account => account.id === defaultAccountId)
      ? defaultAccountId
      : accounts[0]?.id ?? null,
    accounts,
  };
}

export function readStore(paths: DataPaths): AccountStore {
  ensureDataPaths(paths);
  try {
    const raw = JSON.parse(fs.readFileSync(paths.accountsFile, 'utf8')) as unknown;
    return migrateStore(raw);
  } catch {
    return {
      version: STORE_VERSION,
      defaultAccountId: null,
      accounts: [],
    };
  }
}

export function writeStore(paths: DataPaths, store: AccountStore): void {
  ensureDataPaths(paths);
  const normalized: AccountStore = {
    version: STORE_VERSION,
    defaultAccountId: store.defaultAccountId,
    accounts: store.accounts.map(account => normalizeAccount(account)),
  };
  fs.writeFileSync(paths.accountsFile, JSON.stringify(normalized, null, 2));
}

export function createCodexHome(paths: DataPaths, accountId: string): string {
  const codexHome = path.join(paths.codexHomesDir, accountId);
  fs.mkdirSync(codexHome, { recursive: true });
  ensureCodexConfigInitialized(codexHome);
  return codexHome;
}

export function ensureCodexConfigInitialized(codexHome: string): void {
  fs.mkdirSync(codexHome, { recursive: true });
  const configPath = path.join(codexHome, 'config.toml');
  const current = fs.existsSync(configPath) ? fs.readFileSync(configPath, 'utf8') : null;

  if (hasConfigContent(current)) {
    return;
  }

  if (!fs.existsSync(PRIMARY_CODEX_CONFIG)) {
    if (current == null) {
      fs.writeFileSync(configPath, '');
    }
    return;
  }

  const source = fs.readFileSync(PRIMARY_CODEX_CONFIG, 'utf8');
  if (current == null || !hasConfigContent(current)) {
    fs.writeFileSync(configPath, source);
  }
}

export function updateAccount(
  store: AccountStore,
  nextAccount: Account,
  options: { makeDefault?: boolean } = {}
): AccountStore {
  const existingIndex = store.accounts.findIndex(account => account.id === nextAccount.id);
  const accounts = [...store.accounts];
  if (existingIndex >= 0) {
    accounts[existingIndex] = normalizeAccount(nextAccount);
  } else {
    accounts.push(normalizeAccount(nextAccount));
  }

  const defaultAccountId = options.makeDefault
    ? nextAccount.id
    : (store.defaultAccountId ?? (accounts[0]?.id ?? null));

  return {
    version: STORE_VERSION,
    defaultAccountId,
    accounts,
  };
}

export function markLastUsed(account: Account, at = nowIso()): Account {
  return {
    ...account,
    lastUsedAt: at,
  };
}

export function getDefaultAccount(store: AccountStore): Account | null {
  if (store.accounts.length === 0) return null;
  return store.accounts.find(account => account.id === store.defaultAccountId) ?? store.accounts[0] ?? null;
}

export function setDefaultAccount(store: AccountStore, accountId: string): AccountStore {
  if (!store.accounts.some(account => account.id === accountId)) {
    throw new Error('Account not found');
  }
  return {
    ...store,
    defaultAccountId: accountId,
  };
}

export function resolveAccountRef(store: AccountStore, ref: string): Account {
  const trimmed = ref.trim();
  const byId = store.accounts.find(account => account.id === trimmed);
  if (byId) return byId;

  const byEmail = store.accounts.filter(account => account.email === trimmed);
  if (byEmail.length === 1) return byEmail[0];
  if (byEmail.length > 1) {
    throw new Error(`Email '${trimmed}' matches multiple accounts. Use account id instead.`);
  }

  const matches = store.accounts.filter(account => account.label === trimmed);
  if (matches.length === 1) return matches[0];
  if (matches.length > 1) {
    throw new Error(`Label '${trimmed}' matches multiple accounts. Use account id instead.`);
  }
  throw new Error(`Account '${trimmed}' not found.`);
}

export function removeAccountFromStore(store: AccountStore, accountId: string): AccountStore {
  const accountExists = store.accounts.some(account => account.id === accountId);
  if (!accountExists) {
    throw new Error('Account not found');
  }

  const accounts = store.accounts.filter(account => account.id !== accountId);
  let defaultAccountId = store.defaultAccountId;
  if (defaultAccountId === accountId) {
    const nextDefault = [...accounts].sort((a, b) => {
      return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
    })[0];
    defaultAccountId = nextDefault?.id ?? null;
  }

  return {
    version: STORE_VERSION,
    defaultAccountId,
    accounts,
  };
}
