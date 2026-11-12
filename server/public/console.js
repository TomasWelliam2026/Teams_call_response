// Call Bridge local app. Installable from Chrome as its own window. It shows Teams calls ringing
// on the linked Teams computer; Answer makes the extension answer there and routes the call here:
// the caller's audio plays on this computer and this computer's microphone goes to the caller
// (PCM s16le, mono, 16 kHz, 20 ms frames).
const RATE = 16000;
const FRAME = 320;
const START_BUFFER_S = 0.08;
const MAX_AHEAD_S = 0.6;
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
let answering = null; // ringId we pressed Answer on, until the call arrives
let muted = false;
let clock = null;
let rings = [];
const notes = new Map(); // ringId -> Notification

function setStatus(text) { $('status').textContent = text; }

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
  setStatus(retry ? 'Reconnecting…' : 'Connecting…');
  ws.onopen = () => ws.send(JSON.stringify({ type: 'hello', token }));
  ws.onmessage = (e) => {
    if (typeof e.data !== 'string') { play(e.data); return; }
    const msg = JSON.parse(e.data);
    switch (msg.type) {
      case 'ready':
        retry = 0;
        setStatus('Connected. Waiting for calls.');
        $('login').hidden = true;
        $('main').hidden = false;
        break;
      case 'calls': render(msg); break;
      case 'taken': answering = null; startCall(msg.callId, msg.caller); break;
      case 'released': endCall(`Call ended: ${msg.reason.replace(/\.$/, '')}.`); break;
      case 'error': answering = null; setStatus(msg.message); renderRings(); break;
    }
  };
  ws.onclose = (e) => {
    endCall();
    updateRinging([]);
    if (e.code === 4001) {
      wantConnected = false;
      storage.set('');
      showLogin('Wrong operator token.');
      return;
    }
    if (!wantConnected) { showLogin('Signed out.'); return; }
    // Network blip, server restart, laptop asleep: keep trying, the server stays up.
    const delay = Math.min(15000, 1000 * 2 ** retry++);
    setStatus(`Connection lost. Reconnecting in ${Math.round(delay / 1000)} s…`);
    retryTimer = setTimeout(connect, delay);
  };
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

async function startCall(callId, caller) {
  endCall();
  active = { callId, caller, since: Date.now() };
  updateRinging(rings);
  $('active').hidden = false;
  $('activeCaller').textContent = caller;
  tick();
  try {
    const stream = await navigator.mediaDevices.getUserMedia(MIC_CONSTRAINTS);
    const ctx = new AudioContext();
    await ctx.resume();
    const src = ctx.createMediaStreamSource(stream);
    const lowpass = new BiquadFilterNode(ctx, { type: 'lowpass', frequency: 7000 });
    const tap = ctx.createScriptProcessor(1024, 1, 1);
    const toPcm = downsampler(ctx.sampleRate, (pcm) => { if (!muted && ws?.readyState === WebSocket.OPEN) ws.send(pcm); });
    tap.onaudioprocess = (e) => toPcm(e.inputBuffer.getChannelData(0));
    src.connect(lowpass).connect(tap).connect(new GainNode(ctx, { gain: 0 })).connect(ctx.destination);
    audio = { ctx, stream, nextTime: 0 };
    setStatus(`Talking to ${caller}.`);
  } catch (err) {
    setStatus(`${micProblem(err)} You can still listen.`);
    const ctx = new AudioContext();
    await ctx.resume();
    audio = { ctx, stream: null, nextTime: 0 };
  }
}

function endCall(message) {
  if (audio) {
    audio.stream?.getTracks().forEach(t => t.stop());
    audio.ctx.close();
    audio = null;
  }
  const wasActive = !!active;
  active = null;
  clearTimeout(clock);
  $('active').hidden = true;
  if (wasActive) updateRinging(rings);
  if (message) setStatus(message);
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
  if (audio.nextTime > now + MAX_AHEAD_S) return;
  const src = new AudioBufferSourceNode(ctx, { buffer: buf });
  src.connect(ctx.destination);
  src.start(audio.nextTime);
  audio.nextTime += buf.duration;
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
$('mute').addEventListener('click', () => {
  muted = !muted;
  $('mute').setAttribute('aria-pressed', muted);
  $('mute').textContent = muted ? 'Unmute' : 'Mute';
});
$('release').addEventListener('click', () => ws.send(JSON.stringify({ type: 'release' })));
$('handBack').addEventListener('click', () => {
  if (active) ws.send(JSON.stringify({ type: 'stop', callId: active.callId }));
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
