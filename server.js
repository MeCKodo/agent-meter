import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 3030);
const DATA_DIR = path.join(__dirname, '.data');
const PROFILES_DIR = path.join(__dirname, '.profiles');
const ACCOUNTS_FILE = path.join(DATA_DIR, 'accounts.json');
const TARGET_URL = 'https://chatgpt.com/codex/settings/usage';
const LOGIN_URL = 'https://chatgpt.com/auth/login';

fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(PROFILES_DIR, { recursive: true });

function readAccounts() {
  try {
    return JSON.parse(fs.readFileSync(ACCOUNTS_FILE, 'utf8'));
  } catch {
    return [];
  }
}
function writeAccounts(accounts) {
  fs.writeFileSync(ACCOUNTS_FILE, JSON.stringify(accounts, null, 2));
}
function id() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}
function esc(s = '') {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
function json(res, code, data) {
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(data));
}
function readJson(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => (body += chunk));
    req.on('end', () => {
      try { resolve(body ? JSON.parse(body) : {}); } catch (e) { reject(e); }
    });
    req.on('error', reject);
  });
}

const loginFlows = new Map();

function extractUsageHints(html) {
  const clean = html.replace(/\s+/g, ' ');
  const find = (...patterns) => {
    for (const p of patterns) {
      const m = clean.match(p);
      if (m?.[1]) return m[1].trim();
    }
    return null;
  };
  return {
    email: find(/"email"\s*:\s*"([^"]+@[^\"]+)"/i, /"user_email"\s*:\s*"([^"]+@[^\"]+)"/i),
    percentages: [...clean.matchAll(/(\d{1,3})%/g)].slice(0, 8).map(m => m[0]),
    hints: [
      find(/(5h[^<]{0,120})/i),
      find(/(weekly[^<]{0,160})/i),
      find(/(reset[^<]{0,160})/i),
      find(/(remaining[^<]{0,160})/i),
      find(/(credit[^<]{0,160})/i)
    ].filter(Boolean),
    snippet: clean.slice(0, 1000)
  };
}

