// Shared by the background worker (via importScripts), content.js and the test shim.
// Owns the WebSocket to the audio server for one answered call. No chrome.* APIs here, so the
// mock page can run the exact same code.
//
// Wire protocol (see server/README.md), /call — one connection per bridged call:
//   extension -> server  text  {type:'hello', token, callId, ringId, caller, format, client, have, sent}   then binary audio frames
//                              {type:'mute-state', muted} | {type:'note', message} | {type:'video-answer'|'video-ice'|'video-stop', ...}
//   server -> extension  text  {type:'ready', iceServers, got} | {type:'rewind', from} (answered with {type:'rewound'})
//                              | {type:'mute', muted} | {type:'stop', reason} | {type:'error', message}
//                              | {type:'video-offer'|'video-ice'|'video-stop', ...}  (camera control, see page-audio.js)
//                              | {type:'end-call'}  (the app pressed "End call": actually hang up, not just release the bridge)
//   both directions      binary  PCM signed 16-bit little-endian, mono, 16 kHz, 20 ms (640 bytes) per frame
//
// Nothing is lost when the connection drops: frames are numbered by their position in the call.
// On (re)connecting, hello says how many of the app's frames arrived here (have) and the server
// sends the rest; 'ready' says how many caller frames reached the server (got) and content.js
// sends the rest again from its own copy (see 'resend').
//
// video-* messages are opaque here: just relayed between the port and the socket as-is, so the
// WebRTC signaling details live only in page-audio.js (page world) and console.js (operator app).
(() => {
  const FORMAT = { encoding: 'pcm_s16le', sampleRate: 16000, channels: 1, frameMs: 20 };
  const CLIENT = 'teams-call-answerer/0.5.1';
  const RECONNECT_FOR_MS = 60000;  // keep reconnecting this long after the connection drops mid-call (the server holds the call as long)
  const HELLO_TIMEOUT_MS = 8000;
  const STUCK_BUFFERED = 1024 * 1024; // ~30 s of audio not leaving: treat the connection as dead and reconnect
  const CLOSE_UNAUTHORIZED = 4001;

  function toBase64(buffer) {
    const bytes = new Uint8Array(buffer);
    let s = '';
    for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return btoa(s);
  }

  function fromBase64(b64) {
    const s = atob(b64);
    const bytes = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) bytes[i] = s.charCodeAt(i);
    return bytes.buffer;
  }

  /** Returns an error message, or null if the URL is usable. Audio leaves the machine, so remote servers need TLS. */
  function checkServerUrl(url) {
    if (!url) return 'Set the server URL in the side panel.';
    let u;
    try { u = new URL(url); } catch { return 'Server URL is not a valid URL.'; }
    if (u.protocol === 'wss:') return null;
    if (u.protocol === 'ws:' && ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname)) return null;
    return 'Server URL must start with wss:// (ws:// is only allowed for localhost).';
  }

  /**
   * Serves one "bridge" port opened by content.js after a call was answered (or opened again for the
   * same call, e.g. after this worker restarted; then 'start' carries the counts so far).
   * Port messages in:  {type:'start', callId, caller, ringId, have, sent} | {type:'audio', seq, data: base64}
   *                    | {type:'mute-state', muted} | {type:'note', message} | {type:'stop', reason}
   * Port messages out: {type:'connected'} | {type:'audio', data: base64} | {type:'resend', from} | {type:'mute', muted} | {type:'stop', reason}
   * Caller audio must come numbered (seq 1, 2, …); after 'resend' content.js sends again from frame from + 1.
   * getConfig() resolves to { serverUrl, token }. onStatus({state, callId, caller, reason}) reports
   * 'connecting' | 'live' | 'reconnecting' | 'ended' | 'error'. 'live' also carries
   * { server, since, resumed } — resumed is true after a reconnect.
   */
  function serveBridgePort(port, { getConfig, onStatus }) {
    let ws = null;
    let callId = null;
    let caller = '';
    let ringId = null;     // set when the call was answered from the local app, so the server routes it there
    let ready = false;
    let closed = false;
    let attempts = 0;
    let lostAt = 0;        // when the connection dropped, while reconnecting
    let helloTimer = null;
    let since = 0;        // when the bridge first went live; reconnects keep it
    let muteState = null; // the Teams computer's mute state, re-sent after (re)connecting
    let have = 0;         // the app's frames received in this call
    let sent = 0;         // number of the last caller frame handed to the socket

    const status = (state, extra = {}) => onStatus?.({ state, callId, caller, ...extra });
    const toPort = (msg) => { try { port.postMessage(msg); } catch { /* content script went away */ } };

    function connect(cfg) {
      ws = new WebSocket(cfg.serverUrl);
      ws.binaryType = 'arraybuffer';
      helloTimer = setTimeout(() => ws.close(), HELLO_TIMEOUT_MS);
      ws.onopen = () => ws.send(JSON.stringify({ type: 'hello', token: cfg.token, callId, ringId, caller, format: FORMAT, client: CLIENT, have, sent, since: since || undefined }));
      ws.onmessage = (e) => {
        if (typeof e.data !== 'string') {
          if (ready) { have++; toPort({ type: 'audio', data: toBase64(e.data) }); }
          return;
        }
        let msg;
        try { msg = JSON.parse(e.data); } catch { return; }
        if (msg.type === 'ready') {
          clearTimeout(helloTimer);
          ready = true;
          attempts = 0;
          lostAt = 0;
          // Whatever the server didn't get (sent into a connection that was already dead) goes again.
          sent = Number.isInteger(msg.got) ? msg.got : sent;
          toPort({ type: 'resend', from: sent });
          toPort({ type: 'connected' });
          const resumed = since !== 0;
          if (!resumed) since = Date.now();
          status('live', { server: new URL(cfg.serverUrl).host, since, resumed });
          if (muteState !== null) ws.send(JSON.stringify({ type: 'mute-state', muted: muteState }));
          if (msg.iceServers) toPort({ type: 'ice-servers', iceServers: msg.iceServers });
        } else if (msg.type === 'rewind') {
          // After a server restart the app missed frames the server no longer has: send them again from `from`.
          sent = msg.from;
          ws.send(JSON.stringify({ type: 'rewound' })); // marks where the re-sent frames start
          toPort({ type: 'resend', from: sent });
        } else if (msg.type === 'mute') {
          toPort({ type: 'mute', muted: !!msg.muted });
        } else if (msg.type === 'stop') {
          finish(msg.reason || 'The server ended the bridge.');
        } else if (msg.type === 'error') {
          finish(msg.message || 'The server reported an error.', true);
        } else if (msg.type === 'video-offer' || msg.type === 'video-ice' || msg.type === 'video-stop' || msg.type === 'end-call') {
          toPort(msg);
        }
      };
      ws.onclose = (e) => {
        clearTimeout(helloTimer);
        ready = false;
        if (closed) return;
        if (e.code === CLOSE_UNAUTHORIZED) return finish('The server rejected the access token.', true);
        lostAt ||= Date.now();
        if (Date.now() - lostAt > RECONNECT_FOR_MS) return finish(`Lost the connection to the server for over a minute (code ${e.code}).`, true);
        attempts++;
        status('reconnecting', { reason: `attempt ${attempts}; the call's audio is kept and sent once connected` });
        setTimeout(() => { if (!closed) connect(cfg); }, Math.min(2000, 250 * 2 ** (attempts - 1)));
      };
    }

    function sendAudio(msg) {
      // Only the next frame in order: anything else was posted before a 'resend' and comes again.
      if (!ready || ws.readyState !== WebSocket.OPEN || msg.seq !== sent + 1) return;
      if (ws.bufferedAmount > STUCK_BUFFERED) { ws.close(); return; }
      ws.send(fromBase64(msg.data));
      sent = msg.seq;
    }

    function finish(reason, isError = false, fromPort = false) {
      if (closed) return;
      closed = true;
      clearTimeout(helloTimer);
      try {
        if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'end', reason }));
        ws?.close(1000);
      } catch { /* already closing */ }
      if (!fromPort) {
        toPort({ type: 'stop', reason });
        try { port.disconnect(); } catch { /* already gone */ }
      }
      status(isError ? 'error' : 'ended', { reason });
    }

    port.onMessage.addListener(async (msg) => {
      if (msg.type === 'audio') {
        sendAudio(msg);
      } else if (msg.type === 'start' && !callId) {
        callId = msg.callId;
        caller = msg.caller || 'Unknown caller';
        ringId = msg.ringId || null;
        have = msg.have || 0;
        sent = msg.sent || 0;
        const cfg = await getConfig();
        if (closed) return; // the call ended while we were reading settings
        const problem = checkServerUrl(cfg.serverUrl) || (!cfg.token && 'Set the access token in the side panel.');
        if (problem) return finish(problem, true);
        status('connecting');
        connect(cfg);
      } else if (msg.type === 'mute-state') {
        muteState = !!msg.muted;
        if (ready && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'mute-state', muted: muteState }));
      } else if (msg.type === 'video-answer' || msg.type === 'video-ice' || msg.type === 'video-stop' || msg.type === 'note') {
        if (ready && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
      } else if (msg.type === 'stop') {
        finish(msg.reason || 'Call ended.');
      }
    });
    port.onDisconnect.addListener(() => finish('Call ended.', false, true));

    return { get callId() { return callId; }, stop: (reason) => finish(reason) };
  }

  /** Opens a connection, says hello with test:true and reports whether the server accepted it. */
  function testServer({ serverUrl, token }) {
    const problem = checkServerUrl(serverUrl) || (!token && 'Set the access token first.');
    if (problem) return Promise.resolve({ ok: false, message: problem });
    return new Promise((resolve) => {
      const started = Date.now();
      let ws;
      try { ws = new WebSocket(serverUrl); } catch (err) { resolve({ ok: false, message: err.message }); return; }
      const done = (res) => { clearTimeout(timer); try { ws.close(1000); } catch { /* ignore */ } resolve(res); };
      const timer = setTimeout(() => done({ ok: false, message: 'No answer from the server within 8 s.' }), HELLO_TIMEOUT_MS);
      ws.onopen = () => ws.send(JSON.stringify({ type: 'hello', token, test: true, format: FORMAT, client: CLIENT }));
      ws.onmessage = (e) => {
        let msg;
        try { msg = JSON.parse(e.data); } catch { return; }
        if (msg.type === 'ready') done({ ok: true, message: `Connected (${Date.now() - started} ms).` });
        else if (msg.type === 'error') done({ ok: false, message: msg.message });
      };
      ws.onclose = (e) => done({
        ok: false,
        message: e.code === CLOSE_UNAUTHORIZED ? 'The server rejected the access token.' : `Could not connect (code ${e.code}).`,
      });
    });
  }

  /**
   * The always-on link to the server's /station endpoint: tells the server which calls are ringing,
   * and receives Answer/Decline from the local app. Reconnects with backoff and sends a keepalive
   * (which also keeps the extension's service worker awake).
   *   extension -> server  {type:'hello', role:'station', token, client} | {type:'ringing', ringId, caller}
   *                        | {type:'ring-ended', ringId} | {type:'answer-result', ringId, ok, message} | {type:'ping'}
   *   server -> extension  {type:'ready'} | {type:'answer'|'decline', ringId, mode} | {type:'pong'}
   * getConfig() -> { serverUrl, token, enabled }; onOpen() is called after each (re)connect so the caller
   * can re-announce calls that are still ringing; onStatus({ state, reason }) reports
   * 'connecting' | 'connected' | 'disconnected' | 'off'.
   */
  function createStation({ getConfig, onCommand, onOpen, onStatus }) {
    const KEEPALIVE_MS = 20000;
    let ws = null;
    let ready = false;
    let retry = 0;
    let retryTimer = null;
    let keepalive = null;
    let wantedKey = null; // url + token of the current connection

    const stationUrl = (callUrl) => callUrl.replace(/\/call\/?$/, '') + '/station';

    function send(msg) {
      if (ready && ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
    }

    function teardown() {
      clearTimeout(retryTimer);
      clearInterval(keepalive);
      ready = false;
      if (ws) { ws.onclose = null; try { ws.close(1000); } catch { /* closing */ } }
      ws = null;
    }

    /** (Re)connects if settings allow and we're not already connected to the right place. */
    async function ensure() {
      const cfg = await getConfig();
      const usable = cfg.enabled && cfg.token && cfg.serverUrl && !checkServerUrl(cfg.serverUrl);
      if (!usable) { teardown(); wantedKey = null; onStatus?.({ state: 'off' }); return; }
      const url = stationUrl(cfg.serverUrl);
      const key = `${url} ${cfg.token}`;
      if (ws && wantedKey === key && ws.readyState <= WebSocket.OPEN) return;
      teardown();
      wantedKey = key;
      onStatus?.({ state: 'connecting' });
      ws = new WebSocket(url);
      ws.onopen = () => ws.send(JSON.stringify({ type: 'hello', role: 'station', token: cfg.token, client: CLIENT }));
      ws.onmessage = (e) => {
        let msg;
        try { msg = JSON.parse(e.data); } catch { return; }
        if (msg.type === 'ready') {
          ready = true;
          retry = 0;
          keepalive = setInterval(() => send({ type: 'ping' }), KEEPALIVE_MS);
          onStatus?.({ state: 'connected' });
          onOpen?.();
        } else if (msg.type === 'answer' || msg.type === 'decline') {
          onCommand?.(msg);
        }
      };
      ws.onclose = (e) => {
        clearInterval(keepalive);
        ready = false;
        ws = null;
        const reason = e.code === CLOSE_UNAUTHORIZED ? 'The server rejected the access token.' : `Connection closed (code ${e.code}).`;
        onStatus?.({ state: 'disconnected', reason });
        const delay = Math.min(30000, 1000 * 2 ** retry++);
        retryTimer = setTimeout(ensure, e.code === CLOSE_UNAUTHORIZED ? 60000 : delay);
      };
    }

    return { ensure, send, close: teardown, get connected() { return ready; } };
  }

  globalThis.TeamsCallBridge = { FORMAT, toBase64, fromBase64, checkServerUrl, serveBridgePort, testServer, createStation };
})();
