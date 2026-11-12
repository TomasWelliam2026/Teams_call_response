// End-to-end check of the server, plus the extension's real bridge.js talking to it.
// Run: npm test   (starts the server on a random port with a throwaway token)
const { spawn } = require('child_process');
const path = require('path');
const assert = require('assert');
const WebSocket = require('ws');

const TOKEN = 'test-token-0123456789abcdef';
const PORT = 20000 + Math.floor(Math.random() * 20000);
const BASE = `ws://127.0.0.1:${PORT}`;

const wait = (ms) => new Promise(r => setTimeout(r, ms));

function open(route) {
  const ws = new WebSocket(`${BASE}${route}`);
  const inbox = [];
  const waiters = [];
  ws.on('message', (data, isBinary) => {
    const item = isBinary ? { binary: Buffer.from(data) } : JSON.parse(data);
    const i = waiters.findIndex(w => w.match(item));
    if (i >= 0) waiters.splice(i, 1)[0].resolve(item); else inbox.push(item);
  });
  ws.next = (match = () => true, ms = 2000) => {
    const i = inbox.findIndex(match);
    if (i >= 0) return Promise.resolve(inbox.splice(i, 1)[0]);
    return new Promise((resolve, reject) => {
      const w = { match, resolve };
      waiters.push(w);
      setTimeout(() => { const k = waiters.indexOf(w); if (k >= 0) { waiters.splice(k, 1); reject(new Error(`timeout waiting on ${route}`)); } }, ms);
    });
  };
  ws.closed = new Promise(r => ws.on('close', (code) => r(code)));
  return new Promise((resolve, reject) => { ws.on('open', () => resolve(ws)); ws.on('error', reject); });
}

const frame = (fill) => Buffer.alloc(640, fill);
const isType = (t) => (m) => m.type === t;
const isBinary = (m) => !!m.binary;

