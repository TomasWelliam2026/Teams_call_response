const { DEFAULT_SETTINGS } = globalThis.TeamsCallDetector;
const { checkServerUrl } = globalThis.TeamsCallBridge;
const $ = (id) => document.getElementById(id);
const DAY_NAMES = ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'];
const TEXT_FIELDS = ['mode', 'delaySec', 'allowlist', 'blocklist', 'hoursStart', 'hoursEnd',
  'customContext', 'customAcceptAudio', 'customAcceptVideo', 'customAccept', 'customDecline'];
const CHECK_FIELDS = ['enabled', 'bridgeEnabled', 'bridgeKeepMic', 'hoursEnabled', 'notify', 'keepAlive'];
const BRIDGE_LABELS = {
  idle: 'Idle', waiting: 'Answered, waiting for call audio…', connecting: 'Connecting to server…',
  live: 'Live', reconnecting: 'Reconnecting…', ended: 'Ended', error: 'Error',
};

function save(patch) {
  return chrome.storage.sync.set(patch);
}

function setStatus(text) {
  $('status').textContent = text;
}

/**
 * Saves the server URL and token exactly as typed. Called on every keystroke (debounced), not only
 * on "change": change never fires if you type and then click back into Teams or close the panel.
 * Returns an error message for an unusable URL (which is then not saved), or null.
 */
async function saveBridgeFields() {
  const url = $('serverUrl').value.trim();
  const problem = url ? checkServerUrl(url) : null;
  if (!problem) await save({ serverUrl: url });
  await chrome.storage.local.set({ bridgeToken: $('bridgeToken').value.trim() });
  return problem;
}

function validRegex(value) {
  if (!value) return true;
  try { new RegExp(value, 'i'); return true; } catch { return false; }
}

async function loadSettings() {
  const s = { ...DEFAULT_SETTINGS, ...(await chrome.storage.sync.get(null)) };
  for (const id of TEXT_FIELDS) $(id).value = s[id];
  for (const id of CHECK_FIELDS) $(id).checked = !!s[id];
  $('serverUrl').value = s.serverUrl;
  $('bridgeToken').value = (await chrome.storage.local.get('bridgeToken')).bridgeToken || '';
  $('hours').hidden = !s.hoursEnabled;

  $('days').replaceChildren(...DAY_NAMES.map((name, i) => {
    const label = document.createElement('label');
    const box = document.createElement('input');
    box.type = 'checkbox';
    box.value = i;
    box.checked = s.days.includes(i);
    label.append(box, name);
    return label;
  }));
}

function wireSettings() {
  for (const id of TEXT_FIELDS) {
    $(id).addEventListener('change', (e) => {
      const el = e.target;
      if (id.startsWith('custom') && !validRegex(el.value)) {
        setStatus(`Invalid regex in "${el.previousElementSibling.textContent}" — not saved.`);
        return;
      }
      save({ [id]: id === 'delaySec' ? Math.max(0, Number(el.value) || 0) : el.value });
    });
  }
  for (const id of CHECK_FIELDS) {
    $(id).addEventListener('change', (e) => {
      save({ [id]: e.target.checked });
      if (id === 'hoursEnabled') $('hours').hidden = !e.target.checked;
    });
  }
  let bridgeTimer = null;
  for (const id of ['serverUrl', 'bridgeToken']) {
    $(id).addEventListener('input', () => {
      clearTimeout(bridgeTimer);
      bridgeTimer = setTimeout(saveBridgeFields, 300);
    });
    $(id).addEventListener('change', async () => {
      const problem = await saveBridgeFields();
      setStatus(problem ? `${problem} Not saved.` : '');
    });
  }
  $('days').addEventListener('change', () => {
    const days = [...$('days').querySelectorAll('input:checked')].map(b => Number(b.value));
    save({ days });
  });
}

