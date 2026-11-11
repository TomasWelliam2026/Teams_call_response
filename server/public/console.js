// Operator console: lists live bridged calls, and for the call you take, plays the caller's
// audio and streams your microphone back (PCM s16le, mono, 16 kHz, 20 ms frames).
const RATE = 16000;
const FRAME = 320;
const START_BUFFER_S = 0.08;
const MAX_AHEAD_S = 0.6;

const $ = (id) => document.getElementById(id);
let ws = null;
let audio = null;   // { ctx, stream, nextTime } while on a call
let active = null;  // { callId, caller, since }
let muted = false;
let clock = null;

function setStatus(text) { $('status').textContent = text; }

function connect(token) {
  ws?.close();
  ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/operator`);
  ws.binaryType = 'arraybuffer';
  setStatus('Connecting…');
  ws.onopen = () => ws.send(JSON.stringify({ type: 'hello', token }));
  ws.onmessage = (e) => {
    if (typeof e.data !== 'string') { play(e.data); return; }
    const msg = JSON.parse(e.data);
    switch (msg.type) {
      case 'ready':
        setStatus(`Connected. Calls nobody takes get: ${msg.fallback}.`);
        $('login').hidden = true;
        $('callsSection').hidden = false;
        break;
      case 'calls': renderCalls(msg.calls, msg.mine); break;
      case 'taken': startCall(msg.callId, msg.caller); break;
      case 'released': endCall(`Call released: ${msg.reason.replace(/\.$/, '')}.`); break;
      case 'error': setStatus(msg.message); break;
    }
  };
  ws.onclose = (e) => {
    endCall();
    $('login').hidden = false;
    $('callsSection').hidden = true;
    setStatus(e.code === 4001 ? 'Wrong operator token.' : 'Disconnected.');
  };
}

function renderCalls(calls, mine) {
  const list = $('calls');
  if (!calls.length) {
    const li = document.createElement('li');
    li.className = 'muted';
    li.textContent = 'No live calls.';
    list.replaceChildren(li);
    return;
  }
  list.replaceChildren(...calls.map((c) => {
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

async function startCall(callId, caller) {
  endCall();
  active = { callId, caller, since: Date.now() };
  $('active').hidden = false;
  $('activeCaller').textContent = caller;
  tick();
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
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
    setStatus(`Microphone unavailable (${err.message}). You can still listen.`);
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
  active = null;
  clearTimeout(clock);
  $('active').hidden = true;
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

$('login').addEventListener('submit', (e) => {
  e.preventDefault();
  connect($('token').value);
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
