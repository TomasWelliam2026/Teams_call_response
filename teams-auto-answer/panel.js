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
  $('voiceDetail').textContent = state === 'sending' ? `${v.detail} ${voice.packets ?? '–'} packets/s to the caller.` : v.detail;
}
setInterval(renderVoice, 1000); // ages a report out when the call is gone

// ---- Live bar: the app's audio as the extension receives it (content.js, every 50 ms) -------------
const NO_SIGNAL_MS = 500;   // no level for this long: "No signal"
const SHOW_FOR_MS = 5000;   // the bar stays this long after the last level (then the call is over)
const FLOOR_DB = -60;       // the bar's empty end; speech sits around -30..-10 dBFS
const FALL_DB_PER_S = 30;   // how fast the bar falls after a loud moment
const HOLD_MS = 150;        // a level is held this long before the bar falls
const PEAK_HOLD_MS = 1500;
const live = { level: FLOOR_DB, raisedAt: 0, peak: FLOOR_DB, peakAt: 0, at: 0, lastDraw: 0 };
const share = (db) => Math.max(0, Math.min(100, ((db - FLOOR_DB) / -FLOOR_DB) * 100));
const pct = (db) => `${share(db)}%`;

chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.type !== 'app-level') return;
  const now = performance.now();
  live.at = now;
  if (msg.db >= live.level) { live.level = msg.db; live.raisedAt = now; }
  if (msg.db >= live.peak) { live.peak = msg.db; live.peakAt = now; }
});

function drawLive(now) {
  requestAnimationFrame(drawLive);
  const dt = live.lastDraw ? (now - live.lastDraw) / 1000 : 0;
  live.lastDraw = now;
  const since = now - live.at;
  const inCall = (voice && Date.now() - voice.time < VOICE_STALE_MS) || (live.at && since < SHOW_FOR_MS);
  $('liveMeter').hidden = !inCall;
  if ($('liveMeter').hidden) return;
  const receiving = since < NO_SIGNAL_MS;
  if (!receiving) live.level = live.peak = FLOOR_DB;
  else if (now - live.raisedAt > HOLD_MS) live.level = Math.max(FLOOR_DB, live.level - FALL_DB_PER_S * dt);
  if (now - live.peakAt > PEAK_HOLD_MS) live.peak = Math.max(live.level, live.peak - FALL_DB_PER_S * dt);
  $('liveFill').style.clipPath = `inset(0 ${100 - share(live.level)}% 0 0)`;
  $('livePeak').style.left = pct(live.peak);
  $('liveState').textContent = receiving ? 'Receiving' : 'No signal';
  $('liveState').dataset.state = receiving ? 'on' : 'off';
  $('liveDb').textContent = receiving ? `${Math.round(live.level)} dBFS` : 'Nothing is arriving from the app.';
}
requestAnimationFrame(drawLive);

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
