import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 3030);
const DATA_DIR = path.join(__dirname, '.data');
const ACCOUNTS_FILE = path.join(DATA_DIR, 'accounts.json');
const TARGET_URL = 'https://chatgpt.com/codex/settings/usage';
const CHATGPT_HOSTS = ['chatgpt.com', '.chatgpt.com'];

fs.mkdirSync(DATA_DIR, { recursive: true });

function readAccounts() {
  try { return JSON.parse(fs.readFileSync(ACCOUNTS_FILE, 'utf8')); } catch { return []; }
}
function writeAccounts(accounts) {
  fs.writeFileSync(ACCOUNTS_FILE, JSON.stringify(accounts, null, 2));
}
function id() { return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`; }
function esc(s = '') {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}
function json(res, code, data) {
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(data));
}
function readJson(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => { try { resolve(body ? JSON.parse(body) : {}); } catch (e) { reject(e); } });
    req.on('error', reject);
  });
}
function execFileP(cmd, args) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) reject(new Error(stderr || err.message)); else resolve(stdout);
    });
  });
}

function detectChromeRoots() {
  const home = os.homedir();
  return [
    path.join(home, '.config', 'google-chrome'),
    path.join(home, '.config', 'chromium'),
    path.join(home, 'Library', 'Application Support', 'Google', 'Chrome'),
    path.join(home, 'Library', 'Application Support', 'Chromium')
  ].filter(p => fs.existsSync(p));
}

function scanProfiles() {
  const roots = detectChromeRoots();
  const found = [];
  for (const root of roots) {
    for (const name of fs.readdirSync(root)) {
      const profileDir = path.join(root, name);
      if (!fs.statSync(profileDir).isDirectory()) continue;
      if (!(name === 'Default' || name.startsWith('Profile '))) continue;
      const cookieDb = path.join(profileDir, 'Network', 'Cookies');
      if (!fs.existsSync(cookieDb)) continue;
      found.push({
        id: Buffer.from(profileDir).toString('base64url'),
        browserRoot: root,
        profileName: name,
        profileDir,
        cookieDb
      });
    }
  }
  return found;
}

async function readCookieHeaderFromChromeDb(cookieDb) {
  const tmp = path.join(os.tmpdir(), `gpt-usage-checker-${Date.now()}-${Math.random().toString(36).slice(2)}.sqlite`);
  fs.copyFileSync(cookieDb, tmp);
  try {
    const sql = `select name, value, encrypted_value, host_key from cookies where host_key like '%chatgpt.com%'`;
    const out = await execFileP('sqlite3', ['-separator', '\t', tmp, sql]);
    const pairs = [];
    for (const line of out.split('\n')) {
      if (!line.trim()) continue;
      const [name, value, encryptedValue, host] = line.split('\t');
      if (!CHATGPT_HOSTS.some(h => (host || '').includes('chatgpt.com'))) continue;
      if (value) pairs.push(`${name}=${value}`);
      else if (encryptedValue) {
        // MVP limitation: Linux Chrome often keeps plaintext value if available; encrypted fallback not implemented yet.
      }
    }
    return [...new Set(pairs)].join('; ');
  } finally {
    try { fs.unlinkSync(tmp); } catch {}
  }
}

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
    snippet: clean.slice(0, 900)
  };
}

async function probeCookie(label, cookieHeader, email) {
  const startedAt = Date.now();
  if (!cookieHeader) return { label, email, ok: false, status: 0, elapsedMs: 0, error: 'No cookie extracted' };
  try {
    const res = await fetch(TARGET_URL, {
      headers: {
        'cookie': cookieHeader,
        'user-agent': 'gpt-usage-checker/0.3',
        'accept': 'text/html,application/xhtml+xml'
      },
      redirect: 'follow'
    });
    const html = await res.text();
    const hints = extractUsageHints(html);
    const loggedOut = /login|sign in|logged out/i.test(html) && !hints.email;
    return {
      label,
      email: hints.email || email || null,
      ok: res.ok && !loggedOut,
      status: res.status,
      elapsedMs: Date.now() - startedAt,
      finalUrl: res.url,
      percentages: hints.percentages,
      hints: hints.hints,
      snippet: hints.snippet,
      error: res.ok ? (loggedOut ? 'Login required' : null) : `HTTP ${res.status}`
    };
  } catch (e) {
    return { label, email, ok: false, status: 0, elapsedMs: Date.now() - startedAt, error: e.message };
  }
}

function pageHtml() {
  return `<!doctype html><html><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width, initial-scale=1"/><title>GPT Usage Checker</title><style>
body{font-family:ui-sans-serif,system-ui,-apple-system,sans-serif;max-width:1100px;margin:32px auto;padding:0 16px;color:#111}
button,input{font:inherit} button{padding:10px 14px;border-radius:10px;border:1px solid #ccc;background:#111;color:#fff;cursor:pointer} button.secondary{background:#fff;color:#111}
.card{border:1px solid #e5e5e5;border-radius:12px;padding:14px;margin:12px 0}.small{color:#666;font-size:14px}.ok{color:#0a7a35;font-weight:600}.bad{color:#b42318;font-weight:600} pre{white-space:pre-wrap;word-break:break-word;background:#f7f7f8;padding:10px;border-radius:8px}
</style></head><body>
<h1>GPT Usage Checker</h1>
<p class="small">No Playwright login. Import sessions from your real Chrome/Chromium profiles.</p>
<div class="card"><div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap"><button id="scanBtn">Rescan profiles</button><button id="checkBtn" class="secondary">Run check</button></div><div id="hint" class="small" style="margin-top:10px">先在真实浏览器 profile 里登录 ChatGPT，再回来导入。</div></div>
<h3>Detected browser profiles</h3><div id="profiles"></div>
<h3>Imported accounts</h3><div id="accounts"></div>
<h3>Results</h3><div id="results"></div>
<script>
const qs=s=>document.querySelector(s); const esc=s=>String(s||'').replace(/[<>&]/g,ch=>({'<':'&lt;','>':'&gt;','&':'&amp;'}[ch]));
async function loadProfiles(){ const r=await fetch('/api/profiles'); const d=await r.json(); qs('#profiles').innerHTML=(d.profiles||[]).map(p=>'<div class="card"><div><strong>'+esc(p.profileName)+'</strong> <span class="small">'+esc(p.browserRoot)+'</span></div><div class="small" style="margin:8px 0">'+esc(p.profileDir)+'</div><button onclick="importProfile(\''+esc(p.id)+'\')">Import session</button></div>').join('')||'<div class="small">No browser profiles found</div>'; }
async function loadAccounts(){ const r=await fetch('/api/accounts'); const d=await r.json(); qs('#accounts').innerHTML=(d.accounts||[]).map(a=>'<div class="card"><strong>'+esc(a.label)+'</strong> <span class="small">'+esc(a.email||'-')+'</span><div class="small">'+esc(a.profileDir)+'</div></div>').join('')||'<div class="small">No imported accounts</div>'; }
async function importProfile(id){ qs('#hint').textContent='Importing session…'; const r=await fetch('/api/import',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({profileId:id})}); const d=await r.json(); qs('#hint').textContent=d.error?('Import failed: '+d.error):('Imported: '+(d.account?.label||'ok')); await loadAccounts(); }
function render(results){ qs('#results').innerHTML=(results||[]).map(r=>'<div class="card"><div><strong>'+esc(r.label)+'</strong> — <span class="'+(r.ok?'ok':'bad')+'">'+(r.ok?'OK':'FAIL')+'</span> <span class="small">HTTP '+esc(r.status||'-')+' · '+esc(r.elapsedMs)+'ms</span></div><div class="small">'+esc(r.email||'-')+' · '+esc(r.finalUrl||'')+'</div><div style="margin-top:8px"><div><strong>Percentages:</strong> '+esc((r.percentages||[]).join(', ')||'-')+'</div><div><strong>Hints:</strong> '+esc((r.hints||[]).join(' | ')||'-')+'</div><div><strong>Error:</strong> '+esc(r.error||'-')+'</div></div><details style="margin-top:10px"><summary>Raw snippet</summary><pre>'+esc(r.snippet||'')+'</pre></details></div>').join(''); }
qs('#scanBtn').onclick=loadProfiles; qs('#checkBtn').onclick=async()=>{ qs('#results').innerHTML='<p>Checking…</p>'; const r=await fetch('/api/check',{method:'POST'}); const d=await r.json(); render(d.results||[]); };
loadProfiles(); loadAccounts();
</script></body></html>`;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  if (req.method === 'GET' && url.pathname === '/') { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end(pageHtml()); return; }
  if (req.method === 'GET' && url.pathname === '/api/profiles') { return json(res, 200, { profiles: scanProfiles() }); }
  if (req.method === 'GET' && url.pathname === '/api/accounts') { return json(res, 200, { accounts: readAccounts() }); }
  if (req.method === 'POST' && url.pathname === '/api/import') {
    try {
      const body = await readJson(req);
      const profile = scanProfiles().find(p => p.id === body.profileId);
      if (!profile) return json(res, 404, { error: 'Profile not found' });
      const cookieHeader = await readCookieHeaderFromChromeDb(profile.cookieDb);
      const probe = await probeCookie(profile.profileName, cookieHeader, null);
      const accounts = readAccounts().filter(a => a.id !== profile.id);
      const account = { id: profile.id, label: profile.profileName, email: probe.email || null, profileDir: profile.profileDir, cookieDb: profile.cookieDb, cookieHeader, importedAt: new Date().toISOString() };
      accounts.push(account);
      writeAccounts(accounts);
      return json(res, 200, { account, probe });
    } catch (e) { return json(res, 400, { error: e.message }); }
  }
  if (req.method === 'POST' && url.pathname === '/api/check') {
    const accounts = readAccounts();
    const results = await Promise.all(accounts.map(a => probeCookie(a.label, a.cookieHeader, a.email)));
    return json(res, 200, { results });
  }
  res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }); res.end('Not found');
});
server.listen(PORT, () => console.log(`gpt-usage-checker listening on http://localhost:${PORT}`));
