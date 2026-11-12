// Audio bridge server for the Teams Call Answerer extension.
//
//   /station   The extension's always-on link: it reports which Teams calls are ringing and
//              carries out Answer/Decline pressed in the local app.
//   /call      The extension connects here after a Teams call is answered and streams it:
//              binary PCM s16le, mono, 16 kHz, 20 ms frames, both directions.
//   /operator  The local app (public/, installable) connects here. It shows ringing calls; Answer
//              makes the extension answer in Teams and routes that call's audio to this operator,
//              who hears the caller and whose microphone goes to the caller. On a call, "Take full
//              control" additionally offers a WebRTC video connection (signaled through /call and
//              /operator as video-offer/-answer/-ice/-stop, relayed as-is below) carrying the
//              operator's camera into the Teams call; turn-server.js is its TURN relay.
//   /healthz   Liveness check for your hosting platform.
//
// A call nobody has taken is handled by FALLBACK: "silence" (default) or "echo" (the caller
// hears themselves; for testing). Audio is relayed in memory only and never written to disk.
// Run it behind TLS (wss://): call audio is private.
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');

const PORT = Number(process.env.PORT) || 8080;
const HOST = process.env.HOST || '0.0.0.0'; // 127.0.0.1 when a local HTTPS proxy (Caddy) is the only way in
const CALL_TOKEN = process.env.BRIDGE_TOKEN || '';
const OPERATOR_TOKEN = process.env.OPERATOR_TOKEN || CALL_TOKEN;
const FALLBACK = process.env.FALLBACK === 'echo' ? 'echo' : 'silence';
const TURN_PORT = Number(process.env.TURN_PORT) || 3478;
const TURN_USERNAME = 'call-bridge'; // must match turn-server.js
const HELLO_TIMEOUT_MS = 5000;
const RESUME_GRACE_MS = 15000;   // a call whose extension reconnects within this keeps its operator
const FORMAT = { encoding: 'pcm_s16le', sampleRate: 16000, channels: 1 };
const PUBLIC_DIR = path.join(__dirname, 'public');
const ANSWER_ROUTE_MS = 60000;   // after Answer in the local app, the call that connects within this goes to that operator
const STATIC = {
  '/': 'index.html', '/console.js': 'console.js', '/console.css': 'console.css',
  '/manifest.webmanifest': 'manifest.webmanifest', '/sw.js': 'sw.js', '/icon-192.png': 'icon-192.png', '/icon-512.png': 'icon-512.png',
};
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.webmanifest': 'application/manifest+json', '.png': 'image/png',
};

const CLOSE = { unauthorized: 4001, badHello: 4002, replaced: 4003 };

if (CALL_TOKEN.length < 16) {
  console.error([
    'BRIDGE_TOKEN is not set (it must be a random secret of at least 16 characters).',
    'On the Windows VPS the server runs by itself as the "CallBridge Server" task: use start.bat to start it.',
    'To run it by hand: node --env-file=.env server.js   (or set BRIDGE_TOKEN and run npm start)',
  ].join('\n'));
  process.exit(1);
}

const log = (...args) => console.log(new Date().toISOString(), ...args);

function tokenMatches(given, expected) {
  const a = crypto.createHash('sha256').update(String(given ?? '')).digest();
  const b = crypto.createHash('sha256').update(expected).digest();
  return crypto.timingSafeEqual(a, b);
}

const sendJson = (ws, msg) => { if (ws?.readyState === ws.OPEN) ws.send(JSON.stringify(msg)); };

// The TURN relay (turn-server.js) runs on the same host, reachable at whatever hostname the client
// used to reach this server (ws.host, from the Host header) — same domain/IP, different port/protocol.
const iceServersFor = (ws) => [
  { urls: `stun:${ws.host}:${TURN_PORT}` },
  { urls: `turn:${ws.host}:${TURN_PORT}`, username: TURN_USERNAME, credential: CALL_TOKEN },
];

// ---- State -------------------------------------------------------------------------------

/** callId -> { id, caller, ws, operator, startedAt, endTimer, framesIn } */
const calls = new Map();
const operators = new Set();
const stations = new Set();
/** ringId -> { ringId, caller, station, since, answering } — Teams calls ringing right now */
const rings = new Map();
/** ringId -> operator who pressed Answer; the call that connects with this ringId goes to them */
const answeredBy = new Map();

function callList() {
  return [...calls.values()].map(c => ({
    id: c.id, caller: c.caller, startedAt: c.startedAt, connected: !!c.ws, taken: !!c.operator,
  }));
}

function ringList() {
  return [...rings.values()].map(r => ({ ringId: r.ringId, caller: r.caller, since: r.since, answering: !!r.answering }));
}

