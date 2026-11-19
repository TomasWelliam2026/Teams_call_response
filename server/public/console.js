// Call Bridge local app. Installable from Chrome as its own window. It shows Teams calls ringing
// on the linked Teams computer; Answer makes the extension answer there and routes the call here:
// the caller's audio plays on this computer and this computer's microphone goes to the caller
// (PCM s16le, mono, 16 kHz, 20 ms frames).
const RATE = 16000;
const FRAME = 320;
const START_BUFFER_S = 0.25; // over two WAN hops (Teams computer -> server -> here), 80 ms was too thin and caused cutouts
const CATCHUP_S = 0.6;       // more of the caller waiting than this (after a hiccup or reconnect): leave out pauses to catch up
const MAX_BACKLOG_S = 20;    // only beyond this much waiting is audio with speech in it dropped
const QUIET_RMS = 0.004;     // a 20 ms frame quieter than this is a pause
const KEEP_FRAMES = 3000;    // the last 60 s of this microphone, to send again whatever didn't reach the server
const RESUME_FOR_MS = 60000; // a call survives the connection being down this long (the server holds it as long)
const TOKEN_KEY = 'callBridge.operatorToken';

const $ = (id) => document.getElementById(id);
let ws = null;
let token = '';
let wantConnected = false; // false after Sign out or a rejected token: don't reconnect
let retry = 0;
let retryTimer = null;
let audio = null;   // { ctx, stream, src, input, nextTime, tap } while on a call
let active = null;  // { callId, caller, since }
// The call's audio is numbered both ways, so a reconnect picks up exactly where it left off:
let linked = false; // the server has (again) confirmed this app has the active call
let lostAt = 0;     // when the connection dropped during a call
let have = 0;       // caller frames received in this call
let produced = 0;   // microphone frames made in this call
let sentUpTo = 0;   // the last microphone frame sent
let kept = [];      // [{ seq, pcm }], the last KEEP_FRAMES microphone frames
let answering = null; // ringId we pressed Answer on, until the call arrives
let muted = false;
let clock = null;
let rings = [];
const notes = new Map(); // ringId -> Notification
let iceServers = [];
let camera = null; // { pc, stream } while this computer's camera is in the call

function setStatus(text) { $('status').textContent = text; }

// Visible however this page is opened (an installed app window has no address bar to show it).
$('serverAddress').textContent = `Server: ${location.host}`;

// ---- Always-on status --------------------------------------------------------------------------

// /healthz needs no operator token, so this works even before signing in, unlike the WebSocket
// status above and the per-station detail in #stations (which needs a live /operator connection).
const HEALTH_POLL_MS = 5000;

async function pollHealth() {
  try {
    const res = await fetch('/healthz');
    if (!res.ok) throw new Error(String(res.status));
    const health = await res.json();
    $('serverHealth').textContent = 'Server: reachable.';
    $('serverHealth').dataset.ok = 'true';
    $('extensionHealth').textContent = health.teamsComputers
      ? `Teams extension: connected${health.teamsComputers > 1 ? ` (${health.teamsComputers})` : ''}.`
      : 'Teams extension: not connected.';
    $('extensionHealth').dataset.ok = health.teamsComputers ? 'true' : 'false';
  } catch {
    $('serverHealth').textContent = 'Server: unreachable.';
    $('serverHealth').dataset.ok = 'false';
    $('extensionHealth').textContent = 'Teams extension: unknown (server unreachable).';
    $('extensionHealth').dataset.ok = 'false';
  }
}

pollHealth();
setInterval(pollHealth, HEALTH_POLL_MS);

/** While muted nothing from this microphone is sent (see startCall). */
function setMuted(value) {
  muted = !!value;
  $('mute').setAttribute('aria-pressed', muted);
  $('mute').textContent = muted ? 'Unmute' : 'Mute';
  if (active) setStatus(muted ? `Muted — ${active.caller} can't hear you.` : `Talking to ${active.caller}.`);
}

const storage = {
  get(key = TOKEN_KEY) { try { return localStorage.getItem(key) || ''; } catch { return ''; } },
  set(v, key = TOKEN_KEY) { try { v ? localStorage.setItem(key, v) : localStorage.removeItem(key); } catch { /* private mode */ } },
};

// ---- Microphone -------------------------------------------------------------------------------

// The caller hears your voice without background noise: Chrome's own noise suppression, echo
// cancellation and automatic gain are on, plus a high-pass filter for hum (below).
const RAW_AUDIO = { echoCancellation: true, noiseSuppression: true, autoGainControl: true };
const MIC_CONSTRAINTS = { audio: RAW_AUDIO };

