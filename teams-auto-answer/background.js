importScripts('detector.js', 'bridge.js');

const { DEFAULT_SETTINGS } = globalThis.TeamsCallDetector;
const Bridge = globalThis.TeamsCallBridge;
const TEAMS_URLS = [
  'https://teams.microsoft.com/*',
  'https://teams.cloud.microsoft/*',
  'https://teams.live.com/*',
];
const LOG_LIMIT = 30;
const ACTION_LABELS = { audio: 'Answered (audio)', video: 'Answered (video)', decline: 'Declined' };
const bridges = new Map(); // callId -> { handle, tabId, state }
const startedCalls = new Set(); // callIds that reached the server, so a late arm timeout from another frame is ignored

async function getSettings() {
  return { ...DEFAULT_SETTINGS, ...(await chrome.storage.sync.get(null)) };
}

async function addLog(entry) {
  const { log = [] } = await chrome.storage.local.get('log');
  log.unshift({ time: Date.now(), ...entry });
  await chrome.storage.local.set({ log: log.slice(0, LOG_LIMIT) });
}

function notify(title, message) {
  chrome.notifications.create({ type: 'basic', iconUrl: 'icons/icon128.png', title, message, priority: 1 });
}

async function refreshBadge(ringing = false) {
  const { enabled } = await getSettings();
  if (ringing) {
    await chrome.action.setBadgeBackgroundColor({ color: '#d93025' });
    await chrome.action.setBadgeText({ text: 'RING' });
  } else if ([...bridges.values()].some(b => b.state === 'live')) {
    await chrome.action.setBadgeBackgroundColor({ color: '#1a73e8' });
    await chrome.action.setBadgeText({ text: 'LIVE' });
  } else {
    await chrome.action.setBadgeBackgroundColor({ color: '#188038' });
    await chrome.action.setBadgeText({ text: enabled ? 'AUTO' : '' });
  }
}

async function keepTeamsTabsAlive() {
  const { keepAlive } = await getSettings();
  for (const tab of await chrome.tabs.query({ url: TEAMS_URLS })) {
    chrome.tabs.update(tab.id, { autoDiscardable: !keepAlive }).catch(() => {});
  }
}

/** Ask every Teams tab to perform an action; the first tab with a ringing call handles it. */
async function dispatchAction(action, source) {
  const tabs = await chrome.tabs.query({ url: TEAMS_URLS });
  for (const tab of tabs) {
    const res = await chrome.tabs.sendMessage(tab.id, { type: 'action', action }).catch(() => null);
    if (res?.ok) {
      await addLog({ event: ACTION_LABELS[action], caller: res.caller, source });
      await refreshBadge(false);
      return res;
    }
  }
  const message = tabs.length ? 'No incoming Teams call found.' : 'No Teams web tab is open.';
  notify('Teams Call Answerer', message);
  return { ok: false, message };
}

// Clicking the toolbar icon opens the controls in the browser's right-hand side panel.
chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});

// ---- Audio bridge ----------------------------------------------------------------------------
// content.js opens a "bridge" port once an answered call's audio is flowing; bridge.js connects
// that port to the server. The access token is kept in storage.local so it never syncs to other devices.

async function getBridgeConfig() {
  const { serverUrl } = await getSettings();
  const { bridgeToken = '' } = await chrome.storage.local.get('bridgeToken');
  return { serverUrl, token: bridgeToken };
}

function setBridgeStatus(status) {
  return chrome.storage.session.set({ bridgeStatus: { ...status, time: Date.now() } });
}

async function onBridgeStatus(tabId, handle, s) {
  if (s.state === 'connecting') {
    startedCalls.add(s.callId);
    setTimeout(() => startedCalls.delete(s.callId), 120000);
    for (const [id, b] of bridges) if (b.tabId === tabId && id !== s.callId) b.handle.stop('A new call was answered.');
    bridges.set(s.callId, { handle, tabId, state: s.state });
  } else if (bridges.has(s.callId)) {
    bridges.get(s.callId).state = s.state;
  }
  if (s.state === 'ended' || s.state === 'error') bridges.delete(s.callId);
  await setBridgeStatus(s);
  if (s.state === 'live') {
    if (!s.resumed) await addLog({ event: 'Bridge live', caller: s.caller, detail: s.server });
  } else if (s.state === 'ended') {
    await addLog({ event: 'Bridge ended', caller: s.caller, detail: s.reason });
  } else if (s.state === 'error') {
    await addLog({ event: 'Bridge error', caller: s.caller, detail: s.reason });
    notify('Audio bridge failed', s.reason);
  }
  await refreshBadge(false);
}

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'bridge' || !port.sender?.tab) return;
  const tabId = port.sender.tab.id;
  const handle = Bridge.serveBridgePort(port, {
    getConfig: getBridgeConfig,
    onStatus: (s) => onBridgeStatus(tabId, handle, s),
  });
});

