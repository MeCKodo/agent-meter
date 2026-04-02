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
import {
  CODEX_AUTH_OVERRIDE_ENV_VARS,
  authFilePath,
  buildCodexEnv,
  captureCodexCommand,
  ensureCodexInstalled,
  loadCredentials,
  runCodexCommand,
  runCodexLogin,
} from './core/auth.js';
import { printJson, renderAccountsTable } from './core/output.js';
import { checkAccount } from './core/usage.js';

type GlobalOptions = {
  json?: boolean;
  verbose?: boolean;
  dataDir?: string;
};

type AuthSource = 'environment' | 'codex_home';

type ShellState = {
  defaultAccount: ReturnType<typeof getDefaultAccount>;
  targetAccount: ReturnType<typeof getDefaultAccount>;
  effectiveCodexHome: string | null;
  authOverrideVars: string[];
  codexHomeAccount: ReturnType<typeof getDefaultAccount>;
  effectiveAccount: ReturnType<typeof getDefaultAccount>;
  effectiveAuthSource: AuthSource;
  matchesDefault: boolean;
  matchesTarget: boolean | null;
};

const DEFAULT_DATA_DIR = path.join(os.homedir(), '.agent-meter');
const PRIMARY_CODEX_HOME = path.join(os.homedir(), '.codex');

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

function getActiveAuthOverrideEnvVars(env: NodeJS.ProcessEnv = process.env): string[] {
  return CODEX_AUTH_OVERRIDE_ENV_VARS.filter(name => {
    const value = env[name];
    return typeof value === 'string' && value.trim().length > 0;
  });
}

function warnAuthOverrides(env: NodeJS.ProcessEnv = process.env): boolean {
  const overrides = getActiveAuthOverrideEnvVars(env);
  if (overrides.length === 0) return false;
  process.stderr.write(`\n⚠ ${overrides.join(', ')} found in your shell — this overrides OAuth account switching.\n`);
  process.stderr.write(`  Remove it from ~/.zshrc (or wherever it's set), then open a new terminal.\n\n`);
  return true;
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

function inspectShellState(
  store: AccountStore,
  env: NodeJS.ProcessEnv = process.env,
  targetAccount: ReturnType<typeof getDefaultAccount> = null,
): ShellState {
  const defaultAccount = getDefaultAccount(store);
  const effectiveCodexHome = env.CODEX_HOME || null;
  const authOverrideVars = getActiveAuthOverrideEnvVars(env);
  const codexHomeAccount = findAccountByCodexHome(store, effectiveCodexHome || undefined);
  const effectiveAccount = authOverrideVars.length > 0 ? null : codexHomeAccount;
  const effectiveAuthSource: AuthSource = authOverrideVars.length > 0 ? 'environment' : 'codex_home';

  return {
    defaultAccount,
    targetAccount,
    effectiveCodexHome,
    authOverrideVars,
    codexHomeAccount,
    effectiveAccount,
    effectiveAuthSource,
    matchesDefault: Boolean(defaultAccount && effectiveAccount && defaultAccount.id === effectiveAccount.id),
    matchesTarget: targetAccount ? Boolean(effectiveAccount && targetAccount.id === effectiveAccount.id) : null,
  };
}

function recommendedAccountRef(state: ShellState): string | null {
  return state.targetAccount?.email || state.targetAccount?.label || state.defaultAccount?.email || state.defaultAccount?.label || null;
}

function recommendedFixCommands(state: ShellState): string[] {
  const ref = recommendedAccountRef(state);
  if (!ref) return [];

  return [
    `agent-meter use ${shellQuote(ref)}`,
    `agent-meter codex ${shellQuote(ref)}`,
    `npx -y @kodo/agent-meter@latest use ${shellQuote(ref)}`,
  ];
}

function preferredCommandOutput(stdout: string, stderr: string): string {
  return stdout.trim() || stderr.trim();
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
      warnAuthOverrides();
      return;
    }

    if (opts.json) {
      printJson({ accounts: nextStore.accounts });
      return;
    }
    process.stdout.write(`${renderAccountsTable(nextStore)}\n`);
    warnAuthOverrides();
  });