// Chrome's own microphone access, never another extension's. Extensions such as "Background Noise
// Remover" replace navigator.mediaDevices.getUserMedia/enumerateDevices in every page and hand back
// their own processed audio; this app does its own noise removal and must get the real microphone.
// A blank same-origin frame still has Chrome's untouched functions, which are used on this page's
// mediaDevices. Falls back to the page's own if the frame can't be made.
const media = (() => {
  const md = navigator.mediaDevices;
  try {
    const frame = document.createElement('iframe');
    frame.hidden = true;
    frame.setAttribute('aria-hidden', 'true');
    document.documentElement.append(frame); // kept: functions of a removed frame stop working
    const proto = frame.contentWindow.MediaDevices.prototype;
    const native = (name) => (...args) => proto[name].apply(md, args);
    return { getUserMedia: native('getUserMedia'), enumerateDevices: native('enumerateDevices') };
  } catch {
    return { getUserMedia: (c) => md.getUserMedia(c), enumerateDevices: () => md.enumerateDevices() };
  }
})();

// "Not Headset": talk through the camera's own microphone instead of the headset, e.g. when the
// headset has to come off mid-call. Remembered per computer, switchable at any time in a call.
const MIC_SOURCE_KEY = 'callBridge.micSource'; // 'camera' while Not Headset is on
let micSource = storage.get(MIC_SOURCE_KEY) === 'camera' ? 'camera' : 'headset';

// Labels that mark a headset (or the jack it plugs into) and ones that mark a camera's microphone.
const HEADSET_LABEL = /headset|headphone|earphone|jack|airpods|buds|hands-?free|bluetooth/i;
const CAMERA_LABEL = /camera|webcam|\bcam\b|brio|c9[0-9]{2}|usb2\.0 mic|video/i;

/**
 * The camera's microphone: the audio input in the same device group as a camera (one USB device),
 * else one whose name says camera/webcam. Never a headset. null when there isn't one.
 */
async function cameraMic() {
  const devices = (await media.enumerateDevices())
    .filter(d => d.deviceId && !['default', 'communications'].includes(d.deviceId));
  const mics = devices.filter(d => d.kind === 'audioinput' && !HEADSET_LABEL.test(d.label) && !VIRTUAL_LABEL.test(d.label));
  const cameraGroups = new Set(devices.filter(d => d.kind === 'videoinput').map(d => d.groupId));
  return mics.find(d => cameraGroups.has(d.groupId)) || mics.find(d => CAMERA_LABEL.test(d.label)) || null;
}

// Virtual microphones made by other software (e.g. the "Background Noise Remover" Chrome extension),
// which would process the voice: never picked by name or as a fallback.
const VIRTUAL_LABEL = /noise remover|krisp|nvidia broadcast|virtual|voicemeeter|vb-audio|cable output/i;

// ---- Krisp --------------------------------------------------------------------------------------
// With the Krisp desktop app installed, its "Krisp Microphone" carries your voice with the noise
// already removed by Krisp. It's used whenever it's present (switchable off), with Chrome's own
// noise suppression off so the two don't both process the voice. Krisp decides which physical
// microphone it listens to (set in the Krisp app), so "Not Headset" is unavailable meanwhile.
// If Krisp goes away (app closed), the app carries on with the headset by itself.
const KRISP_LABEL = /krisp/i;
const KRISP_KEY = 'callBridge.krisp'; // 'off' after the user turned Krisp off
let useKrisp = storage.get(KRISP_KEY) !== 'off';
let krispPresent = false;

async function krispMic() {
  return (await media.enumerateDevices()).find(d => d.kind === 'audioinput' && KRISP_LABEL.test(d.label)
    && d.deviceId && !['default', 'communications'].includes(d.deviceId)) || null;
}

/** The Krisp microphone when it's present and switched on, else null. */
async function krispInUse() {
  const mic = await krispMic();
  krispPresent = !!mic;
  return useKrisp ? mic : null;
}

const krispActive = () => useKrisp && krispPresent;

/**
 * The headset: the real device behind Windows' default microphone. Asked for by its exact id,
 * because a generic request ("any microphone") is what extensions such as Background Noise Remover
 * intercept and answer with their processed audio instead of the microphone itself.
 */
async function headsetMic() {
  const devices = (await media.enumerateDevices()).filter(d => d.kind === 'audioinput');
  const real = devices.filter(d => d.deviceId && !['default', 'communications'].includes(d.deviceId) && !VIRTUAL_LABEL.test(d.label));
  const def = devices.find(d => d.deviceId === 'default');
  const camera = await cameraMic();
  return real.find(d => def && d.groupId === def.groupId && !VIRTUAL_LABEL.test(def.label))
    || real.find(d => HEADSET_LABEL.test(d.label))
    || real.find(d => d.deviceId !== camera?.deviceId)
    || null;
}

/**
 * getUserMedia constraints for the chosen source; throws a plain-language error if it's missing.
 * `krisp: false` leaves Krisp out (its microphone couldn't be opened).
 */
async function micConstraintsFor(source, { krisp: allowKrisp = true } = {}) {
  const krisp = allowKrisp && await krispInUse();
  if (krisp) return { audio: { ...RAW_AUDIO, noiseSuppression: false, deviceId: { exact: krisp.deviceId } } };
  if (source !== 'camera') {
    const mic = await headsetMic();
    return mic ? { audio: { ...RAW_AUDIO, deviceId: { exact: mic.deviceId } } } : MIC_CONSTRAINTS;
  }
  const mic = await cameraMic();
  if (!mic) {
    const err = new Error("No camera microphone was found. Check that the camera's microphone is enabled in Windows Sound settings (Recording), then try again.");
    err.name = 'NoCameraMic';
    throw err;
  }
  return { audio: { ...RAW_AUDIO, deviceId: { exact: mic.deviceId } } };
}

