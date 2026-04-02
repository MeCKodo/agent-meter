#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { Command } from 'commander';
import {
  createCodexHome,
  createDataPaths,
  ensureDataPaths,
  getDefaultAccount,
  makeId,
  markLastUsed,
  nowIso,
  normalizeAccount,
  readStore,
  removeAccountFromStore,
  resolveAccountRef,
  setDefaultAccount,
  ensureCodexConfigInitialized,
  updateAccount,
  writeStore,
  type AccountStore,
} from './core/accounts.js';
import { ensureCodexInstalled, loadCredentials, runCodexLogin } from './core/auth.js';
import { printJson, renderAccountsTable } from './core/output.js';
import { checkAccount } from './core/usage.js';

type GlobalOptions = {
  json?: boolean;
  verbose?: boolean;
  dataDir?: string;
};

const DEFAULT_DATA_DIR = path.join(os.homedir(), '.agent-meter');

function resolveDataDir(opts: GlobalOptions): string {
  if (!opts.dataDir) return DEFAULT_DATA_DIR;
  const resolved = opts.dataDir.startsWith('/') ? opts.dataDir : `${process.cwd()}/${opts.dataDir}`;
  return fs.existsSync(resolved) ? fs.realpathSync(resolved) : resolved;
}

function getStore(opts: GlobalOptions): { paths: ReturnType<typeof createDataPaths>; store: AccountStore } {
  const dataDir = resolveDataDir(opts);
  if (!opts.dataDir) {
    migrateLegacyData(dataDir, Boolean(opts.verbose));
  }
  const paths = createDataPaths(dataDir);
  ensureDataPaths(paths);
  return {
    paths,
    store: readStore(paths),
  };
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\"'\"'`)}'`;
}

const CODEX_AUTH_OVERRIDE_ENV_VARS = [
  'OPENAI_API_KEY',
  'OPENAI_BASE_URL',
] as const;

function getActiveAuthOverrideEnvVars(env: NodeJS.ProcessEnv = process.env): string[] {
  return CODEX_AUTH_OVERRIDE_ENV_VARS.filter(name => {
    const value = env[name];
    return typeof value === 'string' && value.trim().length > 0;
  });
}

function buildUseShellCode(codexHome: string): string {
  return [
    `unset ${CODEX_AUTH_OVERRIDE_ENV_VARS.join(' ')}`,
    `export CODEX_HOME=${shellQuote(codexHome)}`,
  ].join('\n');
}

function normalizePathForCompare(value: string): string {
  try {
    return fs.realpathSync(value);
  } catch {
    return path.resolve(value);
  }
}

function findAccountByCodexHome(store: AccountStore, codexHome: string | undefined): ReturnType<typeof getDefaultAccount> {
  if (!codexHome) return null;
  const target = normalizePathForCompare(codexHome);
  return store.accounts.find(account => normalizePathForCompare(account.codexHome) === target) ?? null;
}

function confirm(question: string): Promise<boolean> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve => {
    rl.question(question, answer => {
      rl.close();
      resolve(answer.trim().toLowerCase() === 'y');
    });
  });
}

function migrateLegacyData(targetDir: string, verbose: boolean): void {
  if (fs.existsSync(path.join(targetDir, 'accounts.json'))) return;

  const legacyDir = path.join(process.cwd(), '.data');
  if (!fs.existsSync(path.join(legacyDir, 'accounts.json'))) return;

  fs.mkdirSync(targetDir, { recursive: true });

  const copyRecursive = (src: string, dest: string) => {
    let stat: fs.Stats;
    try { stat = fs.statSync(src); } catch { return; }
    if (stat.isDirectory()) {
      fs.mkdirSync(dest, { recursive: true });
      for (const child of fs.readdirSync(src)) {
        copyRecursive(path.join(src, child), path.join(dest, child));
      }
    } else {
      fs.copyFileSync(src, dest);
    }
  };

  for (const entry of fs.readdirSync(legacyDir)) {
    copyRecursive(path.join(legacyDir, entry), path.join(targetDir, entry));
  }

  // Rewrite codexHome paths in accounts.json to point to the new location
  const accountsFile = path.join(targetDir, 'accounts.json');
  try {
    const raw = JSON.parse(fs.readFileSync(accountsFile, 'utf8'));
    const legacyHomesDir = path.join(legacyDir, 'codex-homes');
    const newHomesDir = path.join(targetDir, 'codex-homes');
    const accounts = Array.isArray(raw?.accounts) ? raw.accounts : (Array.isArray(raw) ? raw : []);
    for (const account of accounts) {
      if (typeof account.codexHome === 'string' && account.codexHome.startsWith(legacyHomesDir)) {
        account.codexHome = account.codexHome.replace(legacyHomesDir, newHomesDir);
      }
    }
    fs.writeFileSync(accountsFile, JSON.stringify(raw, null, 2));
  } catch { /* best effort */ }

  if (verbose) {
    process.stderr.write(`Migrated data from ${legacyDir} → ${targetDir}\n`);
  }
  process.stdout.write(`✓ Data migrated from .data/ to ${targetDir}\n`);
}

