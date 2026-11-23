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
    await loadIssues();
    flushIssues();
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
chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name !== 'station') return;
  await station.ensure();
  await checkTeamsTab();
  await checkTabSound();
  await loadIssues();
  flushIssues();
});

// ---- Issues: problems noticed on this computer, for the server's logs/extension-issues.log -------
// Errors in the extension's own code (here, content.js and page-audio.js, which pass theirs on) and
// problems it can see for itself. Each distinct issue is sent once, then how often it happened again
// at most every ISSUE_REPEAT_MS. Kept in storage.session until sent, so nothing is lost while the
// server is unreachable or this worker is restarted. Before anything leaves, the access token,
// addresses and anything that looks like a secret are taken out (scrub).
const ISSUE_REPEAT_MS = 10 * 60000;
const ISSUE_KEEP = 50; // distinct issues remembered; the oldest is forgotten
const issues = new Map(); // "where message" -> { where, message, stack, count, sent, firstSeen, lastSeen, lastSent }
let issuesLoaded = null;
let issuesSaveTimer = null;

function loadIssues() {
  issuesLoaded ??= chrome.storage.session.get('issues').then(({ issues: saved = {} }) => {
    for (const [key, issue] of Object.entries(saved)) if (!issues.has(key)) issues.set(key, issue);
  });
  return issuesLoaded;
}

function saveIssues() {
  clearTimeout(issuesSaveTimer);
  issuesSaveTimer = setTimeout(() => chrome.storage.session.set({ issues: Object.fromEntries(issues) }), 1000);
}

function scrub(text, token) {
  if (token) text = text.split(token).join('[token]');
  return text
    .replace(/chrome-extension:\/\/[a-p]{32}\//g, '')                      // the extension's own files: their name
    .replace(/https?:\/\/[^\s()'"]*\/([^/\s()'"?#]+)(?:[?#][^\s()'":]*)?/g, '$1') // other addresses: the file name only (and line)
    .replace(/[A-Za-z0-9+/_=-]{32,}/g, '[removed]');                        // anything that could be a secret
}

/** Records one problem, or `count` more of one already known, and sends it if it's due. */
async function reportIssue({ where, message, stack, count = 1 }) {
  await loadIssues();
  const { token } = await getConfig();
  const clean = (text, max) => scrub(String(text ?? ''), token).slice(0, max);
  const issue = { where: clean(where, 80) || 'extension', message: clean(message, 500) || 'unknown problem', stack: clean(stack, 1500) };
  const key = `${issue.where} ${issue.message}`;
  const now = Date.now();
  const known = issues.get(key);
  if (known) {
    known.count += Math.max(1, count | 0);
    known.lastSeen = now;
  } else {
    if (issues.size >= ISSUE_KEEP) issues.delete(issues.keys().next().value);
    issues.set(key, { ...issue, count: Math.max(1, count | 0), sent: 0, firstSeen: now, lastSeen: now, lastSent: 0 });
  }
  flushIssues();
}

/** Sends what's new: a first sighting at once, further ones as a count every ISSUE_REPEAT_MS. */
function flushIssues() {
  if (station.connected) {
    const now = Date.now();
    for (const i of issues.values()) {
      if (i.count === i.sent || (i.sent && now - i.lastSent < ISSUE_REPEAT_MS)) continue;
      station.send({
        type: 'issue', where: i.where, message: i.message, stack: i.stack,
        count: i.count - i.sent, total: i.count, firstSeen: i.firstSeen, lastSeen: i.lastSeen,
      });
      i.sent = i.count;
      i.lastSent = now;
    }
  }
  saveIssues();
}

/** Calls can only ring in the app while Teams is open here. */
async function checkTeamsTab() {
  const { serverUrl, token } = await getConfig();
  if (!serverUrl || !token || (await chrome.tabs.query({ url: TEAMS_URLS })).length) return;
  await reportIssue({ where: 'background.js', message: 'No Teams tab is open in this browser, so calls can\'t ring in the app.' });
}

self.addEventListener('error', (e) => {
  reportIssue({ where: 'background.js', message: e.message, stack: e.error?.stack || `${e.filename}:${e.lineno}` });
});
self.addEventListener('unhandledrejection', (e) => {
  reportIssue({ where: 'background.js', message: `Unhandled failure: ${e.reason?.message ?? e.reason}`, stack: e.reason?.stack });
});

// ---- Teams sound: everything the Teams tab plays, sent to the server's /tab-sound all the time ------
// offscreen.js holds the capture and the connection. Chrome only lets a tab's sound be captured after
// the user invoked the extension on that tab: the "Send Teams sound to the server" menu item (right-click
// the Teams page), Alt+Shift+S there, or opening the side panel from the toolbar icon on it. After that
// it keeps running, across Teams reloads, until Chrome or the extension restarts or the tab is closed.
const OFFSCREEN_URL = 'offscreen.html';
const SOUND_MENU = 'send-teams-sound';
const SOUND_HOWTO = 'On the Teams computer, right-click the Teams page and choose "Send Teams sound to the server" (or press Alt+Shift+S there).';