const NOT_HEADSET_TITLE = $('notHeadset').title;

function setMicSourceButton() {
  const btn = $('notHeadset');
  const krisp = krispActive();
  btn.disabled = krisp;
  btn.title = krisp ? 'Krisp is in use: choose the headset or camera microphone in the Krisp app' : NOT_HEADSET_TITLE;
  btn.setAttribute('aria-pressed', !krisp && micSource === 'camera');
  btn.textContent = !krisp && micSource === 'camera' ? 'Use headset' : 'Not Headset';
  $('krispRow').hidden = !krispPresent;
  $('useKrisp').checked = useKrisp;
}

/** Reopens the call's microphone with the current choice (Krisp switched on/off, or appeared/gone). */
async function reopenMic() {
  if (audio?.input) await switchMic(micSource, { remember: false });
}

/** Krisp appearing or disappearing (its app started or closed): update the button, and the call's mic. */
async function refreshKrisp() {
  krispPresent = !!(await krispMic());
  setMicSourceButton();
  const track = audio?.stream?.getAudioTracks()[0];
  if (track && audio.input && KRISP_LABEL.test(track.label) !== krispActive()) await reopenMic();
}

/**
 * Switches the call's microphone to `source` without interrupting the call; keeps the old one on
 * failure. `remember`: save it as the choice for later calls (the button does; an automatic
 * fallback after the headset is unplugged doesn't, so the next call starts on the headset again).
 */
async function switchMic(source, { remember = true } = {}) {
  const mine = audio;
  const previous = micSource;
  micSource = source;
  if (remember) storage.set(source === 'camera' ? 'camera' : '', MIC_SOURCE_KEY);
  setMicSourceButton();
  if (!mine?.input) return; // not on a call (or its mic isn't open yet): the next call uses it
  try {
    const stream = await media.getUserMedia(await micConstraintsFor(source));
    if (audio !== mine) { stream.getTracks().forEach(t => t.stop()); return; }
    const src = mine.ctx.createMediaStreamSource(stream);
    src.connect(mine.input);
    mine.src?.disconnect();
    mine.stream?.getTracks().forEach(t => t.stop());
    Object.assign(mine, { stream, src });
    watchMic(mine);
    showMicSource(stream, source);
  } catch (err) {
    micSource = previous;
    if (remember) storage.set(previous === 'camera' ? 'camera' : '', MIC_SOURCE_KEY);
    setMicSourceButton();
    setStatus(err.name === 'NoCameraMic' ? err.message : micProblem(err));
  }
}

function showMicSource(stream, source) {
  const track = stream.getAudioTracks()[0];
  const how = KRISP_LABEL.test(track?.label || '') ? 'noise removed by Krisp' : 'background noise removed';
  $('micSource').textContent = `Microphone: ${track?.label || source}, ${how}`;
}

/**
 * A headset unplugged mid-call ends its track: carry on with the camera's microphone by itself.
 * Chrome also ends a microphone track when Windows' device list changes (e.g. another microphone
 * is opened or closed) with the headset still there; then the headset is simply reopened. The
 * fallback isn't saved as the choice for later calls.
 */
function watchMic(mine) {
  const track = mine.stream.getAudioTracks()[0];
  if (!track) return;
  const deviceId = track.getSettings().deviceId;
  const isKrisp = KRISP_LABEL.test(track.label);
  track.onended = async () => {
    if (audio !== mine || mine.ending || mine.stream?.getAudioTracks()[0] !== track) return;
    const present = (await media.enumerateDevices()).some(d => d.kind === 'audioinput' && d.deviceId === deviceId);
    if (audio !== mine || mine.ending) return;
    if (isKrisp) { // Krisp closed: carry on with the headset (or reopen Krisp if it's only been reset)
      if (!present) setStatus('Krisp is no longer available: switching to the headset microphone.');
      switchMic(micSource, { remember: false });
      return;
    }
    if (micSource !== 'headset') return;
    if (present) {
      switchMic('headset', { remember: false }); // still plugged in: just reopen it
    } else {
      setStatus('The headset was disconnected: switching to the camera microphone.');
      switchMic('camera', { remember: false });
    }
  };
}

/** Plain-language reason a microphone can't be used, from a getUserMedia error. */
function micProblem(err) {
  if (!window.isSecureContext || !navigator.mediaDevices) return 'The microphone only works over https://. Open this page with its https:// address.';
  switch (err?.name) {
    case 'NotAllowedError':
    case 'SecurityError':
      return 'Chrome blocked the microphone for this site. Click the icon left of the address bar, set Microphone to Allow, then reload this page.';
    case 'NotFoundError':
    case 'OverconstrainedError':
      return 'No microphone was found on this computer. Open this page on the computer you talk on (not on the VPS), or plug in a microphone.';
    case 'NotReadableError':
    case 'AbortError':
      return 'The microphone is in use by another program or cannot be opened. Close other apps that use it and try again.';
    default:
      return `Microphone unavailable (${err?.message || err}).`;
  }
}