async function handleBridgeMessage(msg, sender) {
  switch (msg.type) {
    case 'bridge-arm': {
      if (!sender.tab || !(await getSettings()).bridgeEnabled) return;
      const callId = crypto.randomUUID();
      await setBridgeStatus({ state: 'waiting', callId, caller: msg.caller });
      // Every frame gets it; the one holding the call's audio connection starts the bridge.
      chrome.tabs.sendMessage(sender.tab.id, { type: 'bridge-arm', callId, caller: msg.caller }).catch(() => {});
      return;
    }
    case 'bridge-event':
      if (msg.event === 'failed' && !startedCalls.has(msg.callId)) {
        await setBridgeStatus({ state: 'error', callId: msg.callId, reason: msg.detail });
        await addLog({ event: 'Bridge not started', detail: msg.detail });
      } else if (msg.event === 'log') {
        await addLog({ event: 'Bridge note', detail: msg.detail });
      }
      return;
    case 'bridge-stop':
      for (const b of bridges.values()) b.handle.stop('Stopped from the side panel.');
      for (const tab of await chrome.tabs.query({ url: TEAMS_URLS })) {
        chrome.tabs.sendMessage(tab.id, { type: 'bridge-stop', reason: 'Stopped from the side panel.' }).catch(() => {});
      }
      return { ok: true };
    case 'bridge-test':
      return Bridge.testServer(await getBridgeConfig());
  }
}

chrome.runtime.onInstalled.addListener(async () => {
  const stored = await chrome.storage.sync.get(null);
  await chrome.storage.sync.set({ ...DEFAULT_SETTINGS, ...stored });
  await refreshBadge();
  await keepTeamsTabsAlive();
});

chrome.runtime.onStartup.addListener(() => { refreshBadge(); keepTeamsTabsAlive(); });

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'sync') return;
  if (changes.enabled) refreshBadge();
  if (changes.keepAlive) keepTeamsTabsAlive();
});

chrome.tabs.onUpdated.addListener(async (tabId, info, tab) => {
  if (info.status !== 'complete' || !tab.url) return;
  if (!/^https:\/\/teams\.(microsoft\.com|cloud\.microsoft|live\.com)\//.test(tab.url)) return;
  const { keepAlive } = await getSettings();
  if (keepAlive) chrome.tabs.update(tabId, { autoDiscardable: false }).catch(() => {});
});

chrome.commands.onCommand.addListener(async (command) => {
  if (command === 'toggle-auto-answer') {
    const { enabled } = await getSettings();
    await chrome.storage.sync.set({ enabled: !enabled });
    notify('Teams Call Answerer', `Auto-answer is now ${enabled ? 'OFF' : 'ON'}.`);
    return;
  }
  const action = { 'accept-audio': 'audio', 'accept-video': 'video', decline: 'decline' }[command];
  if (action) dispatchAction(action, 'shortcut');
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    switch (msg.type) {
      case 'call-detected':
        await refreshBadge(true);
        await addLog({ event: 'Incoming call', caller: msg.caller, detail: msg.decision });
        break;
      case 'call-ended':
        await refreshBadge(false);
        break;
      case 'call-auto-answered': {
        await refreshBadge(false);
        await addLog({ event: ACTION_LABELS[msg.action], caller: msg.caller, source: 'auto' });
        if ((await getSettings()).notify) notify('Call auto-answered', `${msg.caller} (${msg.action})`);
        break;
      }
      case 'bridge-arm':
      case 'bridge-event':
      case 'bridge-stop':
      case 'bridge-test':
        sendResponse(await handleBridgeMessage(msg, sender));
        return;
      case 'panel-action':
        sendResponse(await dispatchAction(msg.action, 'panel'));
        return;
    }
    sendResponse({ ok: true });
  })();
  return true; // async response
});
