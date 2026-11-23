// Server dashboard: live audio status for calls in progress, plus a log of calls that have ended.
// "Laptop -> server" is audio from the Teams computer (the extension, over /call); "Local -> server"
// is the operator app's own microphone (over /operator). Same wording the operator uses for the two
// machines in this setup.
const TOKEN_KEY = 'callBridge.operatorToken';
const $ = (id) => document.getElementById(id);

const storage = {
  get() { try { return localStorage.getItem(TOKEN_KEY) || ''; } catch { return ''; } },
  set(v) { try { v ? localStorage.setItem(TOKEN_KEY, v) : localStorage.removeItem(TOKEN_KEY); } catch { /* private mode */ } },
};

let ws = null;
let token = '';
let wantConnected = false;
let retry = 0;
let retryTimer = null;
let calls = [];
let log = [];

function setStatus(text) { $('status').textContent = text; }

// ---- Always-on server health, no token needed (mirrors the operator console) -----------------
const HEALTH_POLL_MS = 5000;
async function pollHealth() {
  try {
    const res = await fetch('/healthz');
    if (!res.ok) throw new Error(String(res.status));
    const health = await res.json();
    $('serverHealth').textContent = `Server: reachable. ${health.teamsComputers} Teams computer(s), ${health.apps} app(s) connected.`;
    $('serverHealth').dataset.ok = 'true';
  } catch {
    $('serverHealth').textContent = 'Server: unreachable.';
    $('serverHealth').dataset.ok = 'false';
  }
}
pollHealth();
setInterval(pollHealth, HEALTH_POLL_MS);

// ---- Rendering ----------------------------------------------------------------------------

/** -60 dBFS (near silence) .. 0 dBFS (full scale) mapped to a 0-100% meter width. */
function levelPercent(dBFS) {
  if (dBFS === null || !Number.isFinite(dBFS)) return 0;
  return Math.max(0, Math.min(100, ((dBFS + 60) / 60) * 100));
}

function meterHtml(label, dir) {
  const state = !dir.connected ? 'off' : dir.flowing ? 'flowing' : 'stalled';
  const text = !dir.connected ? 'not connected' : dir.flowing ? `${dir.dBFS ?? '—'} dBFS` : 'no audio arriving';
  const ok = !dir.connected ? 'off' : dir.flowing;
  return `
    <div class="meter" data-state="${state}">
      <div class="meter-label">
        <span>${label}</span>
        <span class="meter-state" data-ok="${ok}">${text}</span>
      </div>
      <div class="meter-track"><div class="meter-fill" data-pct="${levelPercent(dir.dBFS)}"></div></div>
    </div>`;
}

// The server's CSP has no style-src exception, so inline style="" attributes are silently
// dropped (and even a <style> tag would be): the meter width has to be set via the CSSOM instead.
function paintMeterWidths(root) {
  for (const el of root.querySelectorAll('.meter-fill')) el.style.cssText = `width:${el.dataset.pct}%`;
}

function sinceText(startedAt) {
  const sec = Math.max(0, Math.floor((Date.now() - startedAt) / 1000));
  return `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`;
}

function renderCalls() {
  $('callCount').textContent = calls.length;
  $('noCalls').hidden = calls.length > 0;
  $('calls').innerHTML = calls.map((c) => `
    <li class="dash-call card" data-call="${c.id}">
      <div class="who">
        <strong>${escapeHtml(c.caller)}</strong>
        <span class="since muted">${sinceText(c.startedAt)}</span>
      </div>
      <div class="row">
        ${meterHtml('Laptop → server', c.laptop)}
        ${meterHtml('Local → server', c.local)}
      </div>
    </li>`).join('');
  paintMeterWidths($('calls'));
}

function escapeHtml(s) { return String(s).replace(/[&<>"']/g, (m) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m])); }

function durationText(sec) { return `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`; }
function framesText(frames) { return `${(frames / 50).toFixed(1)} s`; }

function renderLog() {
  $('noLog').hidden = log.length > 0;
  $('logBody').innerHTML = log.slice(0, 100).map((e) => {
    const lost = (e.lostFromLaptop || e.lostFromLocal)
      ? `${framesText(e.lostFromLaptop || 0)} / ${framesText(e.lostFromLocal || 0)}` : '—';
    const hasLoss = !!(e.lostFromLaptop || e.lostFromLocal);
    return `
    <tr${hasLoss ? ' class="has-loss"' : ''}>
      <td>${new Date(e.endedAt).toLocaleTimeString()}</td>
      <td>${escapeHtml(e.caller)}</td>
      <td>${durationText(e.durationSec)}</td>
      <td>${framesText(e.laptopFrames)}</td>
      <td>${framesText(e.localFrames)}</td>
      <td>${lost}</td>
      <td class="reason">${escapeHtml(e.reason || '')}</td>
    </tr>`;
  }).join('');
}

// A live call's "since" clock, and the meters fading from "flowing" to "stalled" between ticks,
// need no new data to look right: redraw them every second from what we already have.
setInterval(() => { if (calls.length) renderCalls(); }, 1000);

// ---- Connection -----------------------------------------------------------------------------

function connect() {
  wantConnected = true;
  clearTimeout(retryTimer);
  setStatus('Connecting…');
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  ws = new WebSocket(`${proto}://${location.host}/dashboard-ws`);
  ws.addEventListener('open', () => ws.send(JSON.stringify({ type: 'hello', token })));
  ws.addEventListener('close', (e) => {
    ws = null;
    if (e.code === 4001) { showLogin('Wrong token.'); return; }
    if (!wantConnected) return;
    setStatus('Disconnected. Reconnecting…');
    $('main').hidden = true;
    retry = Math.min(retry + 1, 6);
    retryTimer = setTimeout(connect, Math.min(1000 * 2 ** retry, 20000));
  });
  ws.addEventListener('message', (e) => {
    let msg;
    try { msg = JSON.parse(e.data); } catch { return; }
    if (msg.type === 'init') {
      retry = 0;
      calls = msg.calls; log = msg.log;
      $('main').hidden = false;
      setStatus('Connected.');
      renderCalls(); renderLog();
    } else if (msg.type === 'tick') {
      calls = msg.calls;
      renderCalls();
    } else if (msg.type === 'ended') {
      log.unshift(msg.entry);
      renderLog();
    }
  });
}

function showLogin(message) {
  wantConnected = false;
  clearTimeout(retryTimer);
  ws?.close();
  ws = null;
  $('main').hidden = true;
  $('login').hidden = false;
  setStatus(message || 'Not connected.');
}

$('login').addEventListener('submit', (e) => {
  e.preventDefault();
  token = $('token').value.trim();
  if (!token) return;
  storage.set($('remember').checked ? token : '');
  $('login').hidden = true;
  connect();
});

$('signOut').addEventListener('click', () => {
  storage.set('');
  token = '';
  showLogin('Signed out.');
  $('login').hidden = false;
});

const remembered = storage.get();
if (remembered) {
  token = remembered;
  $('login').hidden = true;
  connect();
}