/** Asks for the microphone once (so Chrome shows its prompt now, not mid-call) and reports the result. */
async function checkMic() {
  try {
    // A generic request first, since device names stay hidden until the microphone is allowed once.
    const first = await media.getUserMedia(MIC_CONSTRAINTS);
    first.getTracks().forEach(t => t.stop());
    const stream = await media.getUserMedia(await micConstraintsFor(micSource).catch(() => micConstraintsFor('headset')));
    const label = `Microphone ready: ${stream.getAudioTracks()[0]?.label || 'default microphone'}`;
    stream.getTracks().forEach(t => t.stop());
    $('mic').textContent = label;
    $('mic').dataset.ok = 'true';
    refreshKrisp();
  } catch (err) {
    $('mic').textContent = micProblem(err);
    $('mic').dataset.ok = 'false';
  }
}

// ---- Connection -------------------------------------------------------------------------------

function connect() {
  clearTimeout(retryTimer);
  if (ws) { ws.onclose = null; ws.close(); }
  ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/operator`);
  ws.binaryType = 'arraybuffer';
  setStatus(active ? 'Connection lost — reconnecting. Your call is kept and its audio will catch up.' : retry ? 'Reconnecting…' : 'Connecting…');
  // On a call, ask for it back and say how much of the caller's audio arrived; the server sends the rest.
  ws.onopen = () => ws.send(JSON.stringify(active ? { type: 'hello', token, resume: active.callId, have } : { type: 'hello', token }));
  ws.onmessage = (e) => {
    if (typeof e.data !== 'string') {
      if (active && linked) { have++; play(e.data); }
      return;
    }
    const msg = JSON.parse(e.data);
    switch (msg.type) {
      case 'ready':
        retry = 0;
        iceServers = msg.iceServers || [];
        if (!active) setStatus('Connected. Waiting for calls.');
        $('login').hidden = true;
        $('main').hidden = false;
        break;
      case 'calls': render(msg); break;
      case 'taken':
        answering = null;
        if (active?.callId === msg.callId) resumed(msg);
        else startCall(msg.callId, msg.caller, !!msg.muted, msg);
        break;
      case 'mute-state': if (active?.callId === msg.callId) setMuted(msg.muted); break;
      case 'released': if (!active || active.callId === msg.callId) endCall(`Call ended: ${msg.reason.replace(/\.$/, '')}.`); break;
      case 'error': answering = null; setStatus(msg.message); renderRings(); break;
      case 'video-answer': camera?.pc.setRemoteDescription({ type: 'answer', sdp: msg.sdp }).catch(() => {}); break;
      case 'video-ice': if (msg.candidate) camera?.pc.addIceCandidate(msg.candidate).catch(() => {}); break;
    }
  };
  ws.onclose = (e) => {
    linked = false;
    updateRinging([]);
    if (e.code === 4001) {
      endCall();
      wantConnected = false;
      storage.set('');
      showLogin('Wrong operator token.');
      return;
    }
    // Another Call Bridge window picked this call up: it's that window's now.
    if (e.code === 4003) endCall('This call continued in another Call Bridge window.');
    if (!wantConnected) { endCall(); showLogin('Signed out.'); return; }
    if (active) {
      // Network blip or server restart mid-call: keep the call, its sound and the microphone going and
      // reconnect fast; the server holds the call and both sides catch up on what they missed.
      lostAt ||= Date.now();
      if (Date.now() - lostAt > RESUME_FOR_MS) {
        endCall('Call ended: the connection to the server was down for over a minute.');
      } else {
        retryTimer = setTimeout(connect, Math.min(2000, 250 * 2 ** retry++));
        setStatus('Connection lost — reconnecting. Your call is kept and its audio will catch up.');
        return;
      }
    }
    // Network blip, server restart, laptop asleep: keep trying, the server stays up.
    const delay = Math.min(15000, 1000 * 2 ** retry++);
    setStatus(`Connection lost. Reconnecting in ${Math.round(delay / 1000)} s…`);
    retryTimer = setTimeout(connect, delay);
  };
}

/** The server gave this app its call back after a reconnect: send it the microphone audio it missed. */
function resumed(msg) {
  lostAt = 0;
  linked = true;
  have = msg.seq;
  sentUpTo = Math.min(msg.got, produced);
  setMuted(msg.muted ?? muted);
  sendMic();
}

function keepMic(pcm) {
  kept.push({ seq: ++produced, pcm });
  if (kept.length > KEEP_FRAMES) kept.shift();
  sendMic();
}

/** Sends every kept microphone frame after `sentUpTo`, in order, while the call is linked. */
function sendMic() {
  if (!linked || ws?.readyState !== WebSocket.OPEN || !kept.length) return;
  sentUpTo = Math.max(sentUpTo, kept[0].seq - 1); // older ones are gone (over a minute offline)
  for (let i = sentUpTo + 1 - kept[0].seq; i < kept.length; i++) {
    ws.send(kept[i].pcm);
    sentUpTo = kept[i].seq;
  }
}

function signIn(newToken, remember) {
  token = newToken;
  wantConnected = true;
  retry = 0;
  storage.set(remember ? token : '');
  connect();
}

function showLogin(message) {
  $('login').hidden = false;
  $('main').hidden = true;
  setStatus(message);
}

// ---- Rendering --------------------------------------------------------------------------------

function render({ calls, rings: ringing = [], stations = 0, stationList = [], mine }) {
  $('stations').textContent = stations
    ? `Teams computer linked: ${stationList.map(s => `${s.address} (${s.client})`).join(', ')}.`
    : 'No Teams computer is linked. Calls can\'t ring here until the extension is online.';
  $('stations').dataset.ok = stations ? 'true' : 'false';
  updateRinging(ringing);
  renderCalls(calls, mine);
}

function renderRings() {
  const list = $('rings');
  $('ringsSection').hidden = !rings.length;
  list.replaceChildren(...rings.map((r) => {
    const li = document.createElement('li');
    li.className = 'card ring';
    const who = document.createElement('strong');
    who.textContent = r.caller;
    const sub = document.createElement('span');
    sub.className = 'muted';
    sub.textContent = r.ringId === answering ? 'Answering…' : (r.answering ? 'Being answered by another operator' : 'Incoming Teams call');
    const text = document.createElement('div');
    text.append(who, document.createElement('br'), sub);
    const answer = document.createElement('button');
    answer.className = 'primary';
    answer.textContent = 'Answer';
    answer.disabled = !!answering || r.answering;
    answer.onclick = () => {
      answering = r.ringId;
      ws.send(JSON.stringify({ type: 'answer', ringId: r.ringId }));
      setStatus(`Answering ${r.caller}…`);
      renderRings();
    };
    const decline = document.createElement('button');
    decline.className = 'danger';
    decline.textContent = 'Decline';
    decline.disabled = !!answering || r.answering;
    decline.onclick = () => ws.send(JSON.stringify({ type: 'decline', ringId: r.ringId }));
    const btns = document.createElement('div');
    btns.className = 'row';
    btns.append(answer, decline);
    li.append(text, btns);
    return li;
  }));
}

function renderCalls(calls, mine) {
  $('callsSection').hidden = !calls.length;
  $('calls').replaceChildren(...calls.map((c) => {
    const li = document.createElement('li');
    li.className = 'card';
    const who = document.createElement('span');
    const since = new Date(c.startedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    who.textContent = `${c.caller} · since ${since}${c.connected ? '' : ' · reconnecting'}`;
    const btn = document.createElement('button');
    if (c.id === mine) { btn.textContent = 'Yours'; btn.disabled = true; }
    else if (c.taken) { btn.textContent = 'Taken'; btn.disabled = true; }
    else { btn.textContent = 'Take call'; btn.className = 'primary'; btn.onclick = () => ws.send(JSON.stringify({ type: 'take', callId: c.id })); }
    li.append(who, btn);
    return li;
  }));
}

// ---- Ringing: list, ringtone, desktop notification, title ------------------------------------

let ringCtx = null;
let ringTimer = null;

/** Called on a click, so Chrome allows sound later (autoplay rules); also starts a call's held-back sound. */
function unlockSound() {
  ringCtx ||= new AudioContext();
  ringCtx.resume().catch(() => {});
  if (audio?.ctx.state === 'suspended') audio.ctx.resume().catch(() => {});
}

function ringBurst() {
  if (!ringCtx || ringCtx.state !== 'running') return;
  const t = ringCtx.currentTime;
  const gain = new GainNode(ringCtx, { gain: 0 });
  gain.connect(ringCtx.destination);
  for (const hz of [440, 480]) {
    const osc = new OscillatorNode(ringCtx, { frequency: hz });
    osc.connect(gain);
    osc.start(t);
    osc.stop(t + 1.4);
  }
  for (const [on, off] of [[0, 0.4], [0.6, 1.0]]) {
    gain.gain.setValueAtTime(0.12, t + on);
    gain.gain.setValueAtTime(0, t + off);
  }
}

function updateRinging(next) {
  const ids = new Set(next.map(r => r.ringId));
  for (const [id, n] of notes) if (!ids.has(id)) { n.close(); notes.delete(id); }
  rings = next;
  renderRings();

  const shouldRing = rings.some(r => !r.answering) && !active && !answering;
  if (shouldRing && !ringTimer) {
    ringBurst();
    ringTimer = setInterval(ringBurst, 3000);
  } else if (!shouldRing && ringTimer) {
    clearInterval(ringTimer);
    ringTimer = null;
  }
  document.title = shouldRing ? `📞 ${rings[0].caller} is calling` : 'Call Bridge';

  if (shouldRing && 'Notification' in window && Notification.permission === 'granted') {
    for (const r of rings) {
      if (notes.has(r.ringId) || r.answering) continue;
      const n = new Notification('Incoming Teams call', { body: `${r.caller} — open Call Bridge to answer`, tag: r.ringId, requireInteraction: true });
      n.onclick = () => { window.focus(); n.close(); };
      notes.set(r.ringId, n);
    }
  }
}

// ---- Call audio -------------------------------------------------------------------------------

async function startCall(callId, caller, startMuted = false, { seq = 0, got = 0 } = {}) {
  endCall();
  active = { callId, caller, since: Date.now() };
  linked = true;
  have = seq;
  produced = sentUpTo = got; // this microphone's frames are numbered on from what the call already has
  setMuted(startMuted);
  updateRinging(rings);
  $('active').hidden = false;
  $('activeCaller').textContent = caller;
  tick();
  // Sound first, so the caller's first words play while the microphone is still being opened.
  // 48 kHz, the microphone's usual native rate, so Chrome rarely has to convert it.
  const ctx = new AudioContext({ sampleRate: 48000 });
  const mine = audio = { ctx, stream: null, nextTime: 0, tap: null, played: 0, micFrames: 0, micPeak: 0, micError: null };
  // Chrome keeps sound off in a window nobody has clicked since it opened (e.g. one Windows started):
  // say so, and the next click anywhere turns it on (unlockSound).
  ctx.onstatechange = () => {
    if (audio !== mine) return;
    if (ctx.state !== 'running') soundBlocked(mine);
    else if (mine.micError) setStatus(`${mine.micError} You can still listen.`);
    else setMuted(muted);
    if (mine.reported) reportSound(mine); // a change after the first report
  };
  ctx.resume().catch(() => {});
  setTimeout(() => soundBlocked(mine), 1000);
  setTimeout(() => reportSound(mine), 5000); // by then the speakers and microphone have shown whether they work
  try {
    let stream;
    try {
      stream = await media.getUserMedia(await micConstraintsFor(micSource));
    } catch (err) {
      if (krispActive()) {
        // Krisp's microphone is listed but won't open (its app isn't running): talk through the headset.
        setStatus(`The Krisp microphone couldn't be opened (${micProblem(err)}) Using the headset instead.`);
        stream = await media.getUserMedia(await micConstraintsFor('headset', { krisp: false }));
      } else if (micSource === 'camera') {
        // The camera's microphone is gone: talk through the headset rather than not at all.
        setStatus(`${err.name === 'NoCameraMic' ? err.message : micProblem(err)} Using the headset instead.`);
        micSource = 'headset';
        setMicSourceButton();
        stream = await media.getUserMedia(await micConstraintsFor('headset'));
      } else {
        throw err;
      }
    }
    if (audio !== mine) { stream.getTracks().forEach(t => t.stop()); return; } // the call ended meanwhile
    mine.stream = stream;
    const src = mine.src = ctx.createMediaStreamSource(stream);
    // Not noise removal: the link carries 16 kHz audio, which can't hold anything above 8 kHz, and
    // resampling without this would fold those highs back in as audible distortion (aliasing).
    const antiAlias = new BiquadFilterNode(ctx, { type: 'lowpass', frequency: 7000 });
    // Mains hum, desk thumps and fan rumble sit below any voice: cut them.
    const highpass = mine.input = new BiquadFilterNode(ctx, { type: 'highpass', frequency: 80, Q: 0.7 });
    // Captured on the audio thread (AudioWorklet), so a busy or background window doesn't drop any of it.
    await ctx.audioWorklet.addModule('capture-worklet.js');
    const tap = mine.tap = new AudioWorkletNode(ctx, 'capture', {
      numberOfInputs: 1, numberOfOutputs: 1, channelCount: 1, channelCountMode: 'explicit',
    });
    const toPcm = downsampler(ctx.sampleRate, (pcm) => {
      if (mine.micFrames++ < 250) mine.micPeak = Math.max(mine.micPeak, peakOf(pcm)); // the first 5 s, for reportSound
      if (!muted && audio === mine) keepMic(pcm);
    });
    tap.port.onmessage = (e) => toPcm(e.data);
    src.connect(highpass).connect(antiAlias).connect(tap).connect(new GainNode(ctx, { gain: 0 })).connect(ctx.destination);
    watchMic(mine);
    showMicSource(stream, micSource);
    if (audio === mine) setMuted(muted); // shows "Talking to …" or "Muted …"
  } catch (err) {
    if (audio !== mine) return;
    mine.micError = micProblem(err);
    setStatus(`${mine.micError} You can still listen.`);
    reportSound(mine);
  }
}