async function getTabSound() {
  const { tabSound = { state: 'stopped', reason: 'Not started yet.' } } = await chrome.storage.session.get('tabSound');
  return tabSound;
}

async function hasOffscreen() {
  return (await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] })).length > 0;
}

/** Starts sending tab `tabId`'s sound. Returns { ok, message } for whoever asked. */
async function startTabSound(tabId) {
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  if (!tab || !/^https:\/\/teams\.(microsoft\.com|cloud\.microsoft|live\.com)\//.test(tab.url || '')) {
    return { ok: false, message: 'Open this on the Teams tab.' };
  }
  let streamId;
  try {
    streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tabId });
  } catch (err) {
    return { ok: false, message: `Chrome didn't allow capturing the Teams tab (${err.message}). ${SOUND_HOWTO}` };
  }
  if (!(await hasOffscreen())) {
    await chrome.offscreen.createDocument({
      url: OFFSCREEN_URL, reasons: ['USER_MEDIA'],
      justification: 'Sends the Teams tab\'s sound to the Call Bridge server all the time.',
    });
  }
  const { serverUrl, token } = await getConfig();
  await chrome.storage.session.set({ tabSound: { state: 'connecting', reason: '', tabId, time: Date.now() } });
  chrome.runtime.sendMessage({ target: 'offscreen', type: 'tab-sound-start', streamId, tabId, serverUrl, token }).catch(() => {});
  return { ok: true, message: 'Sending the Teams tab\'s sound to the server.' };
}

/** Is the sound going out? If not, say so (once, then counted) in the extension's problem reports. */
async function checkTabSound() {
  const { serverUrl, token } = await getConfig();
  if (!serverUrl || !token || !(await chrome.tabs.query({ url: TEAMS_URLS })).length) return;
  const sound = await getTabSound();
  const running = (await hasOffscreen()) && sound.state !== 'stopped';
  if (!running) {
    if (sound.state !== 'stopped') await chrome.storage.session.set({ tabSound: { state: 'stopped', reason: 'Chrome or the extension restarted.' } });
    await reportIssue({ where: 'background.js', message: `The Teams tab's sound isn't being sent to the server. ${SOUND_HOWTO}` });
  }
}

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId === SOUND_MENU && tab?.id !== undefined) startTabSound(tab.id);
});
chrome.commands.onCommand.addListener((command, tab) => {
  if (command === 'send-teams-sound' && tab?.id !== undefined) startTabSound(tab.id);
});

chrome.storage.onChanged.addListener(async (changes, area) => {
  if ((area === 'sync' && changes.serverUrl) || (area === 'local' && changes.bridgeToken)) {
    station.ensure();
    // A new server URL or token (e.g. after the tokens were replaced) reaches the running capture too.
    if (await hasOffscreen()) chrome.runtime.sendMessage({ target: 'offscreen', type: 'tab-sound-config', ...(await getConfig()) }).catch(() => {});
  }
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
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
      case 'issue': // from content.js: its own, or page-audio.js's
        await reportIssue(msg);
        break;
      case 'tab-sound-status': // from offscreen.js
        await chrome.storage.session.set({ tabSound: { state: msg.state, reason: msg.reason || '', tabId: msg.tabId, time: Date.now() } });
        if (msg.state === 'stopped' && msg.reason) await reportIssue({ where: 'offscreen.js', message: `Teams sound stopped: ${msg.reason}` });
        break;
      case 'tab-sound-start': // from the side panel, opened on the Teams tab
        sendResponse(await startTabSound(msg.tabId));
        break;
      case 'bridge-arm':
        // Every frame gets it; the one holding the call's audio connection starts the bridge.
        if (sender.tab) {
          chrome.tabs.sendMessage(sender.tab.id, { type: 'bridge-arm', callId: crypto.randomUUID(), caller: msg.caller, ringId: msg.ringId }).catch(() => {});
        }
        break;
    }
  })();
  return msg?.type === 'tab-sound-start'; // its answer comes later (sendResponse above)
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
/**
 * After an install, update or reload, every Teams tab is reloaded, including one in a call: Chrome
 * leaves the old content scripts running in open tabs, cut off from this new worker, so in such a
 * tab nothing from the app would arrive any more (mute, audio, camera) and Teams would stay as it
 * joined, e.g. muted. Reloading means rejoining the call there, which is the only way to get it
 * relayed again anyway.
 */
async function reloadTeamsTabs() {
  for (const tab of await chrome.tabs.query({ url: TEAMS_URLS })) {
    chrome.tabs.reload(tab.id).catch(() => {});
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
  chrome.contextMenus.create({
    id: SOUND_MENU, title: 'Send Teams sound to the server', contexts: ['all'], documentUrlPatterns: TEAMS_URLS,
  }, () => void chrome.runtime.lastError); // already there after an update
  await chrome.storage.session.remove('tabSound'); // a reload ended any capture
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
