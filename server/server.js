// Audio bridge server for the Teams Call Answerer extension.
//
//   /call      The extension connects here after a Teams call is answered and streams it:
//              binary PCM s16le, mono, 16 kHz, 20 ms frames, both directions.
//   /operator  The browser console in public/ connects here. A signed-in operator can take a
//              live call: they hear the caller and their microphone goes to the caller.
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
const CALL_TOKEN = process.env.BRIDGE_TOKEN || '';
const OPERATOR_TOKEN = process.env.OPERATOR_TOKEN || CALL_TOKEN;
const FALLBACK = process.env.FALLBACK === 'echo' ? 'echo' : 'silence';
const HELLO_TIMEOUT_MS = 5000;
const RESUME_GRACE_MS = 15000;   // a call whose extension reconnects within this keeps its operator
const FORMAT = { encoding: 'pcm_s16le', sampleRate: 16000, channels: 1 };
const PUBLIC_DIR = path.join(__dirname, 'public');
const STATIC = { '/': 'index.html', '/console.js': 'console.js', '/console.css': 'console.css' };
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' };

const CLOSE = { unauthorized: 4001, badHello: 4002, replaced: 4003 };

if (CALL_TOKEN.length < 16) {
  console.error('Set BRIDGE_TOKEN to a random secret of at least 16 characters, e.g.\n  BRIDGE_TOKEN=$(node -e "console.log(crypto.randomBytes(24).toString(\'base64url\'))") npm start');
  process.exit(1);
}

const log = (...args) => console.log(new Date().toISOString(), ...args);

function tokenMatches(given, expected) {
  const a = crypto.createHash('sha256').update(String(given ?? '')).digest();
  const b = crypto.createHash('sha256').update(expected).digest();
  return crypto.timingSafeEqual(a, b);
}

const sendJson = (ws, msg) => { if (ws?.readyState === ws.OPEN) ws.send(JSON.stringify(msg)); };

// ---- State -------------------------------------------------------------------------------

/** callId -> { id, caller, ws, operator, startedAt, endTimer } */
const calls = new Map();
const operators = new Set();

function callList() {
  return [...calls.values()].map(c => ({
    id: c.id, caller: c.caller, startedAt: c.startedAt, connected: !!c.ws, taken: !!c.operator,
  }));
}

function broadcastCalls() {
  const msg = { type: 'calls', calls: callList() };
  for (const op of operators) sendJson(op, { ...msg, mine: op.callId || null });
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
      if (!tokenMatches(msg.token, CALL_TOKEN)) return ws.close(CLOSE.unauthorized, 'unauthorized');
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
        log(`call ${id.slice(0, 8)} started (${msg.client || 'unknown client'})`);
      }
      sendJson(ws, { type: 'ready', callId: id, format: FORMAT, handler: call.operator ? 'operator' : FALLBACK });
      broadcastCalls();
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
      if (msg.type !== 'hello' || !tokenMatches(msg.token, OPERATOR_TOKEN)) return ws.close(CLOSE.unauthorized, 'unauthorized');
      authed = true;
      operators.add(ws);
      sendJson(ws, { type: 'ready', format: FORMAT, fallback: FALLBACK });
      broadcastCalls();
      return;
    }

    const call = calls.get(msg.callId);
    switch (msg.type) {
      case 'take':
        if (!call) return sendJson(ws, { type: 'error', message: 'That call has ended.' });
        if (call.operator && call.operator !== ws) return sendJson(ws, { type: 'error', message: 'Another operator has that call.' });
        release('took another call');
        call.operator = ws;
        ws.callId = call.id;
        sendJson(ws, { type: 'taken', callId: call.id, caller: call.caller });
        break;
      case 'release':
        release('released');
        break;
      case 'stop': // hand the call back to the person at the Teams computer
        if (call) { sendJson(call.ws, { type: 'stop', reason: 'An operator handed the call back.' }); endCall(call, 'operator handed it back'); }
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

// ---- HTTP + WebSocket upgrade ------------------------------------------------------------

const server = http.createServer((req, res) => {
  const { pathname } = new URL(req.url, 'http://localhost');
  if (pathname === '/healthz') {
    res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ ok: true, calls: calls.size }));
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

const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });
const ROUTES = { '/call': onCallSocket, '/operator': onOperatorSocket };

server.on('upgrade', (req, socket, head) => {
  const route = ROUTES[new URL(req.url, 'http://localhost').pathname];
  if (!route) { socket.destroy(); return; }
  wss.handleUpgrade(req, socket, head, (ws) => {
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

server.listen(PORT, () => log(`bridge server on :${PORT} (fallback: ${FALLBACK})`));

function shutdown() {
  clearInterval(heartbeat);
  for (const ws of wss.clients) ws.close(1001, 'server shutting down');
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref();
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

module.exports = { server };