/** Chrome hasn't let this call's sound start: ask for the click that does. */
function soundBlocked(mine) {
  if (audio === mine && mine.ctx.state === 'suspended') setStatus('Click anywhere in this window to hear the caller (Chrome keeps sound off until you do).');
}

/** Peak level of a 16-bit PCM frame, 0..1. */
function peakOf(pcm) {
  const s = new Int16Array(pcm);
  let peak = 0;
  for (let i = 0; i < s.length; i++) peak = Math.max(peak, Math.abs(s[i]));
  return peak / 0x8000;
}

/**
 * Tells the server, for its log, how this call's sound is doing here: whether the speakers run
 * and how much of the caller has played, and which microphone is open and whether it hears anything.
 */
function reportSound(mine) {
  if (audio !== mine || !active || ws?.readyState !== WebSocket.OPEN) return;
  mine.reported = true;
  ws.send(JSON.stringify({
    type: 'sound', callId: active.callId,
    speakers: mine.ctx.state, playedS: +mine.played.toFixed(1),
    mic: mine.stream?.getAudioTracks()[0]?.label || null, micError: mine.micError,
    micPeak: mine.micFrames ? +mine.micPeak.toFixed(4) : null,
  }));
}

function endCall(message) {
  if (audio) {
    audio.ending = true; // the tracks stopped below aren't a headset being unplugged
    audio.stream?.getTracks().forEach(t => t.stop());
    audio.ctx.close();
    audio = null;
  }
  stopCamera(false);
  const wasActive = !!active;
  active = null;
  linked = false;
  lostAt = 0;
  kept = [];
  setMuted(false); // the next call starts unmuted unless the Teams computer says otherwise
  clearTimeout(clock);
  $('active').hidden = true;
  if (wasActive) updateRinging(rings);
  if (message) setStatus(message);
}

