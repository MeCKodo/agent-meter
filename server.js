import http from 'node:http';
import { URL } from 'node:url';

const PORT = process.env.PORT || 3030;
const TARGET_URL = 'https://chatgpt.com/codex/settings/usage';

function escapeHtml(str = '') {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => {
      body += chunk;
      if (body.length > 2 * 1024 * 1024) {
        reject(new Error('Payload too large'));
        req.destroy();
      }
    });
    req.on('end', () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch (err) {
        reject(err);
      }
    });
    req.on('error', reject);
  });
}

function extractFirst(text, patterns) {
  for (const pattern of patterns) {
    const m = text.match(pattern);
    if (m?.[1]) return m[1].trim();
  }
  return null;
}

function extractUsageHints(html) {
  const clean = html.replace(/\s+/g, ' ');
  const email = extractFirst(clean, [
    /["']email["']\s*:\s*["']([^"']+@[^"']+)["']/i,
    /["']user_email["']\s*:\s*["']([^"']+@[^"']+)["']/i,
    /["']signedInEmail["']\s*:\s*["']([^"']+@[^"']+)["']/i,
  ]);

  const windowHints = [];
  const patterns = [
    /(5h[^<]{0,120})/i,
    /(weekly[^<]{0,160})/i,
    /(reset[^<]{0,160})/i,
    /(remaining[^<]{0,160})/i,
    /(code review[^<]{0,160})/i,
    /(credit[^<]{0,160})/i,
  ];
  for (const p of patterns) {
    const m = clean.match(p);
    if (m?.[1]) windowHints.push(m[1].trim());
  }

  const percentages = [...clean.matchAll(/(\d{1,3})%/g)].slice(0, 8).map(m => m[0]);
  const snippet = clean.slice(0, 800);

  return {
    email,
    percentages,
    windowHints: [...new Set(windowHints)].slice(0, 8),
    snippet,
  };
}

async function probeAccount(account) {
  const startedAt = Date.now();
  const cookie = (account.cookie || '').trim().replace(/^Cookie:\s*/i, '');
  if (!cookie) {
    return {
      label: account.label || 'Unnamed',
      ok: false,
      status: 0,
      error: 'Missing cookie header',
      elapsedMs: 0,
    };
  }

  try {
    const res = await fetch(TARGET_URL, {
      method: 'GET',
      headers: {
        'user-agent': 'gpt-usage-checker-mvp/0.1',
        'cookie': cookie,
        'accept': 'text/html,application/xhtml+xml',
      },
      redirect: 'follow',
    });

    const text = await res.text();
    const hints = extractUsageHints(text);
    const looksLoggedIn = !!hints.email || !/login|sign in|logged out/i.test(text);

    return {
      label: account.label || 'Unnamed',
      ok: res.ok && looksLoggedIn,
      status: res.status,
      finalUrl: res.url,
      elapsedMs: Date.now() - startedAt,
      email: hints.email,
      percentages: hints.percentages,
      windowHints: hints.windowHints,
      snippet: hints.snippet,
      error: res.ok ? null : `HTTP ${res.status}`,
    };
  } catch (error) {
    return {
      label: account.label || 'Unnamed',
      ok: false,
      status: 0,
      elapsedMs: Date.now() - startedAt,
      error: error.message,
    };
  }
}

function page() {
  return `<!doctype html>
<html><head><meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>GPT Usage Checker</title>
<style>
body{font-family:ui-sans-serif,system-ui,-apple-system,sans-serif;max-width:1100px;margin:32px auto;padding:0 16px;color:#111}
textarea,input{width:100%;box-sizing:border-box;font:inherit}
textarea{min-height:110px}
button{padding:10px 14px;border-radius:10px;border:1px solid #ccc;background:#111;color:#fff;cursor:pointer}
.card{border:1px solid #e5e5e5;border-radius:12px;padding:14px;margin:12px 0}
.row{display:grid;grid-template-columns:1fr 3fr;gap:12px}
.small{color:#666;font-size:14px}
.ok{color:#0a7a35;font-weight:600}.bad{color:#b42318;font-weight:600}
pre{white-space:pre-wrap;word-break:break-word;background:#f7f7f8;padding:10px;border-radius:8px}
</style></head>
<body>
<h1>GPT Usage Checker</h1>
<p class="small">MVP: paste multiple ChatGPT/Codex cookie headers and probe them in parallel.</p>
<div id="accounts"></div>
<div style="display:flex;gap:10px;margin:12px 0 20px">
  <button id="addBtn">+ Add account</button>
  <button id="checkBtn">Run check</button>
</div>
<div id="results"></div>
<script>
const accounts = document.getElementById('accounts');
const results = document.getElementById('results');
function addAccount(label='',cookie=''){
  const div=document.createElement('div');
  div.className='card';
  div.innerHTML='<div class="row"><div><label>Label</label></div><div><input class="label" placeholder="e.g. GPT Plus A" value="'+label.replace(/"/g,'&quot;')+'" /></div></div><div class="row" style="margin-top:10px"><div><label>Cookie</label></div><div><textarea class="cookie" placeholder="Paste full Cookie header from chatgpt.com request">'+cookie.replace(/</g,'&lt;')+'</textarea></div></div>';
  accounts.appendChild(div);
}
addAccount(); addAccount();
document.getElementById('addBtn').onclick=()=>addAccount();
function esc(s){return String(s||'').replace(/[<>&]/g, ch => ({'<':'&lt;','>':'&gt;','&':'&amp;'}[ch]));}
function renderCard(r){
  return '<div class="card">'
    + '<div><strong>' + esc(r.label) + '</strong> — <span class="' + (r.ok ? 'ok' : 'bad') + '">' + (r.ok ? 'OK' : 'FAIL') + '</span> <span class="small">HTTP ' + esc(r.status || '-') + ' · ' + esc(r.elapsedMs) + 'ms</span></div>'
    + '<div class="small">' + esc(r.finalUrl || '') + '</div>'
    + '<div style="margin-top:8px">'
    + '<div><strong>Email:</strong> ' + esc(r.email || '-') + '</div>'
    + '<div><strong>Percentages:</strong> ' + esc(((r.percentages || []).join(', ')) || '-') + '</div>'
    + '<div><strong>Hints:</strong> ' + esc(((r.windowHints || []).join(' | ')) || '-') + '</div>'
    + '<div><strong>Error:</strong> ' + esc(r.error || '-') + '</div>'
    + '</div>'
    + '<details style="margin-top:10px"><summary>Raw snippet</summary><pre>' + esc(r.snippet || '') + '</pre></details>'
    + '</div>';
}
document.getElementById('checkBtn').onclick=async()=>{
  results.innerHTML='<p>Checking…</p>';
  const payload={accounts:[...document.querySelectorAll('#accounts .card')].map(card=>({label:card.querySelector('.label').value,cookie:card.querySelector('.cookie').value})).filter(x=>x.cookie.trim())};
  const res=await fetch('/api/check',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(payload)});
  const data=await res.json();
  results.innerHTML=(data.results||[]).map(renderCard).join('');
};
</script>
</body></html>`;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  if (req.method === 'GET' && url.pathname === '/') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(page());
    return;
  }
  if (req.method === 'POST' && url.pathname === '/api/check') {
    try {
      const body = await readJson(req);
      const accounts = Array.isArray(body.accounts) ? body.accounts.slice(0, 10) : [];
      const results = await Promise.all(accounts.map(probeAccount));
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ results }));
    } catch (error) {
      res.writeHead(400, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: error.message }));
    }
    return;
  }
  res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
  res.end('Not found');
});

server.listen(PORT, () => {
  console.log(`gpt-usage-checker listening on http://localhost:${PORT}`);
});
