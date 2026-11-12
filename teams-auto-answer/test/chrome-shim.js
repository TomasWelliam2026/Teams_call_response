// Minimal stand-in for the chrome.* APIs content.js uses, so the real content script
// can run on the mock page without installing the extension. The background worker's bridge
// is the real bridge.js (loaded later by the page), driven through fake ports.
// Point it at a server with: __bridgeConfig = { serverUrl: 'ws://localhost:8787/call', token: '…' }
(() => {
  const store = {};
  const changeListeners = [];
  const messageListeners = [];
  window.__sentToBackground = [];
  window.__bridgeStatus = [];
  window.__bridgeConfig = { serverUrl: '', token: '' };

  const deliver = (msg) => messageListeners.forEach(fn => fn(msg, {}, () => {}));

  // Fake background handling for the bridge messages content.js sends.
  function background(msg) {
    if (msg.type === 'bridge-arm') setTimeout(() => deliver({ type: 'bridge-arm', callId: crypto.randomUUID(), caller: msg.caller, ringId: msg.ringId }), 0);
  }

  // Two linked chrome.runtime.Port look-alikes. Messages are JSON-cloned like the real thing.
  function portPair(name) {
    const make = () => {
      const p = {
        name, closed: false, msg: [], disc: [],
        postMessage(m) {
          if (p.closed) throw new Error('Attempting to use a disconnected port object');
          const copy = JSON.parse(JSON.stringify(m));
          setTimeout(() => p.other.msg.forEach(fn => fn(copy)), 0);
        },
        disconnect() {
          if (p.closed) return;
          p.closed = p.other.closed = true;
          setTimeout(() => p.other.disc.forEach(fn => fn()), 0);
        },
        onMessage: { addListener: (fn) => p.msg.push(fn) },
        onDisconnect: { addListener: (fn) => p.disc.push(fn) },
      };
      return p;
    };
    const a = make();
    const b = make();
    a.other = b;
    b.other = a;
    return [a, b];
  }

  window.chrome = {
    runtime: {
      id: 'mock',
      getURL: (p) => new URL(`../${p}`, location.href).href,
      sendMessage(msg) {
        window.__sentToBackground.push(msg);
        window.dispatchEvent(new CustomEvent('mock-bg', { detail: msg }));
        background(msg);
        return Promise.resolve();
      },
      connect({ name }) {
        const [contentSide, backgroundSide] = portPair(name);
        globalThis.TeamsCallBridge.serveBridgePort(backgroundSide, {
          getConfig: async () => window.__bridgeConfig,
          onStatus: (s) => {
            window.__bridgeStatus.push(s);
            window.dispatchEvent(new CustomEvent('mock-bg', { detail: { bridgeStatus: s.state, reason: s.reason } }));
          },
        });
        return contentSide;
      },
      onMessage: { addListener: (fn) => messageListeners.push(fn) },
    },
    storage: {
      sync: {
        get: () => Promise.resolve({ ...store }),
        set(patch) {
          const changes = {};
          for (const [k, v] of Object.entries(patch)) { changes[k] = { oldValue: store[k], newValue: v }; store[k] = v; }
          changeListeners.forEach(fn => fn(changes, 'sync'));
          return Promise.resolve();
        },
      },
      onChanged: { addListener: (fn) => changeListeners.push(fn) },
    },
  };

  /** Simulates the background worker sending a message; resolves with the content script's reply (or null). */
  window.__sendToContent = (msg) => new Promise((resolve) => {
    let replied = false;
    for (const fn of messageListeners) fn(msg, {}, (res) => { replied = true; resolve(res); });
    setTimeout(() => { if (!replied) resolve(null); }, 50);
  });
})();