// ---- Camera control ----------------------------------------------------------------------------
// "Take full control" sends this computer's camera into the call in place of the Teams computer's,
// over a direct WebRTC connection (via the TURN relay the server handed us in iceServers). It can
// start or stop at any point in the call, independently of the mic bridge above, which keeps running
// either way.

function setCameraButton() {
  $('camera').setAttribute('aria-pressed', !!camera);
  $('camera').textContent = camera ? 'Stop camera' : 'Take full control (camera)';
}

async function startCamera() {
  if (!active || camera) return;
  try {
    const raw = await media.getUserMedia({ video: { width: 640, height: 480, frameRate: 15 } });
    // The background is applied here: in this mode the call carries this camera, not the Teams
    // computer's, so a background chosen in Teams itself never reaches the caller.
    let effect = null;
    try {
      effect = await BackgroundEffect.apply(raw, background);
    } catch (err) {
      setStatus(`Background effect unavailable, sending the plain camera: ${err.message}`);
    }
    const stream = effect?.stream || raw;
    const pc = new RTCPeerConnection({ iceServers });
    camera = { pc, stream, raw, effect, callId: active.callId };
    pc.onicecandidate = (e) => ws?.send(JSON.stringify({ type: 'video-ice', callId: active.callId, candidate: e.candidate || null }));
    pc.onconnectionstatechange = () => {
      if (camera && ['failed', 'closed'].includes(pc.connectionState)) stopCamera();
    };
    for (const track of stream.getVideoTracks()) pc.addTransceiver(track, { direction: 'sendonly', streams: [stream] });
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    ws.send(JSON.stringify({ type: 'video-offer', callId: active.callId, sdp: pc.localDescription.sdp }));
    $('cameraPreview').srcObject = stream;
    $('cameraPreview').hidden = false;
    $('cameraStatus').textContent = 'Sending this camera to the call.';
    setCameraButton();
  } catch (err) {
    setStatus(`Camera unavailable (${err.name}): ${err.message}`);
  }
}