program
  .command('current')
  .description('show the current default account')
  .action(() => {
    const opts = program.opts<GlobalOptions>();
    const { store } = getStore(opts);
    const state = inspectShellState(store);

    if (opts.json) {
      printJson({
        account: state.defaultAccount,
        effectiveAuthSource: state.effectiveAuthSource,
        effectiveAccount: state.effectiveAccount,
        codexHomeAccount: state.codexHomeAccount,
        effectiveCodexHome: state.effectiveCodexHome,
        authOverrideVars: state.authOverrideVars,
        matchesDefault: state.matchesDefault,
      });
      return;
    }

    if (!state.defaultAccount) {
      process.stdout.write('Default account: none\n');
      process.stdout.write('Default CODEX_HOME=\n');
    } else {
      process.stdout.write(`Default account: ${state.defaultAccount.email || state.defaultAccount.label}\n`);
      process.stdout.write(`Default CODEX_HOME=${state.defaultAccount.codexHome}\n`);
    }

    if (state.authOverrideVars.length > 0) {
      process.stdout.write(`Effective auth source: environment override (${state.authOverrideVars.join(', ')})\n`);
      if (state.effectiveCodexHome) {
        process.stdout.write(`Effective CODEX_HOME=${state.effectiveCodexHome} (currently overridden)\n`);
      }
      if (state.codexHomeAccount) {
        process.stdout.write(`CODEX_HOME account: ${state.codexHomeAccount.email || state.codexHomeAccount.label}\n`);
      }
      process.stdout.write('Shell status: overridden by environment variables\n');
      warnAuthOverrides();
      return;
    }

    if (!state.effectiveCodexHome) {
      process.stdout.write('Effective shell account: none (CODEX_HOME is not set)\n');
      return;
    }

    process.stdout.write(`Effective CODEX_HOME=${state.effectiveCodexHome}\n`);
    if (!state.effectiveAccount) {
      process.stdout.write('Effective shell account: unknown (CODEX_HOME is outside agent-meter store)\n');
      return;
    }

    process.stdout.write(`Effective shell account: ${state.effectiveAccount.email || state.effectiveAccount.label}\n`);
    process.stdout.write(state.matchesDefault ? 'Shell status: matches default account\n' : 'Shell status: differs from default account\n');
  });

program
  .command('use')
  .argument('<account>')
  .description('switch the active Codex account by copying auth.json into ~/.codex')
  .action((ref: string) => {
    const opts = program.opts<GlobalOptions>();
    const { paths, store } = getStore(opts);
    const account = resolveAccountRef(store, ref);
    ensureCodexConfigInitialized(account.codexHome);
    const nextStore = setDefaultAccount(store, account.id);
    writeStore(paths, nextStore);

    warnAuthOverrides();

    const src = authFilePath(account.codexHome);
    if (!fs.existsSync(src)) {
      throw new Error(`auth.json not found at ${src}. Run \`add\` or \`codex login\` first.`);
    }

    const dest = authFilePath(PRIMARY_CODEX_HOME);
    fs.mkdirSync(PRIMARY_CODEX_HOME, { recursive: true });

    if (fs.existsSync(dest)) {
      const isManaged = store.accounts.some(a => {
        try {
          return normalizePathForCompare(authFilePath(a.codexHome)) === normalizePathForCompare(dest);
        } catch { return false; }
      });
      if (!isManaged) {
        const backup = `${dest}.bak`;
        if (!fs.existsSync(backup)) {
          fs.copyFileSync(dest, backup);
          if (!opts.json) {
            process.stderr.write(`Backed up original auth to ${backup}\n`);
          }
        }
      }
    }

    fs.copyFileSync(src, dest);

    const label = account.email || account.label;

    if (opts.json) {
      printJson({
        account: nextStore.accounts.find(item => item.id === account.id) ?? account,
        codexHome: PRIMARY_CODEX_HOME,
      });
      return;
    }

    process.stdout.write(`✓ Switched to '${label}'. Auth copied to ${dest}\n`);
    process.stdout.write('Note: restart any running Codex session for the switch to take effect.\n');
  });

program
  .command('codex')
  .argument('<account>')
  .argument('[codexArgs...]')
  .allowUnknownOption(true)
  .description('launch codex using the selected account')
  .action((ref: string, codexArgs: string[]) => {
    const opts = program.opts<GlobalOptions>();
    const { paths, store } = getStore(opts);
    const account = resolveAccountRef(store, ref);
    ensureCodexConfigInitialized(account.codexHome);
    const nextStore = setDefaultAccount(store, account.id);
    writeStore(paths, nextStore);

    process.stderr.write(`Launching codex with ${account.email || account.label}.\n`);
    runCodexCommand(codexArgs, buildCodexEnv(account.codexHome));
  });

