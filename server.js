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
const HOME_URL = 'https://chatgpt.com/';

fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(PROFILES_DIR, { recursive: true });

function readAccounts() {
  try { return JSON.parse(fs.readFileSync(ACCOUNTS_FILE, 'utf8')); } catch { return []; }
}
function writeAccounts(accounts) {
  fs.writeFileSync(ACCOUNTS_FILE, JSON.stringify(accounts, null, 2));
}
function id() { return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`; }
function json(res, code, data) {
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(data));
}
function esc(s = '') {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}
function readJson(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => { try { resolve(body ? JSON.parse(body) : {}); } catch (e) { reject(e); } });
    req.on('error', reject);
  });
}

const connectFlows = new Map();

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
    email: find(/"email"\s*:\s*"([^"]+@[^"]+)"/i, /"user_email"\s*:\s*"([^"]+@[^"]+)"/i, /"signedInEmail"\s*:\s*"([^"]+@[^"]+)"/i),
    percentages: [...clean.matchAll(/(\d{1,3})%/g)].slice(0, 8).map(m => m[0]),
    hints: [find(/(5h[^<]{0,120})/i), find(/(weekly[^<]{0,160})/i), find(/(reset[^<]{0,160})/i), find(/(remaining[^<]{0,160})/i), find(/(credit[^<]{0,160})/i)].filter(Boolean),
    snippet: clean.slice(0, 1000)
  };
}

async function probeInContext(context, label, existingEmail = null) {
  const startedAt = Date.now();
  const page = context.pages()[0] || await context.newPage();
  const res = await page.goto(TARGET_URL, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => null);
  const html = await page.content();
  const hints = extractUsageHints(html);
  const status = res?.status() || 0;
  const loggedOut = /login|sign in|logged out/i.test(html) && !hints.email;
  return {
    label,
    email: hints.email || existingEmail || null,
    ok: status >= 200 && status < 400 && !loggedOut,
    status,
    elapsedMs: Date.now() - startedAt,
    finalUrl: page.url(),
    percentages: hints.percentages,
    hints: hints.hints,
    snippet: hints.snippet,
    error: status >= 400 ? `HTTP ${status}` : (loggedOut ? 'Login required' : null)
  };
}

async function startConnect(label) {
  const flowId = id();
  const profileDir = path.join(PROFILES_DIR, flowId);
  fs.mkdirSync(profileDir, { recursive: true });

  const context = await chromium.launchPersistentContext(profileDir, {
    headless: false,
    viewport: { width: 1280, height: 900 }
  });
  const page = context.pages()[0] || await context.newPage();
  const flow = { flowId, label: label || `GPT Account ${new Date().toLocaleTimeString()}`, profileDir, context, status: 'waiting', email: null, lastError: null };
  connectFlows.set(flowId, flow);

  const detect = async () => {
    try {
      const cookies = await context.cookies('https://chatgpt.com');
      const hasSession = cookies.some(c => ['__Secure-next-auth.session-token', '__Secure-authjs.session-token', '_puid'].includes(c.name));
      if (!hasSession) return;
      const result = await probeInContext(context, flow.label, flow.email).catch(() => null);
      if (result?.ok || result?.email) {
        flow.status = 'ready';
        flow.email = result.email || flow.email;
      }
    } catch (e) {
      flow.lastError = e.message;
    }
  };

  page.on('framenavigated', () => { detect().catch(() => {}); });
  page.on('load', () => { detect().catch(() => {}); });
  await page.goto(HOME_URL, { waitUntil: 'domcontentloaded' });
  return { flowId };
}

async function finalizeConnect(flowId) {
  const flow = connectFlows.get(flowId);
  if (!flow) throw new Error('Flow not found');
  const probe = await probeInContext(flow.context, flow.label, flow.email);
  const accounts = readAccounts().filter(a => a.id !== flow.flowId);
  const account = {
    id: flow.flowId,
    label: flow.label,
    email: probe.email,
    profileDir: flow.profileDir,
    createdAt: new Date().toISOString()
  };
  accounts.push(account);
  writeAccounts(accounts);
  flow.status = 'saved';
  try { await flow.context.close(); } catch {}
  connectFlows.delete(flowId);
  return { account, probe };
}

async function checkSavedAccount(account) {
  let context;
  try {
    context = await chromium.launchPersistentContext(account.profileDir, {
      headless: true,
      viewport: { width: 1280, height: 900 }
    });
    return await probeInContext(context, account.label, account.email);
  } catch (e) {
    return { label: account.label, email: account.email, ok: false, status: 0, elapsedMs: 0, error: e.message };
  } finally {
    if (context) try { await context.close(); } catch {}
  }
}

function pageHtml() {
  return `<!doctype html><html><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width, initial-scale=1"/><title>GPT Usage Checker</title><style>
body{font-family:ui-sans-serif,system-ui,-apple-system,sans-serif;max-width:1100px;margin:32px auto;padding:0 16px;color:#111}
button,input{font:inherit} button{padding:10px 14px;border-radius:10px;border:1px solid #ccc;background:#111;color:#fff;cursor:pointer} button.secondary{background:#fff;color:#111}
.card{border:1px solid #e5e5e5;border-radius:12px;padding:14px;margin:12px 0}.row{display:flex;gap:10px;align-items:center;flex-wrap:wrap}.small{color:#666;font-size:14px}.ok{color:#0a7a35;font-weight:600}.bad{color:#b42318;font-weight:600} pre{white-space:pre-wrap;word-break:break-word;background:#f7f7f8;padding:10px;border-radius:8px}
</style></head><body>
<h1>GPT Usage Checker</h1>
<p class="small">Connect-style multi-account checker. Not official OAuth.</p>
<div class="card"><div class="row"><input id="label" placeholder="Account label, e.g. GPT Plus A" /><button id="connectBtn">Connect account</button><button id="checkBtn" class="secondary">Run check</button></div><div id="flow" class="small" style="margin-top:10px"></div></div>
<h3>Connected accounts</h3><div id="accounts"></div><h3>Results</h3><div id="results"></div>
<script>
const qs=s=>document.querySelector(s); const esc=s=>String(s||'').replace(/[<>&]/g,ch=>({'<':'&lt;','>':'&gt;','&':'&amp;'}[ch]));
async function loadAccounts(){ const r=await fetch('/api/accounts'); const d=await r.json(); qs('#accounts').innerHTML=(d.accounts||[]).map(a=>'<div class="card"><strong>'+esc(a.label)+'</strong> <span class="small">'+esc(a.email||'-')+'</span><div class="small">'+esc(a.profileDir)+'</div></div>').join('')||'<div class="small">No connected accounts</div>'; }
function renderResults(results){ qs('#results').innerHTML=(results||[]).map(r=>'<div class="card"><div><strong>'+esc(r.label)+'</strong> — <span class="'+(r.ok?'ok':'bad')+'">'+(r.ok?'OK':'FAIL')+'</span> <span class="small">HTTP '+esc(r.status||'-')+' · '+esc(r.elapsedMs)+'ms</span></div><div class="small">'+esc(r.email||'-')+' · '+esc(r.finalUrl||'')+'</div><div style="margin-top:8px"><div><strong>Percentages:</strong> '+esc((r.percentages||[]).join(', ')||'-')+'</div><div><strong>Hints:</strong> '+esc((r.hints||[]).join(' | ')||'-')+'</div><div><strong>Error:</strong> '+esc(r.error||'-')+'</div></div><details style="margin-top:10px"><summary>Raw snippet</summary><pre>'+esc(r.snippet||'')+'</pre></details></div>').join(''); }
async function poll(flowId){ const timer=setInterval(async()=>{ const r=await fetch('/api/connect/status?flowId='+encodeURIComponent(flowId)); const d=await r.json(); qs('#flow').textContent='Connect flow: '+d.status+(d.email?' · '+d.email:'')+(d.lastError?' · '+d.lastError:''); if(d.status==='ready'){ clearInterval(timer); const save=await fetch('/api/connect/finalize',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({flowId})}); const out=await save.json(); qs('#flow').textContent='Connected: '+(out.account?.label||'ok')+(out.account?.email?' · '+out.account.email:''); await loadAccounts(); if(out.probe) renderResults([out.probe]); } },2500); }
qs('#connectBtn').onclick=async()=>{ const label=qs('#label').value.trim(); const r=await fetch('/api/connect/start',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({label})}); const d=await r.json(); qs('#flow').textContent='Browser opened. Finish ChatGPT login there.'; poll(d.flowId); };
qs('#checkBtn').onclick=async()=>{ qs('#results').innerHTML='<p>Checking…</p>'; const r=await fetch('/api/check',{method:'POST'}); const d=await r.json(); renderResults(d.results||[]); };
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
  if (req.method === 'GET' && url.pathname === '/api/accounts') return json(res, 200, { accounts: readAccounts() });
  if (req.method === 'POST' && url.pathname === '/api/connect/start') {
    const body = await readJson(req).catch(() => ({}));
    const data = await startConnect(body.label || '');
    return json(res, 200, data);
  }
  if (req.method === 'GET' && url.pathname === '/api/connect/status') {
    const flow = connectFlows.get(url.searchParams.get('flowId'));
    return json(res, 200, flow ? { status: flow.status, email: flow.email, lastError: flow.lastError } : { status: 'missing' });
  }
  if (req.method === 'POST' && url.pathname === '/api/connect/finalize') {
    try {
      const body = await readJson(req);
      const out = await finalizeConnect(body.flowId);
      return json(res, 200, out);
    } catch (e) {
      return json(res, 400, { error: e.message });
    }
  }
  if (req.method === 'POST' && url.pathname === '/api/check') {
    const accounts = readAccounts();
    const results = await Promise.all(accounts.map(checkSavedAccount));
    return json(res, 200, { results });
  }
  res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
  res.end('Not found');
});

server.listen(PORT, () => console.log(`gpt-usage-checker listening on http://localhost:${PORT}`));
