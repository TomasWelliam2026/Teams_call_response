const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('callBridgeSetup', {
  save: (config) => ipcRenderer.invoke('save-config', config),
  getConfig: () => ipcRenderer.invoke('get-config'),
  setOpenAtLogin: (value) => ipcRenderer.invoke('set-open-at-login', value),
  collapse: () => ipcRenderer.send('collapse-popup'),
});

// ---- Console page only (ring-triggered show, and settings as an overlay in the same window) -----
// setup.html is loaded as a local file; the live console is the remote page (http/https). Only the
// console needs these, so file:// (setup.html) is left untouched.
if (location.protocol !== 'file:') {
  function ready(fn) {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', fn);
    else fn();
  }

  ready(() => {
    // ---- Show the window the moment a call rings or is active ----------------------------------
    // The console's own ring notification needs Notification permission, which this app's
    // auto-sign-in (main.js injects the token and reloads) never obtains: that only ever happened
    // inside the login form's submit handler, which this flow skips. Main.js now requests that
    // permission itself, but a tray popup is also hidden by default and only reappears on a click -
    // so without this, a ring could arrive with nothing on screen to show it. Watching the DOM
    // directly (not the page's own JS) works regardless of what world this script runs in.
    const ringsSection = document.getElementById('ringsSection');
    const activeSection = document.getElementById('active');
    function reportRinging() {
      const ringing = !!(ringsSection && !ringsSection.hidden) || !!(activeSection && !activeSection.hidden);
      ipcRenderer.send('ring-active', ringing);
    }
    const ringObserver = new MutationObserver(reportRinging);
    for (const el of [ringsSection, activeSection]) {
      if (el) ringObserver.observe(el, { attributes: true, attributeFilter: ['hidden'] });
    }
    reportRinging();

    // ---- Settings, as an overlay in this same window ---------------------------------------------
    // Built here instead of navigating to a separate settings page, so opening it never unloads the
    // console underneath: a live or ringing call stays visible and answerable while it's open.
    //
    // Styled like a patch panel on a phone switchboard, matching setup.html: a lamp + monospace
    // address readout instead of a plain title, monospace fields, a real toggle switch (its own child
    // span, not a ::after - see below). Every element is styled via its .style property, never a
    // <style> tag or style="" markup: the server sends `Content-Security-Policy: default-src 'self'`
    // with no style-src exception, so a <style> tag (even inside a shadow root - CSP isn't bypassed by
    // shadow DOM) is silently dropped. That's what made the first attempts render as unstyled,
    // top-left, un-centered content instead of a modal - confirmed by testing in a live copy of this
    // page before settling on this approach. CSSOM property writes (el.style.x = ...) are not subject
    // to that restriction, which is also why the switch's knob is a real element, not a ::after.
    const DARK = matchMedia('(prefers-color-scheme: dark)').matches;
    const fg = DARK ? '#eceeef' : '#15171a';
    const muted = DARK ? '#868d95' : '#5b6269';
    const line = DARK ? '#2c3036' : '#d7dbe0';
    const field = DARK ? '#121417' : '#f4f5f7';
    const card = DARK ? '#15171a' : '#ffffff';
    const amber = '#e8a33d';
    const green = DARK ? '#3fae6a' : '#1f8a4c';
    const danger = DARK ? '#d8574b' : '#c0392b';
    const MONO = 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';
    const SANS = "-apple-system, 'Segoe UI', system-ui, sans-serif";
    const FONT = `13px/1.45 ${SANS}`;

    function el(tag, style, props) {
      const node = document.createElement(tag);
      if (style) node.style.cssText = style;
      if (props) Object.assign(node, props);
      return node;
    }
    function hoverable(node, base, hover) {
      node.style.cssText += `;${base}`;
      node.addEventListener('mouseenter', () => { node.style.cssText += `;${hover}`; });
      node.addEventListener('mouseleave', () => { node.style.cssText += `;${base}`; });
    }

    const host = document.createElement('div');
    host.style.cssText = 'all:initial; position:fixed; inset:0; width:0; height:0; z-index:2147483647;';
    document.body.appendChild(host);
    const root = host.attachShadow({ mode: 'closed' });

    // Fixed-position buttons, always visible, top-right of the window: the window no longer hides
    // itself on blur (see main.js), so this collapse button is the only way to fold it back to just
    // the tray icon, and the settings gear sits next to it.
    function cornerButton(right, titleText, text) {
      const btn = el('button', `
        position:fixed; top:10px; right:${right}px; width:30px; height:30px; pointer-events:auto;
        border-radius:50%; border:1px solid ${line}; background:${DARK ? 'rgba(255,255,255,.08)' : 'rgba(0,0,0,.06)'};
        color:${fg}; display:flex; align-items:center; justify-content:center; cursor:pointer;
        font-size:15px; font:${FONT}; transition:background .12s ease; padding:0;
      `, { title: titleText, textContent: text });
      hoverable(btn, '', `background:${DARK ? 'rgba(255,255,255,.16)' : 'rgba(0,0,0,.12)'};`);
      return btn;
    }
    const collapseBtn = cornerButton(10, 'Collapse to tray icon', '↓');
    collapseBtn.addEventListener('click', () => ipcRenderer.send('collapse-popup'));
    const toggle = cornerButton(48, 'Settings', '⚙');

    const overlay = el('div', `
      position:fixed; inset:0; display:none; pointer-events:none;
      align-items:flex-start; justify-content:center; background:rgba(15,15,17,0);
      transition:background .15s ease;
    `);

    const cardEl = el('div', `
      margin-top:54px; width:calc(100% - 40px); max-width:340px; box-sizing:border-box;
      background:${card}; color:${fg}; border:1px solid ${line};
      box-shadow:0 16px 40px rgba(0,0,0,.45); padding:18px 18px 16px; font:${FONT};
      transform:translateY(-6px); opacity:0; transition:transform .15s ease, opacity .15s ease;
    `);

    // Lamp + monospace address readout, same device as setup.html's status line, instead of a plain
    // title: it reports what's actually configured, not just a label for the fields below.
    const lamp = el('span', `width:8px; height:8px; border-radius:50%; background:${muted}; flex:none; transform:translateY(-1px); transition:background .2s ease, box-shadow .2s ease;`);
    const hostReadout = el('span', `font:13px/1.3 ${MONO}; letter-spacing:.01em;`);
    const readoutRow = el('div', 'display:flex; align-items:baseline; gap:9px; margin:0 0 2px;');
    readoutRow.append(lamp, hostReadout);
    const detail = el('div', `margin:0 0 14px 17px; color:${muted}; font-size:12px; min-height:15px;`);

    function setLamp(state) {
      const color = state === 'connected' ? green : (state === 'error' ? danger : muted);
      lamp.style.background = color;
      lamp.style.boxShadow = state === 'off' ? 'none' : `0 0 7px 1px ${color}b3`;
      detail.style.color = state === 'error' ? danger : muted;
    }

    const rule1 = el('hr', `border:none; border-top:1px solid ${line}; margin:0 0 16px;`);

    function field_(labelText, inputType) {
      const wrap = el('div', 'margin-bottom:14px;');
      const label = el('label', `display:block; font-size:11.5px; color:${muted}; margin-bottom:6px;`, { textContent: labelText });
      const input = el('input', `
        width:100%; box-sizing:border-box; padding:8px 10px; border-radius:3px;
        border:1px solid ${line}; background:${field}; color:${fg}; font:13px/1.3 ${MONO};
      `, { type: inputType, autocomplete: 'off', spellcheck: false });
      input.addEventListener('focus', () => { input.style.borderColor = green; });
      input.addEventListener('blur', () => { input.style.borderColor = line; });
      wrap.append(label, input);
      return { wrap, input };
    }

    const urlField = field_('Server address', 'text');
    const tokenField = field_('Operator token', 'password');

    const showBtn = el('button', `
      flex:none; padding:0 12px; border-radius:3px; border:1px solid ${line};
      background:transparent; color:${muted}; cursor:pointer; font:12px ${SANS};
    `, { type: 'button', textContent: 'Show' });
    const tokenRow = el('div', 'display:flex; gap:6px;');
    tokenField.input.style.cssText += 'flex:1; min-width:0;';
    tokenRow.append(tokenField.input, showBtn);
    tokenField.wrap.replaceChildren(tokenField.wrap.firstChild, tokenRow);

    const errorLine = el('div', `color:${danger}; min-height:15px; margin:-6px 0 8px; font-size:12px;`);

    const rule2 = el('hr', `border:none; border-top:1px solid ${line}; margin:4px 0 16px;`);

    // A real toggle switch (not a checkbox): the knob is its own child span, since CSP (see above)
    // rules out a ::after pseudo-element here.
    const switchKnob = el('span', `
      position:absolute; top:2px; left:2px; width:15px; height:15px; border-radius:50%;
      background:${card}; transition:transform .15s ease;
    `);
    const loginSwitch = el('button', `
      position:relative; width:34px; height:19px; flex:none; border-radius:10px;
      background:${line}; border:none; cursor:pointer; padding:0; transition:background .15s ease;
    `, { type: 'button', role: 'switch', 'aria-pressed': 'false' });
    loginSwitch.appendChild(switchKnob);
    function setSwitch(on) {
      loginSwitch.setAttribute('aria-pressed', String(on));
      loginSwitch.style.background = on ? green : line;
      switchKnob.style.transform = on ? 'translateX(15px)' : 'translateX(0)';
    }
    const loginLabel = el('label', `font-size:12.5px; color:${fg};`, { textContent: 'Start Safe Job when Windows starts' });
    const loginRow = el('div', 'display:flex; align-items:center; justify-content:space-between; gap:12px; margin:0 0 4px;');
    loginRow.append(loginLabel, loginSwitch);

    const status = el('div', `min-height:16px; margin:14px 0 2px; font:${FONT};`);

    const closeBtn = el('button', `
      padding:7px 14px; border-radius:3px; cursor:pointer; font:600 13px/1.3 ${SANS};
      border:1px solid ${line}; background:none; color:${fg};
    `, { type: 'button', textContent: 'Close' });
    hoverable(closeBtn, '', `background:${DARK ? 'rgba(255,255,255,.08)' : 'rgba(0,0,0,.06)'};`);

    const saveBtn = el('button', `
      padding:7px 14px; border-radius:3px; cursor:pointer; font:600 13px/1.3 ${SANS};
      border:none; background:${green}; color:#fff;
    `, { type: 'button', textContent: 'Save' });
    hoverable(saveBtn, '', `filter:brightness(1.1);`);

    const actions = el('div', 'display:flex; justify-content:flex-end; gap:8px; margin-top:4px;');
    actions.append(closeBtn, saveBtn);

    cardEl.append(readoutRow, detail, rule1, urlField.wrap, tokenField.wrap, errorLine, rule2, loginRow, status, actions);
    overlay.appendChild(cardEl);
    root.append(collapseBtn, toggle, overlay);

    async function openSettings() {
      try {
        const config = await ipcRenderer.invoke('get-config');
        urlField.input.value = config.serverUrl || '';
        tokenField.input.value = config.token || '';
        setSwitch(!!config.openAtLogin);
        if (config.serverUrl) {
          hostReadout.textContent = new URL(config.serverUrl).host;
          setLamp('connected');
          detail.textContent = 'Connected.';
        } else {
          hostReadout.textContent = '';
          setLamp('off');
          detail.textContent = 'Enter the server address and operator token.';
        }
      } catch { /* leave fields blank */ }
      errorLine.textContent = '';
      status.textContent = '';
      overlay.style.display = 'flex';
      overlay.style.pointerEvents = 'auto';
      // Two steps so the transition actually animates from the initial state set above.
      requestAnimationFrame(() => {
        overlay.style.background = 'rgba(15,15,17,.5)';
        cardEl.style.transform = 'translateY(0)';
        cardEl.style.opacity = '1';
      });
      urlField.input.focus();
    }
    function closeSettings() {
      overlay.style.background = 'rgba(15,15,17,0)';
      overlay.style.pointerEvents = 'none';
      cardEl.style.transform = 'translateY(-6px)';
      cardEl.style.opacity = '0';
      setTimeout(() => { overlay.style.display = 'none'; }, 150);
    }
    function isOpen() { return overlay.style.display === 'flex'; }
    function toggleSettings() { (isOpen() ? closeSettings : openSettings)(); }

    toggle.addEventListener('click', toggleSettings);
    closeBtn.addEventListener('click', closeSettings);
    overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) closeSettings(); });
    host.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeSettings(); });

    showBtn.addEventListener('click', () => {
      const show = tokenField.input.type === 'password';
      tokenField.input.type = show ? 'text' : 'password';
      showBtn.textContent = show ? 'Hide' : 'Show';
    });
    loginSwitch.addEventListener('click', () => {
      const next = loginSwitch.getAttribute('aria-pressed') !== 'true';
      setSwitch(next);
      ipcRenderer.invoke('set-open-at-login', next);
    });
    saveBtn.addEventListener('click', async () => {
      status.textContent = '';
      errorLine.textContent = '';
      try {
        // Only actually navigates (dropping any live call) when the server URL changed; a token-only
        // change is saved for next reconnect so an in-progress call isn't interrupted just to look at
        // settings - see the comment on save-config in main.js.
        const result = await ipcRenderer.invoke('save-config', { serverUrl: urlField.input.value.trim(), token: tokenField.input.value.trim() });
        if (result?.reloaded) return;
        setLamp('connected');
        detail.textContent = 'Connected.';
        status.style.color = green;
        status.textContent = 'Saved. The new token is used next time the app reconnects or restarts.';
      } catch (err) {
        setLamp('error');
        detail.textContent = 'Could not save.';
        errorLine.textContent = err?.message || 'Could not save.';
      }
    });

    ipcRenderer.on('toggle-settings', toggleSettings);
  });
}
