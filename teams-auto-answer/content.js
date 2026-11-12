// Runs inside Teams web. Watches for incoming-call UI, applies auto-answer rules and
// performs actions requested by the background worker (shortcuts / side panel buttons / the local
// app answering through the server).
(() => {
  if (globalThis.__teamsCallAnswerer) return;
  globalThis.__teamsCallAnswerer = true;

  const D = globalThis.TeamsCallDetector;
  const SCAN_THROTTLE_MS = 200;
  const POLL_MS = 2000;

  let settings = { ...D.DEFAULT_SETTINGS };
  const tracked = new Map(); // call container element -> { ringId, caller, handled, timer }
  let scanTimer = null;
  let observer = null;
  let poller = null;

  function alive() {
    try { return !!chrome.runtime?.id; } catch { return false; }
  }

  function send(msg) {
    if (!alive()) return shutdown();
    chrome.runtime.sendMessage(msg).catch(() => {});
  }

  function shutdown() {
    observer?.disconnect();
    clearInterval(poller);
    for (const t of tracked.values()) clearTimeout(t.timer);
  }

  function perform(call, action) {
    const btn = D.pickButton(call, action);
    if (!btn) return null;
    const pressed = Object.keys(call.actions).find(k => call.actions[k] === btn);
    btn.click();
    const t = tracked.get(call.container);
    if (t) { t.handled = true; clearTimeout(t.timer); }
    return { ok: true, caller: call.caller, action: pressed === 'accept' ? 'audio' : pressed };
  }

  function autoAnswer(container) {
    const t = tracked.get(container);
    if (!t || t.handled || !settings.enabled) return;
    const call = D.detectCalls(document, settings).find(c => c.container === container);
    if (!call) return; // stopped ringing during the delay
    const res = perform(call, settings.mode);
    if (res) send({ type: 'call-auto-answered', caller: res.caller, action: res.action });
  }

  function scan() {
    scanTimer = null;
    const calls = D.detectCalls(document, settings);
    const live = new Set(calls.map(c => c.container));

    for (const [container, t] of tracked) {
      if (live.has(container)) continue;
      clearTimeout(t.timer);
      tracked.delete(container);
      send({ type: 'call-ended', ringId: t.ringId, handled: t.handled });
    }

    for (const call of calls) {
      if (tracked.has(call.container)) continue;
      const decision = D.evaluateRules(call.caller, call.text, settings);
      const t = { ringId: crypto.randomUUID(), caller: call.caller, handled: false, timer: null };
      tracked.set(call.container, t);
      send({ type: 'call-detected', ringId: t.ringId, caller: call.caller, decision: decision.reason });
      if (decision.answer) {
        t.timer = setTimeout(() => autoAnswer(call.container), Math.max(0, Number(settings.delaySec) || 0) * 1000);
      }
    }
  }

  function scheduleScan() {
    if (!scanTimer) scanTimer = setTimeout(scan, SCAN_THROTTLE_MS);
  }

  // ---- Audio bridge ------------------------------------------------------------------------
  // page-audio.js (page world) taps the call audio; this script relays it to the background
  // worker, which holds the WebSocket to the server. Base64 because extension ports carry JSON.
  const B = globalThis.TeamsCallBridge;
  const pageChannel = new MessageChannel();
  const pagePort = pageChannel.port1;
  let bridgePort = null;
  let bridgeCallId = null;
  const callers = new Map(); // callId -> { caller, ringId }, from the arm message

  function pushPageConfig() {
    pagePort.postMessage({ type: 'config', options: { keepMic: !!settings.bridgeKeepMic, workletUrl: chrome.runtime.getURL('tap-worklet.js') } });
  }

  function closeBridgePort() {
    try { bridgePort?.disconnect(); } catch { /* already gone */ }
    bridgePort = null;
    bridgeCallId = null;
  }

  function openBridge(callId) {
    closeBridgePort();
    bridgeCallId = callId;
    bridgePort = chrome.runtime.connect({ name: 'bridge' });
    bridgePort.onMessage.addListener((msg) => {
      if (msg.type === 'audio') {
        const pcm = B.fromBase64(msg.data);
        pagePort.postMessage({ type: 'audio', callId, pcm }, [pcm]);
      } else if (msg.type === 'stop') {
        pagePort.postMessage({ type: 'stop', callId, reason: msg.reason });
      }
    });
    // Server unreachable or worker gone: hand the microphone back to Teams.
    bridgePort.onDisconnect.addListener(() => {
      if (bridgeCallId !== callId) return;
      pagePort.postMessage({ type: 'stop', callId, reason: 'Bridge closed.' });
      bridgePort = null;
      bridgeCallId = null;
    });
    bridgePort.postMessage({ type: 'start', callId, ...callers.get(callId) });
  }

  pagePort.onmessage = ({ data }) => {
    switch (data.type) {
      case 'started':
        openBridge(data.callId);
        send({ type: 'bridge-event', event: 'started', callId: data.callId, detail: data.info });
        break;
      case 'audio':
        if (bridgePort) bridgePort.postMessage({ type: 'audio', data: B.toBase64(data.pcm) });
        break;
      case 'stopped':
        if (bridgeCallId === data.callId) {
          bridgePort?.postMessage({ type: 'stop', reason: data.reason });
          closeBridgePort();
        }
        break;
      case 'failed':
        send({ type: 'bridge-event', event: 'failed', callId: data.callId, detail: data.reason });
        break;
      case 'log':
        send({ type: 'bridge-event', event: 'log', detail: data.message });
        break;
    }
  };
  window.postMessage({ __tca: 'connect' }, '*', [pageChannel.port2]);

  // The bridge starts when a person answers: by pressing Teams' own accept button here, or by
  // clicking Answer in the local app (see 'remote-answer'). Answers made by the extension on its own
  // (side panel, shortcuts, auto-answer) use btn.click(), whose events are untrusted, so they don't.
  // Capture phase, because Teams removes the toast as soon as it handles the press. If Teams reacts
  // on pointerdown/pointerup and removes the button first, Chrome sends no click at all, so a press
  // on an accept button whose button is gone shortly after the release also counts as answering.
  const PRESS_GONE_MS = 300;
  let pressed = null; // { btn, caller } from the last trusted pointerdown on an accept button

  function acceptButtonCall(target) {
    const btn = target?.closest?.('button, [role="button"]');
    if (!btn) return null;
    const call = D.detectCalls(document, settings)
      .find(c => [c.actions.audio, c.actions.video, c.actions.accept].includes(btn));
    return call ? { btn, caller: call.caller, ringId: tracked.get(call.container)?.ringId } : null;
  }

  function personAnswered({ caller, ringId }) {
    pressed = null;
    send({ type: 'bridge-arm', caller, ringId });
  }

  document.addEventListener('pointerdown', (e) => {
    if (!e.isTrusted || !settings.bridgeEnabled) return;
    pressed = acceptButtonCall(e.target);
  }, true);

  document.addEventListener('pointerup', (e) => {
    if (!e.isTrusted || !pressed) return;
    const press = pressed;
    setTimeout(() => { if (pressed === press && !press.btn.isConnected) personAnswered(press); }, PRESS_GONE_MS);
  }, true);

  document.addEventListener('click', (e) => {
    if (!e.isTrusted || !settings.bridgeEnabled) return;
    const hit = acceptButtonCall(e.target);
    if (hit) personAnswered(hit);
    else pressed = null;
  }, true);

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg.type === 'bridge-arm') {
      // Sent to every frame: whichever frame holds the call's audio connection starts the bridge.
      callers.clear(); // only the latest answered call matters
      callers.set(msg.callId, { caller: msg.caller, ringId: msg.ringId });
      pagePort.postMessage({ type: 'arm', callId: msg.callId });
      return;
    }
    if (msg.type === 'bridge-stop') {
      pagePort.postMessage({ type: 'stop', reason: msg.reason });
      return;
    }
    if (msg.type === 'remote-answer') {
      // The person at the local app pressed Answer/Decline for this ring. Only the frame showing it replies.
      const entry = [...tracked].find(([, t]) => t.ringId === msg.ringId);
      const call = entry && D.detectCalls(document, settings).find(c => c.container === entry[0]);
      if (!call) return;
      if (msg.action !== 'decline') send({ type: 'bridge-arm', caller: call.caller, ringId: msg.ringId }); // arm before Teams connects
      sendResponse(perform(call, msg.action === 'decline' ? 'decline' : (msg.action || 'audio')) || { ok: false, message: 'Teams has no button for that.' });
      return;
    }
    if (msg.type === 'action') {
      const calls = D.detectCalls(document, settings);
      const res = calls.length ? perform(calls[calls.length - 1], msg.action) : null;
      // Frames without a ringing call stay silent so a frame that has one can answer.
      if (res) sendResponse(res);
      return;
    }
    if (msg.type === 'diagnose' && window === window.top) {
      sendResponse({ url: location.host, ...D.diagnose(document, settings) });
    }
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'sync') return;
    for (const [key, { newValue }] of Object.entries(changes)) settings[key] = newValue;
    if (changes.bridgeKeepMic) pushPageConfig();
    scheduleScan();
  });

  chrome.storage.sync.get(null).then((stored) => {
    settings = { ...D.DEFAULT_SETTINGS, ...stored };
    pushPageConfig();
    observer = new MutationObserver(scheduleScan);
    observer.observe(document.documentElement, {
      childList: true, subtree: true, attributes: true, attributeFilter: ['aria-label', 'hidden', 'style', 'class'],
    });
    poller = setInterval(scan, POLL_MS); // fallback if a change slips past the observer
    scan();
  });
})();
