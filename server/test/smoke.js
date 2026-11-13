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

async function startServer() {
  const server = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    env: { ...process.env, PORT: String(PORT), BRIDGE_TOKEN: TOKEN, FALLBACK: 'echo' }, stdio: ['ignore', 'pipe', 'inherit'],
  });
  server.output = '';
  await new Promise((resolve) => server.stdout.on('data', (d) => { server.output += d; if (String(d).includes('bridge server')) resolve(); }));
  return server;
}

async function main() {
  let server = await startServer();

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

    // Every frame is numbered: a side whose connection died (even before the server noticed) says how
    // much it has when it's back, and gets exactly the rest, in order.
    const ext = await open('/call');
    ext.send(JSON.stringify({ type: 'hello', token: TOKEN, callId: 'call-0010-abcd', caller: 'Ann', have: 0, sent: 0 }));
    assert.equal((await ext.next(isType('ready'))).got, 0);
    let me = await open('/operator');
    me.send(JSON.stringify({ type: 'hello', token: TOKEN }));
    await me.next(isType('ready'));
    me.send(JSON.stringify({ type: 'take', callId: 'call-0010-abcd' }));
    assert.deepEqual(await me.next(isType('taken')), { type: 'taken', callId: 'call-0010-abcd', caller: 'Ann', muted: false, seq: 0, got: 0 });
    ext.send(frame(11));
    assert.deepEqual((await me.next(isBinary)).binary, frame(11));
    me.terminate(); // the app's network drops
    ext.send(frame(12));
    await wait(100);
    ext.send(frame(13));
    ext.send(frame(14));
    me = await open('/operator');
    me.send(JSON.stringify({ type: 'hello', token: TOKEN, resume: 'call-0010-abcd', have: 1 }));
    assert.equal((await me.next(isType('taken'))).seq, 1);
    for (const n of [12, 13, 14]) assert.deepEqual((await me.next(isBinary)).binary, frame(n));
    me.send(frame(21));
    assert.deepEqual((await ext.next(isBinary)).binary, frame(21));
    ext.terminate(); // the Teams computer's network drops
    me.send(frame(22));
    await wait(100);
    me.send(frame(23));
    const ext2 = await open('/call');
    ext2.send(JSON.stringify({ type: 'hello', token: TOKEN, callId: 'call-0010-abcd', caller: 'Ann', have: 1, sent: 4 }));
    assert.equal((await ext2.next(isType('ready'))).got, 4);
    for (const n of [22, 23]) assert.deepEqual((await ext2.next(isBinary)).binary, frame(n));
    console.log('ok  reconnects: each side gets exactly the audio it missed, in order');

    ext2.send(JSON.stringify({ type: 'end', reason: 'caller hung up' }));
    await me.next(isType('released'));
    const late = await open('/operator');
    late.send(JSON.stringify({ type: 'hello', token: TOKEN, resume: 'call-0010-abcd', have: 4 }));
    assert.equal((await late.next(isType('released'))).reason, 'caller hung up');
    late.close();
    me.close();
    console.log('ok  an app resuming a call that ended meanwhile is told it ended');

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
    assert.deepEqual(fromBridge.find(isType('resend')), { type: 'resend', from: 0 });
    toBridge({ type: 'audio', seq: 1, data: Bridge.toBase64(new Int16Array(320).fill(1234).buffer) });
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

    // End call: unlike "stop" (hand the bridge back), this tells the extension to actually hang up,
    // and ends the call on the server the same way the extension saying goodbye would.
    app.send(JSON.stringify({ type: 'end-call', callId: 'call-0003-abcd' }));
    assert.equal((await answered.next(isType('end-call'))).type, 'end-call');
    await app.next(isType('released'));
    await app.next(m => m.type === 'calls' && m.calls.length === 0);
    console.log('ok  end call reaches the extension and ends the call on the server');

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

    // Server restart mid-call: the extension (real bridge.js, fed like content.js feeds it: numbered
    // frames, sent again on 'resend') and the app both reconnect, the call carries on, and nothing
    // either side said while the server was down is lost.
    const toPage = [];
    const extListeners = { message: [], disconnect: [] };
    const kept = [];
    let posted = 0;
    const toExt = (m) => extListeners.message.forEach(fn => fn(m));
    const postKept = () => { for (const k of kept) if (k.seq > posted) { toExt({ type: 'audio', seq: k.seq, data: k.data }); posted = k.seq; } };
    const speak = (n) => { kept.push({ seq: kept.length + 1, data: Bridge.toBase64(new Uint8Array(frame(n)).buffer) }); postKept(); };
    Bridge.serveBridgePort({
      postMessage: (m) => { if (m.type === 'resend') { posted = m.from; postKept(); } else toPage.push(m); },
      disconnect() {},
      onMessage: { addListener: (fn) => extListeners.message.push(fn) },
      onDisconnect: { addListener: (fn) => extListeners.disconnect.push(fn) },
    }, { getConfig: async () => ({ serverUrl: `${BASE}/call`, token: TOKEN }) });
    toExt({ type: 'start', callId: 'call-0020-abcd', caller: 'Max' });
    let desk = await open('/operator');
    desk.send(JSON.stringify({ type: 'hello', token: TOKEN }));
    await desk.next(m => m.type === 'calls' && m.calls.some(c => c.id === 'call-0020-abcd'));
    desk.send(JSON.stringify({ type: 'take', callId: 'call-0020-abcd' }));
    await desk.next(isType('taken'));
    speak(41);
    assert.deepEqual((await desk.next(isBinary)).binary, frame(41));
    desk.send(frame(51));
    for (let i = 0; i < 50 && !toPage.some(isType('audio')); i++) await wait(20);
    assert.deepEqual(Buffer.from(Bridge.fromBase64(toPage.find(isType('audio')).data)), frame(51));

    server.kill();
    await wait(300);
    speak(42); // said while the server is down
    speak(43);
    server = await startServer();
    desk = await open('/operator');
    desk.send(JSON.stringify({ type: 'hello', token: TOKEN, resume: 'call-0020-abcd', have: 1 }));
    const back = await desk.next(isType('taken'), 6000);
    assert.equal(back.callId, 'call-0020-abcd');
    assert.equal(back.got, 1); // the app sends again everything after its first frame
    desk.send(frame(52));
    for (const n of [42, 43]) assert.deepEqual((await desk.next(isBinary)).binary, frame(n));
    for (let i = 0; i < 50 && toPage.filter(isType('audio')).length < 2; i++) await wait(20);
    assert.deepEqual(Buffer.from(Bridge.fromBase64(toPage.filter(isType('audio'))[1].data)), frame(52));
    assert.match(server.output, /call call-002 started .*picked up again by the app that had it/);
    console.log('ok  server restart mid-call: both sides reconnect, the call carries on, nothing is lost');

    // Restarted again, but this time the extension is back first and the app is missing a frame the
    // old server process had taken but never passed on: the extension sends it again.
    server.kill();
    await wait(300);
    speak(44);
    server = await startServer();
    for (let i = 0; i < 100 && !/call call-002 started/.test(server.output); i++) await wait(50);
    await wait(300);
    desk = await open('/operator');
    desk.send(JSON.stringify({ type: 'hello', token: TOKEN, resume: 'call-0020-abcd', have: 2 })); // never got frame 3 (43)
    assert.equal((await desk.next(isType('taken'), 6000)).seq, 2);
    for (const n of [43, 44]) assert.deepEqual((await desk.next(isBinary)).binary, frame(n));
    toExt({ type: 'stop', reason: 'test done' });
    await desk.next(isType('released'));
    await wait(50);
    assert.match(server.output, /call call-002 ended after \d+ s: caller -> app 4 frames .* app -> caller 2 frames .* nothing lost/);
    desk.close();
    console.log('ok  a frame lost with a restarted server is sent again by the extension');
  } finally {
    server.kill();
  }
}

main().then(() => { console.log('\nall smoke tests passed'); process.exit(0); }, (err) => { console.error('FAIL', err); process.exit(1); });