/** Tells every operator about live calls, ringing calls and how many Teams computers are linked. */
function broadcastCalls() {
  const msg = { type: 'calls', calls: callList(), rings: ringList(), stations: stations.size };
  for (const op of operators) sendJson(op, { ...msg, mine: op.callId || null });
}

/** Routes a call's audio to an operator, releasing whatever call they had before. */
function giveCallTo(call, op) {
  const previous = op.callId && calls.get(op.callId);
  if (previous && previous !== call && previous.operator === op) {
    previous.operator = null;
    sendJson(op, { type: 'released', callId: previous.id, reason: 'took another call' });
  }
  call.operator = op;
  op.callId = call.id;
  sendJson(op, { type: 'taken', callId: call.id, caller: call.caller, muted: !!call.muted });
}

function endCall(call, reason) {
  clearTimeout(call.endTimer);
  if (calls.get(call.id) !== call) return; // already ended (e.g. operator handed back, then the extension said goodbye)
  calls.delete(call.id);
  if (call.operator) {
    sendJson(call.operator, { type: 'released', callId: call.id, reason });
    call.operator.callId = null;
    call.operator = null;
  }
  const secs = Math.round((Date.now() - call.startedAt) / 1000);
  log(`call ${call.id.slice(0, 8)} ended after ${secs} s, ${call.framesIn} audio frames from the caller (${(call.framesIn / 50).toFixed(1)} s of audio): ${reason}`);
  broadcastCalls();
}

// ---- /call: the extension ----------------------------------------------------------------

function onCallSocket(ws) {
  let call = null;
  const helloTimer = setTimeout(() => ws.close(CLOSE.badHello, 'hello timeout'), HELLO_TIMEOUT_MS);

  ws.on('message', (data, isBinary) => {
    if (isBinary) {
      if (!call) return;
      call.framesIn++;
      if (call.operator) call.operator.send(data, { binary: true });
      else if (FALLBACK === 'echo') ws.send(data, { binary: true });
      return;
    }
    let msg;
    try { msg = JSON.parse(data); } catch { return; }

    if (msg.type === 'hello' && !call) {
      clearTimeout(helloTimer);
      if (!tokenMatches(msg.token, CALL_TOKEN)) return reject(ws);
      if (msg.format && (msg.format.sampleRate !== FORMAT.sampleRate || msg.format.encoding !== FORMAT.encoding)) {
        sendJson(ws, { type: 'error', message: `Unsupported audio format; this server expects ${JSON.stringify(FORMAT)}.` });
        return ws.close(CLOSE.badHello, 'format');
      }
      if (msg.test) {
        sendJson(ws, { type: 'ready', test: true });
        return ws.close(1000, 'test ok');
      }
      const id = typeof msg.callId === 'string' && /^[\w-]{8,64}$/.test(msg.callId) ? msg.callId : crypto.randomUUID();
      call = calls.get(id);
      if (call) {
        // The extension reconnected after a network blip: keep the session and its operator.
        clearTimeout(call.endTimer);
        if (call.ws && call.ws !== ws) call.ws.close(CLOSE.replaced, 'replaced');
        call.ws = ws;
        log(`call ${id.slice(0, 8)} resumed`);
      } else {
        call = { id, caller: String(msg.caller || 'Unknown caller').slice(0, 120), ws, operator: null, startedAt: Date.now(), endTimer: null, framesIn: 0 };
        calls.set(id, call);
        const op = answeredBy.get(msg.ringId);
        answeredBy.delete(msg.ringId);
        if (op && operators.has(op)) giveCallTo(call, op);
        log(`call ${id.slice(0, 8)} started (${msg.client || 'unknown client'})${op ? ', answered from the local app' : ''}`);
      }
      sendJson(ws, { type: 'ready', callId: id, format: FORMAT, handler: call.operator ? 'operator' : FALLBACK, iceServers: iceServersFor(ws) });
      broadcastCalls();
    } else if (msg.type === 'mute-state' && call) {
      // The Teams computer's mute state (Teams' own Mute button, or the app's request applied there).
      call.muted = !!msg.muted;
      if (call.operator) sendJson(call.operator, { type: 'mute-state', callId: call.id, muted: call.muted });
    } else if ((msg.type === 'video-answer' || msg.type === 'video-ice' || msg.type === 'video-stop') && call) {
      // Camera control signaling (see README.md "Camera control"): the extension is the answerer,
      // the operator app is the offerer. Just relay; the server never looks inside the SDP.
      if (call.operator) sendJson(call.operator, msg);
    } else if (msg.type === 'end' && call) {
      endCall(call, msg.reason || 'extension ended the call');
      call = null;
      ws.close(1000);
    }
  });

  ws.on('close', () => {
    clearTimeout(helloTimer);
    if (!call || call.ws !== ws || !calls.has(call.id)) return;
    call.ws = null;
    const c = call;
    c.endTimer = setTimeout(() => endCall(c, 'extension disconnected'), RESUME_GRACE_MS);
    broadcastCalls();
  });
}