function stopCamera(notifyServer = true) {
  if (!camera) return;
  const { pc, raw, effect, callId } = camera;
  effect?.stop();
  raw.getTracks().forEach(t => t.stop());
  pc.close();
  camera = null;
  $('cameraPreview').hidden = true;
  $('cameraPreview').srcObject = null;
  $('cameraStatus').textContent = '';
  setCameraButton();
  if (notifyServer && ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'video-stop', callId }));
}

function tick() {
  if (!active) return;
  const sec = Math.floor((Date.now() - active.since) / 1000);
  $('activeClock').textContent = `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`;
  clock = setTimeout(tick, 1000);
}

function play(pcm) {
  if (!audio) return;
  const { ctx } = audio;
  const samples = new Int16Array(pcm);
  const buf = ctx.createBuffer(1, samples.length, RATE);
  const ch = buf.getChannelData(0);
  for (let i = 0; i < samples.length; i++) ch[i] = samples[i] / 0x8000;
  const now = ctx.currentTime;
  if (audio.nextTime < now + 0.01) audio.nextTime = now + START_BUFFER_S;
  const ahead = audio.nextTime - now;
  // Behind after a hiccup or a reconnect: catch up by leaving out pauses, never the caller's words.
  if ((ahead > CATCHUP_S && rms(ch) < QUIET_RMS) || ahead > MAX_BACKLOG_S) return;
  const src = new AudioBufferSourceNode(ctx, { buffer: buf });
  src.connect(ctx.destination);
  src.start(audio.nextTime);
  audio.nextTime += buf.duration;
  audio.played += buf.duration;
}

function rms(f) {
  let sum = 0;
  for (let i = 0; i < f.length; i++) sum += f[i] * f[i];
  return Math.sqrt(sum / f.length);
}