async function launchLoginFlow(label) {
  const flowId = id();
  const profileDir = path.join(PROFILES_DIR, flowId);
  fs.mkdirSync(profileDir, { recursive: true });

  const context = await chromium.launchPersistentContext(profileDir, {
    headless: false,
    viewport: { width: 1280, height: 900 }
  });
  const page = context.pages()[0] || await context.newPage();
  const flow = { flowId, label: label || `Account ${new Date().toLocaleTimeString()}`, profileDir, context, status: 'waiting_login', email: null, error: null };
  loginFlows.set(flowId, flow);

  const markReadyIfPossible = async () => {
    try {
      const cookies = await context.cookies('https://chatgpt.com');
      const hasSession = cookies.some(c => ['__Secure-next-auth.session-token', '__Secure-authjs.session-token', '_puid'].includes(c.name));
      if (!hasSession) return;
      const page2 = context.pages()[0] || await context.newPage();
      await page2.goto(TARGET_URL, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
      const html = await page2.content();
      const hints = extractUsageHints(html);
      flow.status = 'ready';
      flow.email = hints.email;
    } catch (e) {
      flow.error = e.message;
    }
  };

  page.on('framenavigated', () => { markReadyIfPossible().catch(() => {}); });
  await page.goto(LOGIN_URL, { waitUntil: 'domcontentloaded' });
  return { flowId, loginUrl: LOGIN_URL };
}

async function finalizeLoginFlow(flowId) {
  const flow = loginFlows.get(flowId);
  if (!flow) throw new Error('Flow not found');
  await (async () => {
    const page = flow.context.pages()[0] || await flow.context.newPage();
    await page.goto(TARGET_URL, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
    const html = await page.content();
    const hints = extractUsageHints(html);
    const accounts = readAccounts();
    const account = {
      id: flow.flowId,
      label: flow.label,
      email: hints.email || flow.email || null,
      profileDir: flow.profileDir,
      createdAt: new Date().toISOString()
    };
    const existing = accounts.filter(a => a.id !== account.id);
    existing.push(account);
    writeAccounts(existing);
    flow.status = 'saved';
    return account;
  })();

  try { await flow.context.close(); } catch {}
  const saved = readAccounts().find(a => a.id === flowId);
  loginFlows.delete(flowId);
  return saved;
}

async function probeAccount(account) {
  const startedAt = Date.now();
  let context;
  try {
    context = await chromium.launchPersistentContext(account.profileDir, {
      headless: true,
      viewport: { width: 1280, height: 900 }
    });
    const page = context.pages()[0] || await context.newPage();
    const res = await page.goto(TARGET_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
    const html = await page.content();
    const hints = extractUsageHints(html);
    const status = res?.status() || 0;
    const loggedOut = /login|sign in|logged out/i.test(html) && !hints.email;
    return {
      id: account.id,
      label: account.label,
      email: hints.email || account.email,
      ok: status >= 200 && status < 400 && !loggedOut,
      status,
      elapsedMs: Date.now() - startedAt,
      finalUrl: page.url(),
      percentages: hints.percentages,
      hints: hints.hints,
      snippet: hints.snippet,
      error: status >= 400 ? `HTTP ${status}` : (loggedOut ? 'Login required' : null)
    };
  } catch (e) {
    return {
      id: account.id,
      label: account.label,
      email: account.email,
      ok: false,
      status: 0,
      elapsedMs: Date.now() - startedAt,
      error: e.message
    };
  } finally {
    if (context) {
      try { await context.close(); } catch {}
    }
  }
}

function pageHtml() {
  return `<!doctype html>
<html><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>GPT Usage Checker</title>
<style>
body{font-family:ui-sans-serif,system-ui,-apple-system,sans-serif;max-width:1100px;margin:32px auto;padding:0 16px;color:#111}
button,input{font:inherit} button{padding:10px 14px;border-radius:10px;border:1px solid #ccc;background:#111;color:#fff;cursor:pointer}
button.secondary{background:#fff;color:#111}.card{border:1px solid #e5e5e5;border-radius:12px;padding:14px;margin:12px 0}.row{display:flex;gap:10px;align-items:center}.small{color:#666;font-size:14px}.ok{color:#0a7a35;font-weight:600}.bad{color:#b42318;font-weight:600} pre{white-space:pre-wrap;word-break:break-word;background:#f7f7f8;padding:10px;border-radius:8px}
</style></head><body>
<h1>GPT Usage Checker</h1>
<p class="small">Login-based MVP: add multiple ChatGPT accounts, save isolated sessions, run checks in parallel.</p>
<div class="card">
  <div class="row">
    <input id="label" placeholder="Account label, e.g. GPT Plus A" />
    <button id="addBtn">Add account</button>
    <button id="checkBtn" class="secondary">Run check</button>
  </div>
  <div id="flow" class="small" style="margin-top:10px"></div>
</div>
<h3>Accounts</h3>
<div id="accounts"></div>
<h3>Results</h3>
<div id="results"></div>
<script>
const qs = s => document.querySelector(s);
function esc(s=''){return String(s).replace(/[<>&]/g, ch => ({'<':'&lt;','>':'&gt;','&':'&amp;'}[ch]));}
async function loadAccounts(){
  const res = await fetch('/api/accounts');
  const data = await res.json();
  qs('#accounts').innerHTML = (data.accounts||[]).map(a => '<div class="card"><strong>'+esc(a.label)+'</strong> <span class="small">'+esc(a.email||'-')+'</span></div>').join('') || '<div class="small">No accounts yet</div>';
}
function renderResults(results){
  qs('#results').innerHTML = (results||[]).map(r => '<div class="card"><div><strong>'+esc(r.label)+'</strong> — <span class="'+(r.ok?'ok':'bad')+'">'+(r.ok?'OK':'FAIL')+'</span> <span class="small">HTTP '+esc(r.status||'-')+' · '+esc(r.elapsedMs)+'ms</span></div><div class="small">'+esc(r.email||'-')+' · '+esc(r.finalUrl||'')+'</div><div style="margin-top:8px"><div><strong>Percentages:</strong> '+esc((r.percentages||[]).join(', ')||'-')+'</div><div><strong>Hints:</strong> '+esc((r.hints||[]).join(' | ')||'-')+'</div><div><strong>Error:</strong> '+esc(r.error||'-')+'</div></div><details style="margin-top:10px"><summary>Raw snippet</summary><pre>'+esc(r.snippet||'')+'</pre></details></div>').join('');
}
async function pollFlow(flowId){
  const timer = setInterval(async()=>{
    const res = await fetch('/api/login/status?flowId='+encodeURIComponent(flowId));
    const data = await res.json();
    qs('#flow').textContent = 'Flow: '+data.status + (data.email ? ' · ' + data.email : '');
    if(data.status === 'ready'){
      clearInterval(timer);
      const save = await fetch('/api/login/finalize',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({flowId})});
      const saved = await save.json();
      qs('#flow').textContent = 'Saved: ' + (saved.account?.label || 'ok') + (saved.account?.email ? ' · ' + saved.account.email : '');
      await loadAccounts();
    }
  }, 2500);
}
qs('#addBtn').onclick = async()=>{
  const label = qs('#label').value.trim();
  const res = await fetch('/api/login/start',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({label})});
  const data = await res.json();
  qs('#flow').textContent = 'Browser opened. Finish login there…';
  pollFlow(data.flowId);
};
qs('#checkBtn').onclick = async()=>{
  qs('#results').innerHTML = '<p>Checking…</p>';
  const res = await fetch('/api/check',{method:'POST'});
  const data = await res.json();
  renderResults(data.results||[]);
};
loadAccounts();
</script></body></html>`;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  if (req.method === 'GET' && url.pathname === '/') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(pageHtml());
    return;
  }
  if (req.method === 'GET' && url.pathname === '/api/accounts') {
    return json(res, 200, { accounts: readAccounts() });
  }
  if (req.method === 'POST' && url.pathname === '/api/login/start') {
    const body = await readJson(req).catch(() => ({}));
    const data = await launchLoginFlow(body.label || '');
    return json(res, 200, data);
  }
  if (req.method === 'GET' && url.pathname === '/api/login/status') {
    const flow = loginFlows.get(url.searchParams.get('flowId'));
    return json(res, 200, flow ? { status: flow.status, email: flow.email, error: flow.error } : { status: 'missing' });
  }
  if (req.method === 'POST' && url.pathname === '/api/login/finalize') {
    try {
      const body = await readJson(req);
      const account = await finalizeLoginFlow(body.flowId);
      return json(res, 200, { account });
    } catch (e) {
      return json(res, 400, { error: e.message });
    }
  }
  if (req.method === 'POST' && url.pathname === '/api/check') {
    const accounts = readAccounts();
    const results = await Promise.all(accounts.map(probeAccount));
    return json(res, 200, { results });
  }
  res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
  res.end('Not found');
});

server.listen(PORT, () => {
  console.log(`gpt-usage-checker listening on http://localhost:${PORT}`);
});