// ---- /operator: the browser console ------------------------------------------------------

function onOperatorSocket(ws) {
  let authed = false;
  ws.callId = null;
  const helloTimer = setTimeout(() => ws.close(CLOSE.badHello, 'hello timeout'), HELLO_TIMEOUT_MS);
  const myCall = () => (ws.callId ? calls.get(ws.callId) : null);

  function release(reason) {
    const call = myCall();
    if (call && call.operator === ws) call.operator = null;
    ws.callId = null;
    if (call) sendJson(ws, { type: 'released', callId: call.id, reason });
  }

  ws.on('message', (data, isBinary) => {
    if (isBinary) {
      const call = myCall();
      if (authed && call?.operator === ws && call.ws) call.ws.send(data, { binary: true });
      return;
    }
    let msg;
    try { msg = JSON.parse(data); } catch { return; }

    if (!authed) {
      clearTimeout(helloTimer);
      if (msg.type !== 'hello' || !tokenMatches(msg.token, OPERATOR_TOKEN)) return reject(ws);
      authed = true;
      operators.add(ws);
      sendJson(ws, { type: 'ready', format: FORMAT, fallback: FALLBACK, iceServers: iceServersFor(ws) });
      broadcastCalls();
      return;
    }

    const call = calls.get(msg.callId);
    switch (msg.type) {
      case 'take':
        if (!call) return sendJson(ws, { type: 'error', message: 'That call has ended.' });
        if (call.operator && call.operator !== ws) return sendJson(ws, { type: 'error', message: 'Another operator has that call.' });
        giveCallTo(call, ws);
        break;
      case 'answer':
      case 'decline': {
        const ring = rings.get(msg.ringId);
        if (!ring) return sendJson(ws, { type: 'error', message: 'That call is no longer ringing.' });
        if (msg.type === 'answer') {
          if (ring.answering && ring.answering !== ws) return sendJson(ws, { type: 'error', message: 'Another operator is answering that call.' });
          ring.answering = ws;
          answeredBy.set(ring.ringId, ws);
          setTimeout(() => { if (answeredBy.get(ring.ringId) === ws) answeredBy.delete(ring.ringId); }, ANSWER_ROUTE_MS);
        }
        sendJson(ring.station, { type: msg.type, ringId: ring.ringId, mode: 'audio' });
        log(`ring ${ring.ringId.slice(0, 8)}: operator pressed ${msg.type}`);
        break;
      }
      case 'mute': { // the app's Mute button: mute (or unmute) on the Teams computer too
        const mine = myCall();
        if (mine?.operator === ws) sendJson(mine.ws, { type: 'mute', muted: !!msg.muted });
        break;
      }
      case 'release':
        release('released');
        break;
      case 'stop': // hand the call back to the person at the Teams computer
        if (call) { sendJson(call.ws, { type: 'stop', reason: 'An operator handed the call back.' }); endCall(call, 'operator handed it back'); }
        break;
      case 'video-offer':
      case 'video-ice':
      case 'video-stop': // camera control signaling: the operator is the offerer, relay to the extension
        if (call?.operator === ws) sendJson(call.ws, msg);
        break;
    }
    broadcastCalls();
  });

  ws.on('close', () => {
    clearTimeout(helloTimer);
    release('disconnected');
    operators.delete(ws);
    broadcastCalls();
  });
}

// ---- /station: the extension's always-on link ---------------------------------------------

function onStationSocket(ws) {
  let authed = false;
  const helloTimer = setTimeout(() => ws.close(CLOSE.badHello, 'hello timeout'), HELLO_TIMEOUT_MS);
  const validId = (id) => typeof id === 'string' && /^[\w-]{8,64}$/.test(id);

  ws.on('message', (data, isBinary) => {
    if (isBinary) return;
    let msg;
    try { msg = JSON.parse(data); } catch { return; }

    if (!authed) {
      clearTimeout(helloTimer);
      if (msg.type !== 'hello' || !tokenMatches(msg.token, CALL_TOKEN)) return reject(ws);
      authed = true;
      stations.add(ws);
      sendJson(ws, { type: 'ready' });
      log(`Teams computer linked from ${ws.remote} (${msg.client || 'unknown client'}); ${stations.size} linked`);
      broadcastCalls();
      return;
    }

    switch (msg.type) {
      case 'ping':
        sendJson(ws, { type: 'pong' });
        return;
      case 'ringing':
        if (!validId(msg.ringId) || rings.has(msg.ringId)) return;
        rings.set(msg.ringId, { ringId: msg.ringId, caller: String(msg.caller || 'Unknown caller').slice(0, 120), station: ws, since: Date.now(), answering: null });
        log(`ring ${msg.ringId.slice(0, 8)} from ${rings.get(msg.ringId).caller}`);
        break;
      case 'ring-ended':
        if (!rings.delete(msg.ringId)) return;
        break;
      case 'answer-result': {
        const op = answeredBy.get(msg.ringId);
        if (!msg.ok) {
          answeredBy.delete(msg.ringId);
          const ring = rings.get(msg.ringId);
          if (ring) ring.answering = null;
          if (op) sendJson(op, { type: 'error', message: `Could not answer: ${msg.message || 'unknown reason'}` });
        }
        break;
      }
      default:
        return;
    }
    broadcastCalls();
  });

  ws.on('close', () => {
    clearTimeout(helloTimer);
    if (!stations.delete(ws)) return;
    for (const [id, r] of rings) if (r.station === ws) rings.delete(id);
    log(`Teams computer unlinked (${ws.remote}); ${stations.size} linked`);
    broadcastCalls();
  });
}