/** Float32 at `fromRate` -> 20 ms Int16 frames at 16 kHz (input already low-passed). */
function downsampler(fromRate, emit) {
  const step = fromRate / RATE;
  let pos = 0;
  let last = 0;
  let frame = new Int16Array(FRAME);
  let filled = 0;
  return (input) => {
    while (pos < input.length - 1) {
      const i = Math.floor(pos);
      const a = i < 0 ? last : input[i];
      const s = Math.max(-1, Math.min(1, a + (input[i + 1] - a) * (pos - i)));
      frame[filled++] = s < 0 ? s * 0x8000 : s * 0x7fff;
      if (filled === FRAME) { emit(frame.buffer); frame = new Int16Array(FRAME); filled = 0; }
      pos += step;
    }
    pos -= input.length;
    last = input[input.length - 1];
  };
}

// ---- Wiring -----------------------------------------------------------------------------------

$('login').addEventListener('submit', (e) => {
  e.preventDefault();
  unlockSound();
  if ('Notification' in window && Notification.permission === 'default') Notification.requestPermission();
  signIn($('token').value.trim(), $('remember').checked);
  checkMic();
});
$('signOut').addEventListener('click', () => {
  wantConnected = false;
  storage.set('');
  ws?.close();
});
// Mute is shared with the Teams computer: the app stops sending at once, and the extension presses
// Teams' own Mute there. Muting in Teams comes back as 'mute-state' and updates this button.
$('mute').addEventListener('click', () => {
  const next = !muted;
  setMuted(next);
  if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'mute', muted: next }));
});
$('notHeadset').addEventListener('click', () => { if (!krispActive()) switchMic(micSource === 'camera' ? 'headset' : 'camera'); });
$('useKrisp').addEventListener('change', () => {
  useKrisp = $('useKrisp').checked;
  storage.set(useKrisp ? '' : 'off', KRISP_KEY);
  setMicSourceButton();
  reopenMic();
});
navigator.mediaDevices?.addEventListener('devicechange', () => refreshKrisp());
setMicSourceButton();
refreshKrisp();
$('release').addEventListener('click', () => ws.send(JSON.stringify({ type: 'release' })));
$('camera').addEventListener('click', () => (camera ? stopCamera() : startCamera()));

// ---- Camera background (see background-effect.js) ----------------------------------------------
// The choices are Teams' own: blur, or one of three of its stock backgrounds (served from
// /backgrounds). Remembered on this computer.
const BACKGROUNDS = {
  inTheZone1: 'backgrounds/inTheZone1.jpg',
  inTheZone2: 'backgrounds/inTheZone2.jpg',
  starfieldGravJump: 'backgrounds/starfieldGravJump.jpg',
};
const background = { mode: 'none', image: null };
const images = {}; // choice -> Promise<HTMLImageElement>

function loadImage(url) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('That background could not be loaded.'));
    img.src = url;
  });
}

/** Sets `background` from a choice in the menu: 'none', 'blur', or a key of BACKGROUNDS. */
async function chooseBackground(choice) {
  if (!BACKGROUNDS[choice] && choice !== 'blur') choice = 'none';
  try { localStorage.setItem('bgChoice', choice); } catch { /* storage blocked: not remembered */ }
  if (BACKGROUNDS[choice]) {
    images[choice] ??= loadImage(BACKGROUNDS[choice]);
    const img = await images[choice].catch((err) => { delete images[choice]; setStatus(err.message); return null; });
    if ($('bgMode').value !== choice) return; // changed again while loading
    Object.assign(background, img ? { mode: 'image', image: img } : { mode: 'blur', image: null });
  } else {
    Object.assign(background, { mode: choice, image: null });
  }
  camera?.effect?.setSettings(background);
  if (background.mode !== 'none') BackgroundEffect.preload().catch(() => setStatus('The background effect could not load.'));
}

$('bgMode').addEventListener('change', () => chooseBackground($('bgMode').value));

(() => {
  let choice = 'none';
  try { choice = localStorage.getItem('bgChoice') || 'none'; } catch { /* nothing remembered */ }
  $('bgMode').value = BACKGROUNDS[choice] || choice === 'blur' ? choice : 'none';
  chooseBackground($('bgMode').value);
})();

$('handBack').addEventListener('click', () => {
  if (active) ws.send(JSON.stringify({ type: 'stop', callId: active.callId }));
});
$('endCall').addEventListener('click', () => {
  if (active) ws.send(JSON.stringify({ type: 'end-call', callId: active.callId }));
});
// Any click makes later ringing audible (Chrome blocks sound until the user has interacted).
document.addEventListener('pointerdown', unlockSound);

// Install as a desktop app (Chrome shows this when the app isn't installed yet).
let installPrompt = null;
window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  installPrompt = e;
  $('install').hidden = false;
});
$('install').addEventListener('click', async () => {
  $('install').hidden = true;
  await installPrompt?.prompt();
  installPrompt = null;
});
if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});

// Remembered on this computer: connect straight away (also after Windows starts the app).
const saved = storage.get();
if (saved) {
  $('remember').checked = true;
  signIn(saved, true);
  checkMic();
}