function wireActions() {
  for (const btn of document.querySelectorAll('[data-action]')) {
    btn.addEventListener('click', async () => {
      setStatus('Working…');
      const res = await chrome.runtime.sendMessage({ type: 'panel-action', action: btn.dataset.action });
      setStatus(res?.ok ? `Done: ${res.action} — ${res.caller}` : (res?.message || 'Nothing happened.'));
      renderLog();
    });
  }

  $('bridgeTest').addEventListener('click', async () => {
    const problem = await saveBridgeFields();
    if (problem) { setStatus(problem); return; }
    setStatus('Testing the server connection…');
    const res = await chrome.runtime.sendMessage({ type: 'bridge-test' });
    setStatus(res?.message || 'No answer.');
  });
  $('bridgeStop').addEventListener('click', async () => {
    await chrome.runtime.sendMessage({ type: 'bridge-stop' });
    setStatus('Bridge stopped. Your microphone is back in the call.');
  });

  $('editShortcuts').addEventListener('click', () => chrome.tabs.create({ url: 'chrome://extensions/shortcuts' }));

  $('diagnose').addEventListener('click', async () => {
    const out = $('diagnosis');
    out.hidden = false;
    out.textContent = 'Scanning…';
    const tabs = await chrome.tabs.query({ url: chrome.runtime.getManifest().host_permissions });
    if (!tabs.length) { out.textContent = 'No Teams web tab is open.'; return; }
    const reports = await Promise.all(tabs.map(t =>
      chrome.tabs.sendMessage(t.id, { type: 'diagnose' }, { frameId: 0 }).catch(err => ({ error: err.message }))));
    out.textContent = JSON.stringify(reports, null, 2);
  });
}

async function renderShortcuts() {
  const commands = await chrome.commands.getAll();
  $('shortcuts').replaceChildren(...commands.filter(c => c.description).map((c) => {
    const li = document.createElement('li');
    const kbd = document.createElement('kbd');
    kbd.textContent = c.shortcut || 'not set';
    li.append(c.description, kbd);
    return li;
  }));
}

async function renderLog() {
  const { log = [] } = await chrome.storage.local.get('log');
  if (!log.length) {
    const li = document.createElement('li');
    li.textContent = 'No calls yet.';
    $('log').replaceChildren(li);
    return;
  }
  $('log').replaceChildren(...log.map((entry) => {
    const li = document.createElement('li');
    const time = document.createElement('time');
    time.textContent = new Date(entry.time).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    li.append(time, `${entry.event}${entry.caller ? ` — ${entry.caller}` : ''}`);
    const extra = [entry.source && `via ${entry.source}`, entry.detail].filter(Boolean).join(', ');
    if (extra) {
      const span = document.createElement('span');
      span.className = 'detail';
      span.textContent = extra;
      li.append(span);
    }
    return li;
  }));
}

let bridgeStatus = null;
let bridgeClock = null;

function renderBridge() {
  const st = bridgeStatus || { state: 'idle' };
  $('bridgeStatus').dataset.state = st.state;
  let text = BRIDGE_LABELS[st.state] || st.state;
  if (st.caller) text += ` — ${st.caller}`;
  if (st.state === 'live') {
    const sec = Math.floor((Date.now() - (st.since || st.time)) / 1000);
    text += ` · ${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`;
  }
  if (st.reason && st.state !== 'live') text += `: ${st.reason}`;
  $('bridgeText').textContent = text;
  clearTimeout(bridgeClock);
  if (st.state === 'live') bridgeClock = setTimeout(renderBridge, 1000);
}

chrome.storage.session.get('bridgeStatus').then(({ bridgeStatus: st }) => { bridgeStatus = st; renderBridge(); });

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'session' && changes.bridgeStatus) { bridgeStatus = changes.bridgeStatus.newValue; renderBridge(); }
  if (area === 'local' && changes.log) renderLog();
  if (area === 'sync' && changes.enabled) $('enabled').checked = changes.enabled.newValue;
});

loadSettings().then(wireSettings);
wireActions();
renderShortcuts();
renderLog();
