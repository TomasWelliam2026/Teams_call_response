// The extension's offscreen page: holds the capture of the Teams tab's sound (everything the tab plays:
// callers, ringtones, notifications) and sends it to the server's /tab-sound all the time, in the
// call bridge's format (PCM s16le, mono, 16 kHz, 20 ms frames). background.js starts it with a stream
// id from chrome.tabCapture and hands on the server settings; this page reports its state back.
//   background -> here  {target:'offscreen', type:'tab-sound-start', streamId, tabId, serverUrl, token}
//                       | {target:'offscreen', type:'tab-sound-config', serverUrl, token} | {target:'offscreen', type:'tab-sound-stop'}
//   here -> background  {type:'tab-sound-status', state: 'connecting'|'sending'|'stopped', reason, tabId}
// Nothing is held back: this is live sound, so frames that can't leave right away are skipped.
const { FORMAT, CLIENT, endpoint, checkServerUrl } = globalThis.TeamsCallBridge;
const RATE = 16000;
const FRAME = 320;                 // 20 ms at 16 kHz
const MAX_BUFFERED = 64 * 1024;    // ~2 s not leaving: skip frames instead of falling behind
const CLOSE_UNAUTHORIZED = 4001;

let capture = null; // { stream, player, reader, tabId }
let cfg = { serverUrl: '', token: '' };
let ws = null;
let ready = false;
let retry = 0;
let retryTimer = null;
let lastState = '';

function report(state, reason = '') {
  if (state === lastState && !reason) return;
  lastState = state;
  chrome.runtime.sendMessage({ type: 'tab-sound-status', state, reason, tabId: capture?.tabId ?? null }).catch(() => {});
}

// ---- Capture ------------------------------------------------------------------------------------

async function start(streamId, tabId) {
  stopCapture();
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: { mandatory: { chromeMediaSource: 'tab', chromeMediaSourceId: streamId } },
      video: false,
    });
  } catch (err) {
    report('stopped', `Chrome didn't hand over the Teams tab's sound: ${err.name}: ${err.message}`);
    return;
  }
  const track = stream.getAudioTracks()[0];
  // Capturing a tab takes its sound away from the speakers: play it here so the Teams computer still hears Teams.
  const player = new Audio();
  player.srcObject = stream;
  player.play().catch(() => {});
  capture = { stream, player, tabId, reader: new MediaStreamTrackProcessor({ track }).readable.getReader() };
  track.addEventListener('ended', () => {
    stopCapture();
    report('stopped', 'The Teams tab was closed, or Chrome stopped sharing its sound.');
  }, { once: true });
  read(capture);
  connect();
}

function stopCapture() {
  if (!capture) return;
  const c = capture;
  capture = null;
  c.reader.cancel().catch(() => {});
  c.player.srcObject = null;
  c.stream.getTracks().forEach(t => t.stop());
  disconnect();
}

async function read(c) {
  const send = framer((frame) => {
    if (ready && ws.readyState === WebSocket.OPEN && ws.bufferedAmount < MAX_BUFFERED) ws.send(frame);
  });
  let rate = 0;
  let resample = null;
  let filters = [];
  for (;;) {
    let chunk;
    try { chunk = await c.reader.read(); } catch { break; }
    if (chunk.done) break;
    const data = chunk.value;
    try {
      if (data.sampleRate !== rate) {
        rate = data.sampleRate;
        resample = resampler(rate);
        filters = [lowpass(rate, 7000), lowpass(rate, 7000)];
      }
      const n = data.numberOfFrames;
      const mono = new Float32Array(n);
      const plane = new Float32Array(n);
      for (let ch = 0; ch < data.numberOfChannels; ch++) {
        data.copyTo(plane, { planeIndex: ch, format: 'f32-planar' });
        for (let i = 0; i < n; i++) mono[i] += plane[i] / data.numberOfChannels;
      }
      for (const f of filters) f(mono);
      send(resample(mono));
    } finally {
      data.close();
    }
  }
}