const program = new Command();

program
  .name('agent-meter')
  .description('Multi-account Codex OAuth usage checker')
  .option('--json', 'output JSON')
  .option('--verbose', 'enable verbose logging')
  .option('--data-dir <path>', `override data directory (default: ~/.agent-meter)`);

program
  .command('add')
  .description('add a new account via codex login')
  .action(async () => {
    const opts = program.opts<GlobalOptions>();
    const { paths, store } = getStore(opts);
    ensureCodexInstalled();

    const accountId = makeId();
    const codexHome = createCodexHome(paths, accountId);
    runCodexLogin(codexHome, Boolean(opts.verbose));
    const credentials = loadCredentials(codexHome);
    const label = credentials.email || credentials.accountId || accountId;
    const account = markLastUsed(normalizeAccount({
      id: accountId,
      label,
      email: credentials.email,
      accountId: credentials.accountId,
      codexHome,
      createdAt: nowIso(),
      lastUsedAt: nowIso(),
    }));

    let nextStore = updateAccount(store, account, { makeDefault: store.accounts.length === 0 });
    writeStore(paths, nextStore);

    process.stdout.write(`\n✓ Added account '${account.email || account.label}'.\n`);
    process.stdout.write(`\nChecking usage...\n`);

    const checked = await checkAccount(account);
    const checkedAccount = markLastUsed(normalizeAccount({
      ...checked.account,
      lastCheck: checked.result,
    }), nowIso());
    nextStore = updateAccount(nextStore, checkedAccount);
    writeStore(paths, nextStore);

    if (opts.json) {
      printJson({ accounts: nextStore.accounts });
      return;
    }
    process.stdout.write(`\n${renderAccountsTable(nextStore)}\n`);
  });

program
  .command('list')
  .description('check and list all accounts')
  .action(async () => {
    const opts = program.opts<GlobalOptions>();
    const { paths, store } = getStore(opts);
    if (store.accounts.length === 0) {
      if (opts.json) {
        printJson({ accounts: [] });
      } else {
        process.stdout.write(`${renderAccountsTable(store)}\n`);
      }
      return;
    }

    process.stdout.write('Checking all accounts...\n');
    const results = await Promise.all(store.accounts.map(account => checkAccount(account)));
    let nextStore = store;
    for (const checked of results) {
      const nextAccount = markLastUsed(normalizeAccount({
        ...checked.account,
        lastCheck: checked.result,
      }), nowIso());
      nextStore = updateAccount(nextStore, nextAccount);
    }
    writeStore(paths, nextStore);

    const expired = nextStore.accounts.filter(a =>
      a.lastCheck && !a.lastCheck.ok && a.lastCheck.error?.includes('Unauthorized')
    );

    if (expired.length > 0 && !opts.json) {
      process.stdout.write(`\n${renderAccountsTable(nextStore)}\n\n`);
      for (const account of expired) {
        const yes = await confirm(`⚠ Account '${account.email || account.label}' token expired. Re-login? (y/N) `);
        if (!yes) continue;

        ensureCodexInstalled();
        runCodexLogin(account.codexHome, Boolean(opts.verbose));
        const credentials = loadCredentials(account.codexHome);
        const refreshed = markLastUsed(normalizeAccount({
          ...account,
          email: credentials.email || account.email,
          accountId: credentials.accountId || account.accountId,
        }), nowIso());

        const rechecked = await checkAccount(refreshed);
        const recheckedAccount = markLastUsed(normalizeAccount({
          ...rechecked.account,
          lastCheck: rechecked.result,
        }), nowIso());
        nextStore = updateAccount(nextStore, recheckedAccount);
        writeStore(paths, nextStore);
        process.stdout.write(`✓ Re-logged '${recheckedAccount.email || recheckedAccount.label}'.\n`);
      }
      process.stdout.write(`\n${renderAccountsTable(nextStore)}\n`);
      return;
    }

    if (opts.json) {
      printJson({ accounts: nextStore.accounts });
      return;
    }
    process.stdout.write(`${renderAccountsTable(nextStore)}\n`);
  });

