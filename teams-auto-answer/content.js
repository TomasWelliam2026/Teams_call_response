// Runs inside Teams web. Watches for incoming-call UI, applies auto-answer rules and
// performs actions requested by the background worker (shortcuts / side panel buttons / the local
// app answering through the server). Also arms the audio/camera bridge for a meeting once joined
// (see checkMeetingJoin below) - a meeting has no ring to answer, so it needs its own detection.
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
    syncMute();
    checkMeetingJoin();
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
  let armRequestedAt = 0; // last time *this* frame asked the background worker to arm, any reason
  const callers = new Map(); // callId -> { caller, ringId }, from the arm message

  // The caller's audio of the current call, numbered, with the last minute of it kept: whatever didn't
  // reach the server (connection dropped, background worker restarted) is sent again from here.
  const KEEP_FRAMES = 3000;   // 60 s of 20 ms frames
  const REOPEN_FOR_MS = 60000;
  let kept = [];              // [{ seq, data: base64 }]
  let produced = 0;           // frames the page has handed us in this call
  let posted = 0;             // the last frame posted to the background worker
  let received = 0;           // the app's frames delivered to the page in this call
  let reopenSince = 0;        // set while the link to the background worker is being reopened

  function pushPageConfig() {
    pagePort.postMessage({ type: 'config', options: { keepMic: !!settings.bridgeKeepMic } });
  }

  function closeBridgePort() {
    try { bridgePort?.disconnect(); } catch { /* already gone */ }
    bridgePort = null;
    bridgeCallId = null;
  }

  function keepFrame(pcm) {
    kept.push({ seq: ++produced, data: B.toBase64(pcm) });
    if (kept.length > KEEP_FRAMES) kept.shift();
    postFrames();
  }

  /** Posts every kept frame after `posted`, in order. */
  function postFrames() {
    if (!bridgePort || !kept.length) return;
    if (posted + 1 < kept[0].seq) {
      const gone = kept[0].seq - 1 - posted;
      bridgePort.postMessage({ type: 'note', message: `${(gone / 50).toFixed(1)} s of the caller's audio was too old to send again` });
      posted = kept[0].seq - 1;
    }
    for (let i = posted + 1 - kept[0].seq; i < kept.length; i++) {
      bridgePort.postMessage({ type: 'audio', seq: kept[i].seq, data: kept[i].data });
      posted = kept[i].seq;
    }
  }

  // ---- Mute, shared between the local app and Teams ----------------------------------------
  // While bridged, the caller hears the app user, so Teams' own Mute button must silence the bridge,
  // and the app's Mute presses Teams' button so Teams (and the caller) show the call as muted.
  // Teams' in-call button: data-tid="microphone-button", label "Mute mic" / "Unmute mic".
  let appMuted = false;     // last request from the app
  let appChangedAt = 0;
  let seenTeams = null;     // Teams' button state as last seen, and when it last changed
  let teamsChangedAt = 0;
  let reportedMute = null;  // last state sent to the page and the server

  function micButton() {
    return document.querySelector('[data-tid="microphone-button"]')
      || [...document.querySelectorAll('button, [role="button"]')]
        .find(b => /^\s*(un)?mute\b.*\b(mic|microphone)\b/i.test(b.getAttribute('aria-label') || b.title || ''));
  }

  /** Teams' mute state, or null when its button is missing or disabled (e.g. no microphone on this computer). */
  function teamsMuted() {
    const btn = micButton();
    if (!btn || btn.disabled || btn.getAttribute('aria-disabled') === 'true') return null;
    const label = btn.getAttribute('aria-label') || btn.title || '';
    if (/^\s*unmute\b/i.test(label)) return true;
    if (/^\s*mute\b/i.test(label)) return false;
    return null;
  }

  function syncMute() {
    if (!bridgeCallId) return;
    const teams = teamsMuted();
    if (teams !== seenTeams) { seenTeams = teams; teamsChangedAt = Date.now(); }
    // The most recent action wins. Normally the app's request flips Teams' button and both agree;
    // if Teams refuses to change (e.g. "Teams couldn't unmute"), the app's newer request still counts.
    const muted = teams === null || appChangedAt > teamsChangedAt ? appMuted : teams;
    if (muted === reportedMute) return;
    reportedMute = muted;
    pagePort.postMessage({ type: 'mute', callId: bridgeCallId, muted });
    bridgePort?.postMessage({ type: 'mute-state', muted });
  }

  function appSetMute(muted) {
    appMuted = muted;
    appChangedAt = Date.now();
    const current = teamsMuted();
    if (current !== null && current !== muted) micButton().click();
    syncMute();
    setTimeout(syncMute, 300); // Teams relabels its button shortly after the click
  }

  // ---- Camera control, shared with Teams the same way mute is ------------------------------
  // The app's "Take full control (camera)" turns Teams' own Camera button on, so Teams (and the
  // caller) show the call as having video; stopping it turns Teams' button back off, but only if
  // we were the one who turned it on, so we never touch a camera the person enabled themselves.
  let weEnabledCamera = false;

  function cameraButton() {
    return document.querySelector('[data-tid="camera-button"]')
      || [...document.querySelectorAll('button, [role="button"]')]
        .find(b => /^\s*turn camera (on|off)\b/i.test(b.getAttribute('aria-label') || b.title || ''));
  }

  /** Teams' camera state, or null when its button is missing or disabled. */
  function teamsCameraOn() {
    const btn = cameraButton();
    if (!btn || btn.disabled || btn.getAttribute('aria-disabled') === 'true') return null;
    const label = btn.getAttribute('aria-label') || btn.title || '';
    if (/^\s*turn camera off\b/i.test(label)) return true; // offers to turn it off -> it's on
    if (/^\s*turn camera on\b/i.test(label)) return false;
    return null;
  }

  function syncCameraState(active) {
    const current = teamsCameraOn();
    if (active) {
      if (current === false) { cameraButton().click(); weEnabledCamera = true; }
    } else if (weEnabledCamera) {
      weEnabledCamera = false;
      if (current === true) cameraButton()?.click();
    }
  }

  // ---- Ending the call for real, not just handing the bridge back --------------------------
  // A 1:1 call's Leave button is data-tid="hangup-button"; a meeting's is "hangup-main-btn" -
  // same control, different surface, confirmed against live Teams for each (meetings also drop the
  // data-tid from the mic/camera buttons entirely, down to aria-label only - see callUiActive()).
  function hangupButton() {
    return document.querySelector('[data-tid="hangup-button"], [data-tid="hangup-main-btn"]')
      || [...document.querySelectorAll('button, [role="button"]')]
        .find(b => /^\s*(leave|hang up|end call)\b/i.test(b.getAttribute('aria-label') || b.title || ''));
  }

  // ---- Meetings: joined, not answered --------------------------------------------------------
  // A call rings and gets answered (a toast with an Accept button we can watch for); a meeting has
  // none of that - you join it yourself, from a calendar invite, a chat link, "Meet now", anywhere.
  // There's no single action to hook, so instead this watches for the thing every live call or
  // meeting shows once its media is up: Teams' own Leave control. A third surface, confirmed live -
  // a meeting joined as a participant rather than its organizer - drops even the Leave button's
  // data-tid to "" (empty), label only, so hangupButton()'s label fallback is needed here too; this
  // still pairs it with a second, tid-based signal that it's really a call/meeting toolbar and not
  // some other "Leave"-labelled control elsewhere on the page, to keep a safety margin.
  function callUiActive() {
    if (!hangupButton()) return false;
    return !!document.querySelector('[data-tid="microphone-button"], [data-tid="camera-button"], [data-tid="myself-video-more-menu"]');
  }

  /** Best effort; unlike a ring toast, there's no caller name to read off a meeting someone joined.
   * Teams' title is "<unread prefix><view name> | <content name> | Microsoft Teams" (e.g.
   * "(1) Chat | Meeting with Jason ChanMing | Microsoft Teams"); the content name - what we want -
   * is the segment right before the trailing "Microsoft Teams", not the first one (confirmed
   * against a live meeting: the first segment is just the current view, e.g. "Chat" or "People"). */
  function meetingLabel() {
    const parts = document.title.split('|').map(s => s.trim()).filter(Boolean);
    while (parts.length > 1 && /^Microsoft Teams$/i.test(parts[parts.length - 1])) parts.pop();
    const name = (parts[parts.length - 1] || '').replace(/^\(\d+\)\s*/, '').trim();
    return name || 'Teams meeting';
  }

  /** Arms the bridge for a meeting (or a call Teams connected without our own answer detection
   * catching it) as soon as its toolbar appears, re-trying every scan until the bridge is actually up. */
  function checkMeetingJoin() {
    if (!settings.bridgeEnabled || bridgeCallId || !callUiActive()) return;
    if (Date.now() - armRequestedAt < 5000) return; // already asked; give it time to land
    armRequestedAt = Date.now();
    send({ type: 'bridge-arm', caller: meetingLabel() });
  }

  function openBridge(callId) {
    closeBridgePort();
    bridgeCallId = callId;
    appMuted = false;
    appChangedAt = 0;
    seenTeams = null;
    teamsChangedAt = 0;
    reportedMute = null;
    weEnabledCamera = false;
    kept = [];
    produced = posted = received = 0;
    reopenSince = 0;
    connectBridge(callId);
  }

  /** (Re)opens the link to the background worker, which holds the connection to the server. */
  function connectBridge(callId) {
    try {
      bridgePort = chrome.runtime.connect({ name: 'bridge' });
    } catch { // the extension was reloaded: this copy of the script can't reach it any more
      pagePort.postMessage({ type: 'stop', callId, reason: 'The extension was reloaded.' });
      bridgePort = null;
      bridgeCallId = null;
      return;
    }
    bridgePort.onMessage.addListener((msg) => {
      if (msg.type === 'audio') {
        received++;
        const pcm = B.fromBase64(msg.data);
        pagePort.postMessage({ type: 'audio', callId, pcm }, [pcm]);
      } else if (msg.type === 'resend') {
        posted = Math.min(msg.from, produced); // the server has frames up to here: send the rest again
        postFrames();
      } else if (msg.type === 'connected') {
        reopenSince = 0;
      } else if (msg.type === 'mute') {
        appSetMute(!!msg.muted);
      } else if (msg.type === 'stop') {
        pagePort.postMessage({ type: 'stop', callId, reason: msg.reason });
      } else if (msg.type === 'ice-servers') {
        pagePort.postMessage({ type: 'config', options: { iceServers: msg.iceServers } });
      } else if (msg.type === 'video-offer' || msg.type === 'video-ice' || msg.type === 'video-stop') {
        // Camera control (see page-audio.js): just relay the signaling, opaque here.
        pagePort.postMessage({ ...msg, callId });
      } else if (msg.type === 'end-call') {
        // The app pressed "End call": actually hang up here, not just hand the bridge back.
        hangupButton()?.click();
      }
    });
    // A deliberate end arrives as 'stop' first (bridgeCallId is cleared then). Without one, the
    // background worker went away (Chrome restarts it now and then): reopen and carry on with the
    // same call, keeping the bridge in the page running meanwhile. Give up after a minute.
    bridgePort.onDisconnect.addListener(() => {
      if (bridgeCallId !== callId) return;
      bridgePort = null;
      reopenSince ||= Date.now();
      if (Date.now() - reopenSince > REOPEN_FOR_MS) {
        pagePort.postMessage({ type: 'stop', callId, reason: 'Bridge closed.' });
        bridgeCallId = null;
        return;
      }
      setTimeout(() => { if (bridgeCallId === callId && !bridgePort) connectBridge(callId); }, 500);
    });
    bridgePort.postMessage({ type: 'start', callId, ...callers.get(callId), have: received, sent: posted });
    reportedMute = null;
    syncMute(); // tell the app whether Teams is muted right now
  }

  pagePort.onmessage = ({ data }) => {
    switch (data.type) {
      case 'started':
        openBridge(data.callId);
        send({ type: 'bridge-event', event: 'started', callId: data.callId, detail: data.info });
        break;
      case 'audio':
        if (bridgeCallId) keepFrame(data.pcm);
        break;
      case 'note':
        // Worth seeing after the call (e.g. Teams switched media connections): the side panel and the server log.
        send({ type: 'bridge-event', event: 'log', detail: data.message });
        bridgePort?.postMessage({ type: 'note', message: data.message });
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
      case 'video-answer':
      case 'video-ice':
        // The page answered (or trickled ICE for) the operator's camera offer; send it on.
        if (bridgePort) bridgePort.postMessage(data);
        break;
      case 'video-state':
        syncCameraState(data.active);
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
    armRequestedAt = Date.now();
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
      if (msg.action !== 'decline') { armRequestedAt = Date.now(); send({ type: 'bridge-arm', caller: call.caller, ringId: msg.ringId }); } // arm before Teams connects
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
