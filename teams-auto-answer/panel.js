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

// ---- Your voice: the app's microphone going into the Teams call (see background.js showVoice) ----
const VOICE_STALE_MS = 4000; // no report for this long: the call (or the Teams tab) is gone
const VOICE = {
  off: { label: 'No call', pill: 'off', detail: 'Shows here while a call is bridged to the app.' },
  sending: { label: 'Sent to the caller', pill: 'connected', detail: 'The app\'s voice is going into the Teams call.' },
  muted: { label: 'Muted', pill: 'connecting', detail: 'Muted (in the app or in Teams): the caller hears nothing.' },
  waiting: { label: 'Nothing from the app', pill: 'disconnected', detail: 'No voice is arriving from the app. Is the call taken there, and is its microphone working?' },
  blocked: { label: 'Not reaching the caller', pill: 'disconnected', detail: 'The app\'s voice arrives here, but Teams isn\'t sending it to the caller.' },
};
let voice = null;

function renderVoice() {
  const fresh = voice && Date.now() - voice.time < VOICE_STALE_MS;
  const state = fresh ? voice.state : 'off';
  const v = VOICE[state] || VOICE.off;
  $('voiceStatus').dataset.state = v.pill;
  $('voiceText').textContent = v.label;
  $('voiceDetail').dataset.state = v.pill;
  // Speech sits around -30..-10 dBFS: map -60..0 dBFS onto the bar.
  const level = fresh && voice.levelDb !== null ? Math.max(0, Math.min(100, ((voice.levelDb + 60) / 60) * 100)) : 0;
  $('voiceMeter').hidden = state === 'off';
  $('voiceMeter').dataset.state = v.pill;
  $('voiceLevel').style.width = `${level}%`;
  $('voiceDetail').textContent = state === 'sending'
    ? `${v.detail} Level ${voice.levelDb ?? '–'} dBFS, ${voice.packets ?? '–'} packets/s to the caller.`
    : v.detail;
}
setInterval(renderVoice, 1000); // ages a report out when the call is gone

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'session' && changes.stationStatus) {
    stationStatus = changes.stationStatus.newValue || { state: 'off' };
    render();
  }
  if (area === 'session' && changes.voice) {
    voice = changes.voice.newValue || null;
    renderVoice();
  }
});

(async () => {
  $('serverUrl').value = (await chrome.storage.sync.get('serverUrl')).serverUrl || '';
  $('bridgeToken').value = (await chrome.storage.local.get('bridgeToken')).bridgeToken || '';
  stationStatus = (await chrome.storage.session.get('stationStatus')).stationStatus || stationStatus;
  render();
  voice = (await chrome.storage.session.get('voice')).voice || null;
  renderVoice();
})();