program
  .command('doctor')
  .argument('[account]')
  .description('diagnose why account switching may not be taking effect')
  .action((ref?: string) => {
    const opts = program.opts<GlobalOptions>();
    const { store } = getStore(opts);
    const targetAccount = ref ? resolveAccountRef(store, ref) : null;
    const state = inspectShellState(store, process.env, targetAccount);
    const codexVersion = captureCodexCommand(['--version']);
    const codexLoginStatus = captureCodexCommand(['login', 'status']);
    const recommendations = recommendedFixCommands(state);
    const findings: string[] = [];

    if (state.authOverrideVars.length > 0) {
      findings.push(`Environment variables override account switching: ${state.authOverrideVars.join(', ')}`);
    } else if (!state.effectiveCodexHome) {
      findings.push('CODEX_HOME is not set in the current shell');
    } else if (!state.codexHomeAccount) {
      findings.push('CODEX_HOME points outside the agent-meter account store');
    }

    if (targetAccount) {
      if (state.matchesTarget) {
        findings.push(`Current shell already points at ${targetAccount.email || targetAccount.label}`);
      } else {
        findings.push(`Current shell is not using ${targetAccount.email || targetAccount.label}`);
      }
    } else if (state.defaultAccount && !state.matchesDefault) {
      findings.push('Current shell does not match the default account');
    }

    if (codexVersion.error) {
      findings.push(`Codex CLI is unavailable: ${codexVersion.error}`);
    }

    if (opts.json) {
      printJson({
        targetAccount,
        shell: state,
        codexVersion,
        codexLoginStatus,
        findings,
        recommendations,
      });
      return;
    }

    process.stdout.write('Doctor report\n');
    process.stdout.write(`- Codex CLI: ${codexVersion.ok ? preferredCommandOutput(codexVersion.stdout, codexVersion.stderr) : `unavailable (${codexVersion.error || preferredCommandOutput(codexVersion.stdout, codexVersion.stderr) || 'unknown error'})`}\n`);
    process.stdout.write(`- Default account: ${state.defaultAccount ? (state.defaultAccount.email || state.defaultAccount.label) : 'none'}\n`);
    process.stdout.write(`- Target account: ${targetAccount ? (targetAccount.email || targetAccount.label) : 'none'}\n`);
    process.stdout.write(`- Effective auth source: ${state.effectiveAuthSource}${state.authOverrideVars.length > 0 ? ` (${state.authOverrideVars.join(', ')})` : ''}\n`);
    process.stdout.write(`- Effective CODEX_HOME: ${state.effectiveCodexHome || '(not set)'}\n`);
    process.stdout.write(`- CODEX_HOME account: ${state.codexHomeAccount ? (state.codexHomeAccount.email || state.codexHomeAccount.label) : 'unknown'}\n`);
    process.stdout.write(`- Effective shell account: ${state.effectiveAccount ? (state.effectiveAccount.email || state.effectiveAccount.label) : 'none'}\n`);
    process.stdout.write(`- codex login status: ${codexLoginStatus.ok ? preferredCommandOutput(codexLoginStatus.stdout, codexLoginStatus.stderr) : (codexLoginStatus.error || preferredCommandOutput(codexLoginStatus.stdout, codexLoginStatus.stderr) || 'unknown')}\n`);

    if (state.authOverrideVars.length > 0) {
      process.stdout.write('- Note: `codex login status` does not reveal API-key environment overrides.\n');
    }

    if (findings.length === 0) {
      process.stdout.write('- Diagnosis: no obvious switching problem found.\n');
    } else {
      process.stdout.write('- Findings:\n');
      for (const finding of findings) {
        process.stdout.write(`  - ${finding}\n`);
      }
    }

    if (findings.length > 0 && recommendations.length > 0) {
      process.stdout.write('- Try one of these fixes:\n');
      for (const command of recommendations) {
        process.stdout.write(`  - ${command}\n`);
      }
    } else if (recommendations.length > 0) {
      process.stdout.write('- Tip: if a running Codex window still looks stale, start a fresh process with:\n');
      process.stdout.write(`  - ${recommendations[0]}\n`);
    }
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