program
  .command('current')
  .description('show the current default account')
  .action(() => {
    const opts = program.opts<GlobalOptions>();
    const { store } = getStore(opts);
    const account = getDefaultAccount(store);
    const effectiveCodexHome = process.env.CODEX_HOME;
    const authOverrideVars = getActiveAuthOverrideEnvVars();
    const codexHomeAccount = findAccountByCodexHome(store, effectiveCodexHome);
    const effectiveAccount = authOverrideVars.length > 0 ? null : codexHomeAccount;
    const effectiveAuthSource = authOverrideVars.length > 0 ? 'environment' : 'codex_home';
    const matchesDefault = Boolean(account && effectiveAccount && account.id === effectiveAccount.id);

    if (opts.json) {
      printJson({
        account,
        effectiveAuthSource,
        effectiveAccount,
        codexHomeAccount,
        effectiveCodexHome: effectiveCodexHome || null,
        authOverrideVars,
        matchesDefault,
      });
      return;
    }

    if (!account) {
      process.stdout.write('Default account: none\n');
      process.stdout.write('Default CODEX_HOME=\n');
    } else {
      process.stdout.write(`Default account: ${account.email || account.label}\n`);
      process.stdout.write(`Default CODEX_HOME=${account.codexHome}\n`);
    }

    if (authOverrideVars.length > 0) {
      process.stdout.write(`Effective auth source: environment override (${authOverrideVars.join(', ')})\n`);
      if (effectiveCodexHome) {
        process.stdout.write(`Effective CODEX_HOME=${effectiveCodexHome} (currently overridden)\n`);
      }
      if (codexHomeAccount) {
        process.stdout.write(`CODEX_HOME account: ${codexHomeAccount.email || codexHomeAccount.label}\n`);
      }
      process.stdout.write('Shell status: overridden by environment variables\n');
      return;
    }

    if (!effectiveCodexHome) {
      process.stdout.write('Effective shell account: none (CODEX_HOME is not set)\n');
      return;
    }

    process.stdout.write(`Effective CODEX_HOME=${effectiveCodexHome}\n`);
    if (!effectiveAccount) {
      process.stdout.write('Effective shell account: unknown (CODEX_HOME is outside agent-meter store)\n');
      return;
    }

    process.stdout.write(`Effective shell account: ${effectiveAccount.email || effectiveAccount.label}\n`);
    process.stdout.write(matchesDefault ? 'Shell status: matches default account\n' : 'Shell status: differs from default account\n');
  });

program
  .command('use')
  .argument('<account>')
  .description('set the default account and print shell code to export CODEX_HOME')
  .action((ref: string) => {
    const opts = program.opts<GlobalOptions>();
    const { paths, store } = getStore(opts);
    const account = resolveAccountRef(store, ref);
    ensureCodexConfigInitialized(account.codexHome);
    const nextStore = setDefaultAccount(store, account.id);
    writeStore(paths, nextStore);
    const shellCode = buildUseShellCode(account.codexHome);

    if (opts.json) {
      printJson({
        account: nextStore.accounts.find(item => item.id === account.id) ?? account,
        export: shellCode,
      });
      return;
    }

    process.stderr.write('Note: restart any running codex session. The switch only affects new codex processes.\n');
    process.stdout.write(`${shellCode}\n`);
  });

program
  .command('delete')
  .argument('<email>')
  .description('remove an account by email')
  .action((email: string) => {
    const opts = program.opts<GlobalOptions>();
    const { paths, store } = getStore(opts);
    const account = resolveAccountRef(store, email);
    if (account.email !== email.trim()) {
      throw new Error(`Account '${email}' not found by email.`);
    }
    const nextStore = removeAccountFromStore(store, account.id);
    writeStore(paths, nextStore);
    if (fs.existsSync(account.codexHome)) {
      fs.rmSync(account.codexHome, { recursive: true, force: true });
    }

    if (opts.json) {
      printJson({ removedAccountId: account.id, accounts: nextStore.accounts });
      return;
    }
    process.stdout.write(`✓ Deleted '${account.email || account.label}'.\n`);
  });

program.parseAsync(process.argv).catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exit(1);
});
