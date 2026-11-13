importScripts('bridge.js');

const Bridge = globalThis.TeamsCallBridge;
const TEAMS_URLS = [
  'https://teams.microsoft.com/*',
  'https://teams.cloud.microsoft/*',
  'https://teams.live.com/*',
];
const bridges = new Map(); // callId -> { handle, tabId }

// Clicking the toolbar icon opens the connection settings in the browser's right-hand side panel.
chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});

// The server URL is in storage.sync; the access token in storage.local, so it never syncs to other devices.
async function getConfig() {
  const { serverUrl = '' } = await chrome.storage.sync.get('serverUrl');
  const { bridgeToken = '' } = await chrome.storage.local.get('bridgeToken');
  return { serverUrl, token: bridgeToken };
}

// ---- Audio bridge ----------------------------------------------------------------------------
// content.js opens a "bridge" port once an answered call's audio is flowing; bridge.js connects
// that port to the server.

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'bridge' || !port.sender?.tab) return;
  const tabId = port.sender.tab.id;
  const handle = Bridge.serveBridgePort(port, {
    getConfig,
    onStatus: (s) => {
      if (s.state === 'connecting') {
        // One bridged call per Teams tab: a newly answered call replaces the previous one.
        for (const [id, b] of bridges) if (b.tabId === tabId && id !== s.callId) b.handle.stop('A new call was answered.');
        bridges.set(s.callId, { handle, tabId });
      } else if (s.state === 'ended' || s.state === 'error') {
        bridges.delete(s.callId);
      }
    },
  });
});

// ---- Station: the always-on link that lets the local app see rings and answer them ----------
// Rings live in storage.session so they survive the service worker being restarted.
const RING_TTL_MS = 120000; // forget a ring the content script never reported as ended

async function getRings() {
  const { rings = {} } = await chrome.storage.session.get('rings');
  for (const [id, r] of Object.entries(rings)) if (Date.now() - r.since > RING_TTL_MS) delete rings[id];
  return rings;
}

async function updateRings(fn) {
  const rings = await getRings();
  fn(rings);
  await chrome.storage.session.set({ rings });
}

const station = Bridge.createStation({
  getConfig: async () => ({ ...(await getConfig()), enabled: true }), // connects once URL and token are set
  onStatus: (s) => chrome.storage.session.set({ stationStatus: { ...s, time: Date.now() } }),
  onOpen: async () => {
    for (const r of Object.values(await getRings())) station.send({ type: 'ringing', ringId: r.ringId, caller: r.caller });
  },
  onCommand: async (cmd) => {
    const ring = (await getRings())[cmd.ringId];
    const action = cmd.type === 'decline' ? 'decline' : (cmd.mode || 'audio');
    let res = { ok: false, message: 'That call is no longer ringing on the Teams computer.' };
    if (ring) {
      res = (await chrome.tabs.sendMessage(ring.tabId, { type: 'remote-answer', ringId: cmd.ringId, action }).catch(() => null))
        || { ok: false, message: 'The Teams tab did not respond.' };
    }
    station.send({ type: 'answer-result', ringId: cmd.ringId, ok: !!res.ok, message: res.message });
  },
});

station.ensure();
// The worker can be stopped while idle; the alarm brings it back and reconnects if needed.
chrome.alarms.create('station', { periodInMinutes: 1 });
chrome.alarms.onAlarm.addListener((alarm) => { if (alarm.name === 'station') station.ensure(); });

chrome.storage.onChanged.addListener((changes, area) => {
  if ((area === 'sync' && changes.serverUrl) || (area === 'local' && changes.bridgeToken)) station.ensure();
});

chrome.runtime.onMessage.addListener((msg, sender) => {
  (async () => {
    switch (msg.type) {
      case 'call-detected':
        if (msg.ringId && sender.tab) {
          await updateRings((rings) => { rings[msg.ringId] = { ringId: msg.ringId, caller: msg.caller, tabId: sender.tab.id, since: Date.now() }; });
          station.send({ type: 'ringing', ringId: msg.ringId, caller: msg.caller });
        }
        break;
      case 'call-ended':
        if (msg.ringId) {
          await updateRings((rings) => { delete rings[msg.ringId]; });
          station.send({ type: 'ring-ended', ringId: msg.ringId });
        }
        break;
      case 'bridge-arm':
        // Every frame gets it; the one holding the call's audio connection starts the bridge.
        if (sender.tab) {
          chrome.tabs.sendMessage(sender.tab.id, { type: 'bridge-arm', callId: crypto.randomUUID(), caller: msg.caller, ringId: msg.ringId }).catch(() => {});
        }
        break;
    }
  })();
});

// ---- Setup -------------------------------------------------------------------------------------

// Optional provisioning: bridge-config.json next to manifest.json (git-ignored) sets the server URL
// and access token on install/reload, so a machine can be set up without typing secrets into the panel.
// Shape: { "serverUrl": "wss://host/call", "token": "…" }
async function applyProvisionedConfig() {
  let cfg;
  try {
    cfg = await (await fetch(chrome.runtime.getURL('bridge-config.json'))).json();
  } catch {
    return; // no file
  }
  if (cfg.serverUrl && !Bridge.checkServerUrl(cfg.serverUrl)) await chrome.storage.sync.set({ serverUrl: cfg.serverUrl });
  if (cfg.token) await chrome.storage.local.set({ bridgeToken: cfg.token });
}

// The browser must not discard a Teams tab to save memory: calls would stop ringing.
async function keepTeamsTabsAlive() {
  for (const tab of await chrome.tabs.query({ url: TEAMS_URLS })) {
    chrome.tabs.update(tab.id, { autoDiscardable: false }).catch(() => {});
  }
}

// After the extension is installed, updated or reloaded, Teams tabs that were already open keep the
// old, disconnected scripts and silently stop detecting calls. Reload them so the new scripts load
// (page-audio.js must run before Teams starts). A tab that is playing sound may be in a call: leave it.
async function reloadTeamsTabs() {
  for (const tab of await chrome.tabs.query({ url: TEAMS_URLS })) {
    if (!tab.audible) chrome.tabs.reload(tab.id).catch(() => {});
  }
}

// Settings from versions before 0.6 (auto-answer, shortcuts, activity log…) that nothing reads any more.
const OBSOLETE_SYNC = ['enabled', 'mode', 'delaySec', 'allowlist', 'blocklist', 'hoursEnabled', 'hoursStart', 'hoursEnd',
  'days', 'notify', 'keepAlive', 'bridgeEnabled', 'bridgeKeepMic', 'customContext', 'customAcceptAudio',
  'customAcceptVideo', 'customAccept', 'customDecline'];

chrome.runtime.onInstalled.addListener(async () => {
  await chrome.storage.sync.remove(OBSOLETE_SYNC);
  await chrome.storage.local.remove('log');
  await chrome.action.setBadgeText({ text: '' });
  await applyProvisionedConfig();
  await keepTeamsTabsAlive();
  await reloadTeamsTabs();
});

chrome.runtime.onStartup.addListener(keepTeamsTabsAlive);

chrome.tabs.onUpdated.addListener((tabId, info, tab) => {
  if (info.status !== 'complete' || !tab.url) return;
  if (/^https:\/\/teams\.(microsoft\.com|cloud\.microsoft|live\.com)\//.test(tab.url)) {
    chrome.tabs.update(tabId, { autoDiscardable: false }).catch(() => {});
  }
});
