// Shared by the background worker (via importScripts), content.js and the test shim.
// Owns the WebSocket to the audio server for one answered call. No chrome.* APIs here, so the
// mock page can run the exact same code.
//
// Wire protocol (see server/README.md), /call — one connection per bridged call:
//   extension -> server  text  {type:'hello', token, callId, ringId, caller, format, client}   then binary audio frames
//                              {type:'mute-state', muted}  the Teams computer's mute state
//   server -> extension  text  {type:'ready'} | {type:'mute', muted} | {type:'stop', reason} | {type:'error', message}
//   both directions      binary  PCM signed 16-bit little-endian, mono, 16 kHz, 20 ms (640 bytes) per frame
(() => {
  const FORMAT = { encoding: 'pcm_s16le', sampleRate: 16000, channels: 1, frameMs: 20 };
  const CLIENT = 'teams-call-answerer/0.4.2';
  const MAX_RETRIES = 3;           // reconnect attempts after the connection drops mid-call
  const HELLO_TIMEOUT_MS = 8000;
  const MAX_BUFFERED = 64 * 1024;  // drop outgoing audio instead of queueing behind a slow network
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
   * Serves one "bridge" port opened by content.js after a call was answered.
   * Port messages in:  {type:'start', callId, caller} | {type:'audio', data: base64} | {type:'mute-state', muted} | {type:'stop', reason}
   * Port messages out: {type:'connected'} | {type:'audio', data: base64} | {type:'mute', muted} | {type:'stop', reason}
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
    let helloTimer = null;
    let since = 0;        // when the bridge first went live; reconnects keep it
    let muteState = null; // the Teams computer's mute state, re-sent after (re)connecting

    const status = (state, extra = {}) => onStatus?.({ state, callId, caller, ...extra });
    const toPort = (msg) => { try { port.postMessage(msg); } catch { /* content script went away */ } };

    function connect(cfg) {
      ws = new WebSocket(cfg.serverUrl);
      ws.binaryType = 'arraybuffer';
      helloTimer = setTimeout(() => ws.close(), HELLO_TIMEOUT_MS);
      ws.onopen = () => ws.send(JSON.stringify({ type: 'hello', token: cfg.token, callId, ringId, caller, format: FORMAT, client: CLIENT }));
      ws.onmessage = (e) => {
        if (typeof e.data !== 'string') {
          if (ready) toPort({ type: 'audio', data: toBase64(e.data) });
          return;
        }
        let msg;
        try { msg = JSON.parse(e.data); } catch { return; }
        if (msg.type === 'ready') {
          clearTimeout(helloTimer);
          ready = true;
          attempts = 0;
          toPort({ type: 'connected' });
          const resumed = since !== 0;
          if (!resumed) since = Date.now();
          status('live', { server: new URL(cfg.serverUrl).host, since, resumed });
          if (muteState !== null) ws.send(JSON.stringify({ type: 'mute-state', muted: muteState }));
        } else if (msg.type === 'mute') {
          toPort({ type: 'mute', muted: !!msg.muted });
        } else if (msg.type === 'stop') {
          finish(msg.reason || 'The server ended the bridge.');
        } else if (msg.type === 'error') {
          finish(msg.message || 'The server reported an error.', true);
        }
      };
      ws.onclose = (e) => {
        clearTimeout(helloTimer);
        ready = false;
        if (closed) return;
        if (e.code === CLOSE_UNAUTHORIZED) return finish('The server rejected the access token.', true);
        if (attempts >= MAX_RETRIES) return finish(`Lost the connection to the server (code ${e.code}).`, true);
        attempts++;
        status('reconnecting', { reason: `attempt ${attempts} of ${MAX_RETRIES}` });
        setTimeout(() => { if (!closed) connect(cfg); }, 1000 * 2 ** (attempts - 1));
      };
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
        if (ready && ws.readyState === WebSocket.OPEN && ws.bufferedAmount < MAX_BUFFERED) ws.send(fromBase64(msg.data));
      } else if (msg.type === 'start' && !callId) {
        callId = msg.callId;
        caller = msg.caller || 'Unknown caller';
        ringId = msg.ringId || null;
        const cfg = await getConfig();
        if (closed) return; // the call ended while we were reading settings
        const problem = checkServerUrl(cfg.serverUrl) || (!cfg.token && 'Set the access token in the side panel.');
        if (problem) return finish(problem, true);
        status('connecting');
        connect(cfg);
      } else if (msg.type === 'mute-state') {
        muteState = !!msg.muted;
        if (ready && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'mute-state', muted: muteState }));
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