async function main() {
  const server = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    env: { ...process.env, PORT: String(PORT), BRIDGE_TOKEN: TOKEN, FALLBACK: 'echo' }, stdio: ['ignore', 'pipe', 'inherit'],
  });
  await new Promise((resolve) => server.stdout.on('data', (d) => { if (String(d).includes('bridge server')) resolve(); }));

  try {
    const health = await (await fetch(`http://127.0.0.1:${PORT}/healthz`)).json();
    assert.equal(health.ok, true);
    const page = await fetch(`http://127.0.0.1:${PORT}/`);
    assert.match(await page.text(), /<title>Call Bridge<\/title>/);
    console.log('ok  health check and console page');

    const bad = await open('/call');
    bad.send(JSON.stringify({ type: 'hello', token: 'wrong' }));
    assert.equal(await bad.closed, 4001);
    console.log('ok  wrong token is rejected (4001)');

    const test = await open('/call');
    test.send(JSON.stringify({ type: 'hello', token: TOKEN, test: true }));
    assert.equal((await test.next(isType('ready'))).test, true);
    console.log('ok  test hello');

    const call = await open('/call');
    call.send(JSON.stringify({ type: 'hello', token: TOKEN, callId: 'call-0001-abcd', caller: 'Jane Doe', format: { encoding: 'pcm_s16le', sampleRate: 16000, channels: 1 } }));
    assert.equal((await call.next(isType('ready'))).handler, 'echo');
    call.send(frame(7));
    assert.deepEqual((await call.next(isBinary)).binary, frame(7));
    console.log('ok  untaken call is echoed');

    const op = await open('/operator');
    op.send(JSON.stringify({ type: 'hello', token: TOKEN }));
    await op.next(isType('ready'));
    const list = await op.next(m => m.type === 'calls' && m.calls.length === 1);
    assert.equal(list.calls[0].caller, 'Jane Doe');
    op.send(JSON.stringify({ type: 'take', callId: 'call-0001-abcd' }));
    await op.next(isType('taken'));
    call.send(frame(1));
    assert.deepEqual((await op.next(isBinary)).binary, frame(1));
    op.send(frame(2));
    assert.deepEqual((await call.next(isBinary)).binary, frame(2));
    console.log('ok  operator hears the caller and talks back');

    op.send(JSON.stringify({ type: 'stop', callId: 'call-0001-abcd' }));
    assert.equal((await call.next(isType('stop'))).type, 'stop');
    await op.next(isType('released'));
    console.log('ok  operator can hand the call back');
    call.close();
    op.close();

    // The extension's own bridge.js (Node has a global WebSocket, btoa and atob).
    require(path.join(__dirname, '..', '..', 'teams-auto-answer', 'bridge.js'));
    const Bridge = globalThis.TeamsCallBridge;
    assert.ok(Bridge.checkServerUrl('ws://example.com/call'));
    assert.equal(Bridge.checkServerUrl('wss://example.com/call'), null);
    assert.equal((await Bridge.testServer({ serverUrl: `${BASE}/call`, token: TOKEN })).ok, true);
    assert.equal((await Bridge.testServer({ serverUrl: `${BASE}/call`, token: 'nope' })).ok, false);

    const fromBridge = [];
    const statuses = [];
    const listeners = { message: [], disconnect: [] };
    const port = {
      postMessage: (m) => fromBridge.push(m),
      disconnect() {},
      onMessage: { addListener: (fn) => listeners.message.push(fn) },
      onDisconnect: { addListener: (fn) => listeners.disconnect.push(fn) },
    };
    Bridge.serveBridgePort(port, {
      getConfig: async () => ({ serverUrl: `${BASE}/call`, token: TOKEN }),
      onStatus: (s) => statuses.push(s.state),
    });
    const toBridge = (m) => listeners.message.forEach(fn => fn(m));
    toBridge({ type: 'start', callId: 'call-0002-abcd', caller: 'Bob Smith' });
    for (let i = 0; i < 50 && !statuses.includes('live'); i++) await wait(20);
    assert.deepEqual(statuses, ['connecting', 'live']);
    toBridge({ type: 'audio', data: Bridge.toBase64(new Int16Array(320).fill(1234).buffer) });
    for (let i = 0; i < 50 && !fromBridge.some(isType('audio')); i++) await wait(20);
    const echoed = new Int16Array(Bridge.fromBase64(fromBridge.find(isType('audio')).data));
    assert.equal(echoed.length, 320);
    assert.equal(echoed[100], 1234);
    toBridge({ type: 'stop', reason: 'test done' });
    assert.equal(statuses.at(-1), 'ended');
    console.log('ok  extension bridge.js: test, connect, audio round trip, stop');

    // Remote answer: the extension's station link (real createStation) reports a ring, the local
    // app answers, and the call that connects with that ringId goes straight to that operator.
    const badStation = await open('/station');
    badStation.send(JSON.stringify({ type: 'hello', role: 'station', token: 'wrong' }));
    assert.equal(await badStation.closed, 4001);

    const commands = [];
    const stationStates = [];
    const station = Bridge.createStation({
      getConfig: async () => ({ serverUrl: `${BASE}/call`, token: TOKEN, enabled: true }),
      onCommand: (cmd) => commands.push(cmd),
      onStatus: (s) => stationStates.push(s.state),
    });
    await station.ensure();
    for (let i = 0; i < 50 && !station.connected; i++) await wait(20);
    assert.ok(station.connected, 'station connects');

    const app = await open('/operator');
    app.send(JSON.stringify({ type: 'hello', token: TOKEN }));
    await app.next(isType('ready'));
    assert.equal((await app.next(m => m.type === 'calls' && m.stations === 1)).stations, 1);

    station.send({ type: 'ringing', ringId: 'ring-0001-abcd', caller: 'Eric Lee' });
    const ringing = await app.next(m => m.type === 'calls' && m.rings.length === 1);
    assert.equal(ringing.rings[0].caller, 'Eric Lee');
    app.send(JSON.stringify({ type: 'answer', ringId: 'ring-0001-abcd' }));
    for (let i = 0; i < 50 && !commands.length; i++) await wait(20);
    assert.deepEqual(commands[0], { type: 'answer', ringId: 'ring-0001-abcd', mode: 'audio' });
    station.send({ type: 'answer-result', ringId: 'ring-0001-abcd', ok: true });
    station.send({ type: 'ring-ended', ringId: 'ring-0001-abcd' });
    await app.next(m => m.type === 'calls' && m.rings.length === 0);

    const answered = await open('/call');
    answered.send(JSON.stringify({ type: 'hello', token: TOKEN, callId: 'call-0003-abcd', ringId: 'ring-0001-abcd', caller: 'Eric Lee' }));
    assert.equal((await app.next(isType('taken'))).callId, 'call-0003-abcd');
    answered.send(frame(5));
    assert.deepEqual((await app.next(isBinary)).binary, frame(5));
    app.send(frame(6));
    assert.deepEqual((await answered.next(isBinary)).binary, frame(6));
    console.log('ok  remote answer: ring shown, Answer reaches the extension, call routed to that operator');

    // Shared mute: the app's Mute reaches the extension; the Teams computer's state reaches the app.
    app.send(JSON.stringify({ type: 'mute', muted: true }));
    assert.deepEqual(await answered.next(isType('mute')), { type: 'mute', muted: true });
    answered.send(JSON.stringify({ type: 'mute-state', muted: true }));
    assert.equal((await app.next(isType('mute-state'))).muted, true);
    answered.send(JSON.stringify({ type: 'mute-state', muted: false })); // someone unmuted in Teams
    assert.equal((await app.next(isType('mute-state'))).muted, false);
    console.log('ok  mute is shared between the app and the Teams computer');

    // Camera control: video-offer/-ice/-stop from the operator reach the extension, and
    // video-answer/-ice back reach the operator. The server only relays; no real SDP needed here.
    app.send(JSON.stringify({ type: 'video-offer', callId: 'call-0003-abcd', sdp: 'fake-offer' }));
    assert.equal((await answered.next(isType('video-offer'))).sdp, 'fake-offer');
    answered.send(JSON.stringify({ type: 'video-answer', sdp: 'fake-answer' }));
    assert.equal((await app.next(isType('video-answer'))).sdp, 'fake-answer');
    app.send(JSON.stringify({ type: 'video-ice', callId: 'call-0003-abcd', candidate: { candidate: 'fake' } }));
    assert.deepEqual((await answered.next(isType('video-ice'))).candidate, { candidate: 'fake' });
    answered.send(JSON.stringify({ type: 'video-stop' }));
    await app.next(isType('video-stop'));
    console.log('ok  camera-control signaling is relayed between the operator and the extension');

    station.send({ type: 'ringing', ringId: 'ring-0002-abcd', caller: 'Jane Doe' });
    await app.next(m => m.type === 'calls' && m.rings.length === 1);
    app.send(JSON.stringify({ type: 'answer', ringId: 'ring-0002-abcd' }));
    for (let i = 0; i < 50 && commands.length < 2; i++) await wait(20);
    station.send({ type: 'answer-result', ringId: 'ring-0002-abcd', ok: false, message: 'Teams has no button for that.' });
    assert.match((await app.next(isType('error'))).message, /Could not answer: Teams has no button/);
    station.close();
    await app.next(m => m.type === 'calls' && m.stations === 0 && m.rings.length === 0);
    console.log('ok  failed answer is reported; unlinking clears its rings');
    answered.close();
    app.close();
  } finally {
    server.kill();
  }
}

main().then(() => { console.log('\nall smoke tests passed'); process.exit(0); }, (err) => { console.error('FAIL', err); process.exit(1); });