// ---- HTTP + WebSocket upgrade ------------------------------------------------------------

/** Path of a request, or null for junk that URL() can't parse (scanners send things like "//"). */
function pathOf(rawUrl) {
  try { return new URL(rawUrl, 'http://localhost').pathname; } catch { return null; }
}

const server = http.createServer((req, res) => {
  const pathname = pathOf(req.url);
  if (pathname === null) { res.writeHead(400).end('bad request'); return; }
  if (pathname === '/healthz') {
    const health = { ok: true, uptimeSec: Math.round(process.uptime()), calls: calls.size, ringing: rings.size, teamsComputers: stations.size, apps: operators.size };
    res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(health));
    return;
  }
  const file = STATIC[pathname];
  if (!file || req.method !== 'GET') { res.writeHead(404).end('not found'); return; }
  fs.readFile(path.join(PUBLIC_DIR, file), (err, body) => {
    if (err) { res.writeHead(500).end(); return; }
    res.writeHead(200, {
      'Content-Type': TYPES[path.extname(file)],
      'Content-Security-Policy': "default-src 'self'; connect-src 'self'; media-src 'self' blob:",
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
      'Cache-Control': 'no-cache',
    }).end(body);
  });
});

// perMessageDeflate defaults to on in `ws`; compressing every 20 ms audio frame adds CPU work and
// jitter for no benefit (PCM doesn't compress well), which was contributing to choppy audio.
const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024, perMessageDeflate: false });
const ROUTES = { '/call': onCallSocket, '/operator': onOperatorSocket, '/station': onStationSocket };

const WHO = { '/call': 'extension call', '/operator': 'Call Bridge app', '/station': 'Teams computer' };

/** Closes a sign-in with a wrong token, and logs it so a misconfigured computer shows up in the log. */
function reject(ws) {
  log(`rejected ${ws.who} sign-in from ${ws.remote}: wrong token`);
  ws.close(CLOSE.unauthorized, 'unauthorized');
}

server.on('upgrade', (req, socket, head) => {
  const pathname = pathOf(req.url);
  const route = ROUTES[pathname];
  if (!route) { socket.destroy(); return; }
  wss.handleUpgrade(req, socket, head, (ws) => {
    ws.who = WHO[pathname];
    // Behind Caddy the peer is 127.0.0.1; the real address is in X-Forwarded-For.
    ws.remote = String(req.headers['x-forwarded-for'] || req.socket.remoteAddress).split(',')[0].trim();
    ws.host = String(req.headers.host || '').split(':')[0]; // for iceServersFor(): same domain the client used to reach us
    ws.isAlive = true;
    ws.on('pong', () => { ws.isAlive = true; });
    ws.on('error', (err) => log('socket error:', err.message));
    route(ws);
  });
});

// Proxies and load balancers drop idle connections; ping keeps them open and reaps dead ones.
const heartbeat = setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) { ws.terminate(); continue; }
    ws.isAlive = false;
    ws.ping();
  }
}, 20000);

server.on('error', (err) => {
  if (err.code !== 'EADDRINUSE') throw err;
  console.error(`Port ${PORT} is already in use: the bridge server is probably already running (on the VPS, as the "CallBridge Server" task).`);
  process.exit(1);
});
server.listen(PORT, HOST, () => log(`bridge server on ${HOST}:${PORT} (fallback: ${FALLBACK})`));

function shutdown() {
  clearInterval(heartbeat);
  for (const ws of wss.clients) ws.close(1001, 'server shutting down');
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref();
}
// Last resort: one bad request or a bug in one handler must not take every call and app offline.
// Log it and keep serving; the error still shows up in logs\server.log (and monitor.bat).
process.on('uncaughtException', (err) => log('unexpected error (server kept running):', err.stack || err));
process.on('unhandledRejection', (err) => log('unexpected rejection (server kept running):', err?.stack || err));
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

module.exports = { server };
