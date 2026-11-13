const { checkServerUrl } = globalThis.TeamsCallBridge;
const $ = (id) => document.getElementById(id);
const STATION_LABELS = { off: 'Not set up', invalid: 'Check the URL', connecting: 'Connecting…', connected: 'Connected', disconnected: 'Disconnected' };
// A panel left open while the extension is reloaded can no longer save, and Chrome doesn't say so.
const STALE = 'This panel is out of date (the extension was reloaded). Close it, open it again and re-enter the change.';
let stationStatus = { state: 'off' };

/**
 * Saves the server URL (sync) and token (local, never synced) exactly as typed. Called on every
 * keystroke (debounced), not only on "change": change never fires if you type and then click back
 * into Teams or close the panel. An unusable URL isn't saved.
 */
async function save() {
  const url = $('serverUrl').value.trim();
  try {
    if (!url || !checkServerUrl(url)) await chrome.storage.sync.set({ serverUrl: url });
    await chrome.storage.local.set({ bridgeToken: $('bridgeToken').value.trim() });
  } catch {
    $('connDetail').textContent = STALE;
    $('connDetail').dataset.state = 'invalid';
    return;
  }
  render();
}

/** The status pill and the line under it. What's typed wins over the last reported state. */
function render() {
  const url = $('serverUrl').value.trim();
  const token = $('bridgeToken').value.trim();
  const problem = url ? checkServerUrl(url) : null;
  let host = '';
  try { host = new URL(url).host; } catch { /* not a URL yet */ }
  let state = stationStatus.state;
  let detail;
  if (problem) { state = 'invalid'; detail = problem; }
  else if (!url || !token) { state = 'off'; detail = 'Enter the server URL and access token. It connects automatically.'; }
  else if (state === 'connected') detail = `Connected to ${host}. Incoming Teams calls now ring in the Call Bridge app.`;
  else if (state === 'disconnected') detail = `${stationStatus.reason || 'Connection lost.'} Retrying automatically.`;
  else { state = 'connecting'; detail = `Connecting to ${host}…`; }
  $('stationStatus').dataset.state = state;
  $('stationText').textContent = STATION_LABELS[state];
  $('connDetail').textContent = detail;
  $('connDetail').dataset.state = state;
}

let saveTimer = null;
for (const id of ['serverUrl', 'bridgeToken']) {
  $(id).addEventListener('input', () => {
    render();
    clearTimeout(saveTimer);
    saveTimer = setTimeout(save, 300);
  });
  $(id).addEventListener('change', save);
}

$('showToken').addEventListener('click', () => {
  const show = $('bridgeToken').type === 'password';
  $('bridgeToken').type = show ? 'text' : 'password';
  $('showToken').textContent = show ? 'Hide' : 'Show';
  $('showToken').setAttribute('aria-pressed', show);
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'session' && changes.stationStatus) {
    stationStatus = changes.stationStatus.newValue || { state: 'off' };
    render();
  }
});

(async () => {
  $('serverUrl').value = (await chrome.storage.sync.get('serverUrl')).serverUrl || '';
  $('bridgeToken').value = (await chrome.storage.local.get('bridgeToken')).bridgeToken || '';
  stationStatus = (await chrome.storage.session.get('stationStatus')).stationStatus || stationStatus;
  render();
})();