// ---- Connection ---------------------------------------------------------------------------------

function connect() {
  disconnect();
  if (!capture) return;
  const problem = checkServerUrl(cfg.serverUrl) || (!cfg.token && 'No access token is set.');
  if (problem) { report('stopped', problem); return; }
  report('connecting');
  const socket = ws = new WebSocket(endpoint(cfg.serverUrl, '/tab-sound'));
  socket.binaryType = 'arraybuffer';
  socket.onopen = () => socket.send(JSON.stringify({ type: 'hello', token: cfg.token, client: CLIENT, format: FORMAT }));
  socket.onmessage = (e) => {
    if (typeof e.data !== 'string') return;
    let msg;
    try { msg = JSON.parse(e.data); } catch { return; }
    if (msg.type === 'ready') { ready = true; retry = 0; report('sending'); }
    else if (msg.type === 'error') report('connecting', msg.message);
  };
  socket.onclose = (e) => {
    if (ws !== socket) return;
    ready = false;
    ws = null;
    if (!capture) return;
    const rejected = e.code === CLOSE_UNAUTHORIZED;
    report('connecting', rejected ? 'The server rejected the access token.' : `Connection closed (code ${e.code}); reconnecting.`);
    retryTimer = setTimeout(connect, rejected ? 60000 : Math.min(30000, 1000 * 2 ** retry++));
  };
}

function disconnect() {
  clearTimeout(retryTimer);
  ready = false;
  if (ws) { const old = ws; ws = null; try { old.close(1000); } catch { /* closing */ } }
}

chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.target !== 'offscreen') return;
  if (msg.type === 'tab-sound-start') {
    cfg = { serverUrl: msg.serverUrl, token: msg.token };
    start(msg.streamId, msg.tabId);
  } else if (msg.type === 'tab-sound-config') {
    const changed = msg.serverUrl !== cfg.serverUrl || msg.token !== cfg.token;
    cfg = { serverUrl: msg.serverUrl, token: msg.token };
    if (changed && capture) { retry = 0; connect(); }
  } else if (msg.type === 'tab-sound-stop') {
    stopCapture();
    report('stopped', 'Stopped.');
  }
});

// ---- Sound conversion (as page-audio.js does for call audio) --------------------------------------

/** Second-order low-pass filter, applied in place. */
function lowpass(fs, f0) {
  const w = 2 * Math.PI * f0 / fs;
  const alpha = Math.sin(w) / (2 * Math.SQRT1_2);
  const cos = Math.cos(w);
  const a0 = 1 + alpha;
  const b0 = (1 - cos) / 2 / a0, b1 = (1 - cos) / a0, b2 = b0, a1 = -2 * cos / a0, a2 = (1 - alpha) / a0;
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  return (x) => {
    for (let i = 0; i < x.length; i++) {
      const y = b0 * x[i] + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
      x2 = x1; x1 = x[i]; y2 = y1; y1 = y;
      x[i] = y;
    }
  };
}

/** Float32 at `fromRate` -> Float32 at 16 kHz (linear interpolation; input is already low-passed). */
function resampler(fromRate) {
  const step = fromRate / RATE;
  let pos = 0;
  let last = 0;
  return (input) => {
    const out = [];
    while (pos < input.length - 1) {
      const i = Math.floor(pos);
      const a = i < 0 ? last : input[i];
      out.push(a + (input[i + 1] - a) * (pos - i));
      pos += step;
    }
    pos -= input.length;
    last = input[input.length - 1];
    return out;
  };
}

/** Collects 16 kHz float samples into 20 ms Int16 frames. */
function framer(emit) {
  let frame = new Int16Array(FRAME);
  let filled = 0;
  return (samples) => {
    for (const v of samples) {
      const s = Math.max(-1, Math.min(1, v));
      frame[filled++] = s < 0 ? s * 0x8000 : s * 0x7fff;
      if (filled === FRAME) { emit(frame.buffer); frame = new Int16Array(FRAME); filled = 0; }
    }
  };
}
