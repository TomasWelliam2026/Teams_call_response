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
const MIC_CONSTRAINTS = { audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } };

const $ = (id) => document.getElementById(id);
let ws = null;
let token = '';
let wantConnected = false; // false after Sign out or a rejected token: don't reconnect
let retry = 0;
let retryTimer = null;
let audio = null;   // { ctx, stream, nextTime } while on a call
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

/** While muted nothing from this microphone is sent (see startCall). */
function setMuted(value) {
  muted = !!value;
  $('mute').setAttribute('aria-pressed', muted);
  $('mute').textContent = muted ? 'Unmute' : 'Mute';
  if (active) setStatus(muted ? `Muted — ${active.caller} can't hear you.` : `Talking to ${active.caller}.`);
}

const storage = {
  get() { try { return localStorage.getItem(TOKEN_KEY) || ''; } catch { return ''; } },
  set(v) { try { v ? localStorage.setItem(TOKEN_KEY, v) : localStorage.removeItem(TOKEN_KEY); } catch { /* private mode */ } },
};

// ---- Microphone -------------------------------------------------------------------------------

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
    const stream = await navigator.mediaDevices.getUserMedia(MIC_CONSTRAINTS);
    const label = stream.getAudioTracks()[0]?.label || 'default microphone';
    stream.getTracks().forEach(t => t.stop());
    $('mic').textContent = `Microphone ready: ${label}`;
    $('mic').dataset.ok = 'true';
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

function render({ calls, rings: ringing = [], stations = 0, mine }) {
  $('stations').textContent = stations
    ? `Teams computer linked${stations > 1 ? ` (${stations})` : ''}.`
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

/** Called on a click, so Chrome allows sound later (autoplay rules). */
function unlockSound() {
  ringCtx ||= new AudioContext();
  ringCtx.resume().catch(() => {});
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
  const ctx = new AudioContext();
  const mine = audio = { ctx, stream: null, nextTime: 0 };
  ctx.resume().catch(() => {});
  try {
    const stream = await navigator.mediaDevices.getUserMedia(MIC_CONSTRAINTS);
    if (audio !== mine) { stream.getTracks().forEach(t => t.stop()); return; } // the call ended meanwhile
    mine.stream = stream;
    const src = ctx.createMediaStreamSource(stream);
    const lowpass = new BiquadFilterNode(ctx, { type: 'lowpass', frequency: 7000 });
    // Captured on the audio thread (AudioWorklet), so a busy or background window doesn't drop any of it.
    await ctx.audioWorklet.addModule('capture-worklet.js');
    const tap = new AudioWorkletNode(ctx, 'capture', { numberOfInputs: 1, numberOfOutputs: 1, channelCount: 1, channelCountMode: 'explicit' });
    const toPcm = downsampler(ctx.sampleRate, (pcm) => { if (!muted && audio === mine) keepMic(pcm); });
    tap.port.onmessage = (e) => toPcm(e.data);
    src.connect(lowpass).connect(tap).connect(new GainNode(ctx, { gain: 0 })).connect(ctx.destination);
    if (audio === mine) setMuted(muted); // shows "Talking to …" or "Muted …"
  } catch (err) {
    if (audio === mine) setStatus(`${micProblem(err)} You can still listen.`);
  }
}

function endCall(message) {
  if (audio) {
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
    const stream = await navigator.mediaDevices.getUserMedia({ video: { width: 640, height: 480, frameRate: 15 } });
    const pc = new RTCPeerConnection({ iceServers });
    camera = { pc, stream, callId: active.callId };
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
  const { pc, stream, callId } = camera;
  stream.getTracks().forEach(t => t.stop());
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
$('release').addEventListener('click', () => ws.send(JSON.stringify({ type: 'release' })));
$('camera').addEventListener('click', () => (camera ? stopCamera() : startCamera()));
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
