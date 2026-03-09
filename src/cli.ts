#!/usr/bin/env node
import fs from 'node:fs';
import readline from 'node:readline';
import { Command } from 'commander';
import {
  createCodexHome,
  createDataPaths,
  ensureDataPaths,
  makeId,
  markLastUsed,
  nowIso,
  normalizeAccount,
  readStore,
  removeAccountFromStore,
  resolveAccountRef,
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

function resolveDataDir(opts: GlobalOptions): string {
  if (!opts.dataDir) return `${process.cwd()}/.data`;
  const resolved = opts.dataDir.startsWith('/') ? opts.dataDir : `${process.cwd()}/${opts.dataDir}`;
  return fs.existsSync(resolved) ? fs.realpathSync(resolved) : resolved;
}

function getStore(opts: GlobalOptions): { paths: ReturnType<typeof createDataPaths>; store: AccountStore } {
  const dataDir = resolveDataDir(opts);
  const paths = createDataPaths(dataDir);
  ensureDataPaths(paths);
  return {
    paths,
    store: readStore(paths),
  };
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

const program = new Command();

program
  .name('agent-meter')
  .description('Multi-account Codex OAuth usage checker')
  .option('--json', 'output JSON')
  .option('--verbose', 'enable verbose logging')
  .option('--data-dir <path>', 'override .data directory');

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
