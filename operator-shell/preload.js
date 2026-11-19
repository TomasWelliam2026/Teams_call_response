const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('callBridgeSetup', {
  save: (config) => ipcRenderer.invoke('save-config', config),
  getConfig: () => ipcRenderer.invoke('get-config'),
  setOpenAtLogin: (value) => ipcRenderer.invoke('set-open-at-login', value),
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
    // Every element below is styled via its .style property, never a <style> tag or style="" markup:
    // the server sends `Content-Security-Policy: default-src 'self'` with no style-src exception, so
    // a <style> tag (even inside a shadow root - CSP isn't bypassed by shadow DOM) is silently
    // dropped. That's what made the first two attempts render as unstyled, top-left, un-centered
    // content instead of a modal - confirmed by testing in a live copy of this page before settling
    // on this approach. CSSOM property writes (el.style.x = ...) are not subject to that restriction.
    const DARK = matchMedia('(prefers-color-scheme: dark)').matches;
    const fg = DARK ? '#e8eaed' : '#1f1f1f';
    const muted = DARK ? '#9aa0a6' : '#5f6368';
    const line = DARK ? '#3c4043' : '#dadce0';
    const field = DARK ? '#2a2b2e' : '#f8f9fa';
    const card = DARK ? '#202124' : '#ffffff';
    const accent = DARK ? '#34a853' : '#188038';
    const accentDark = DARK ? '#2a8a44' : '#156c2f';
    const danger = DARK ? '#f28b82' : '#c5221f';
    const FONT = "13px/1.45 -apple-system, 'Segoe UI', system-ui, sans-serif";

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

    // A fixed-position toggle button, always visible, top-right of the window.
    const toggle = el('button', `
      position:fixed; top:10px; right:10px; width:30px; height:30px; pointer-events:auto;
      border-radius:50%; border:1px solid ${line}; background:${DARK ? 'rgba(255,255,255,.08)' : 'rgba(0,0,0,.06)'};
      color:${fg}; display:flex; align-items:center; justify-content:center; cursor:pointer;
      font-size:15px; font:${FONT}; transition:background .12s ease; padding:0;
    `, { title: 'Settings', textContent: '⚙' });
    hoverable(toggle, '', `background:${DARK ? 'rgba(255,255,255,.16)' : 'rgba(0,0,0,.12)'};`);

    const overlay = el('div', `
      position:fixed; inset:0; display:none; pointer-events:none;
      align-items:flex-start; justify-content:center; background:rgba(15,15,17,0);
      transition:background .15s ease;
    `);

    const cardEl = el('div', `
      margin-top:54px; width:calc(100% - 40px); max-width:340px; box-sizing:border-box;
      background:${card}; color:${fg}; border-radius:12px; border:1px solid ${line};
      box-shadow:0 16px 40px rgba(0,0,0,.4); padding:18px 18px 16px;
      transform:translateY(-6px); opacity:0; transition:transform .15s ease, opacity .15s ease;
    `);

    const heading = el('h2', `font:650 15px/1.3 ${FONT.split(' ').slice(1).join(' ')}; margin:0 0 14px; color:${fg};`, { textContent: 'Call Bridge settings' });

    function field_(labelText, inputType) {
      const wrap = el('div', 'margin-bottom:14px;');
      const label = el('label', `display:block; font:600 12px/1.2 ${FONT.split(' ').slice(1).join(' ')}; color:${muted}; margin-bottom:5px;`, { textContent: labelText });
      const input = el('input', `
        width:100%; box-sizing:border-box; padding:7px 9px; border-radius:7px;
        border:1px solid ${line}; background:${field}; color:${fg}; font:${FONT};
      `, { type: inputType, autocomplete: 'off', spellcheck: false });
      input.addEventListener('focus', () => { input.style.outline = `2px solid ${accent}`; input.style.outlineOffset = '-1px'; input.style.borderColor = 'transparent'; });
      input.addEventListener('blur', () => { input.style.outline = 'none'; input.style.borderColor = line; });
      wrap.append(label, input);
      return { wrap, input };
    }

    const urlField = field_('Server URL', 'text');
    const tokenField = field_('Operator token', 'password');

    const showBtn = el('button', `
      flex:none; padding:0 12px; border-radius:7px; border:1px solid ${line};
      background:${field}; color:${fg}; cursor:pointer; font:${FONT};
    `, { type: 'button', textContent: 'Show' });
    const tokenRow = el('div', 'display:flex; gap:6px;');
    tokenField.input.style.cssText += 'flex:1; min-width:0;';
    tokenRow.append(tokenField.input, showBtn);
    tokenField.wrap.replaceChildren(tokenField.wrap.firstChild, tokenRow);

    const loginRow = el('div', 'display:flex; align-items:center; gap:8px; margin:16px 0 6px;');
    const loginCheck = el('input', 'width:15px; height:15px; flex:none;', { type: 'checkbox', id: 'cbOpenAtLogin' });
    const loginLabel = el('label', `font:12.5px/1.3 ${FONT.split(' ').slice(1).join(' ')}; color:${fg};`, { textContent: 'Start Call Bridge when Windows starts', htmlFor: 'cbOpenAtLogin' });
    loginRow.append(loginCheck, loginLabel);

    const status = el('div', `min-height:16px; margin:4px 0 2px; font:${FONT};`);

    const closeBtn = el('button', `
      padding:7px 14px; border-radius:7px; cursor:pointer; font:600 13px/1.3 ${FONT.split(' ').slice(1).join(' ')};
      border:1px solid ${line}; background:none; color:${fg};
    `, { type: 'button', textContent: 'Close' });
    hoverable(closeBtn, '', `background:${DARK ? 'rgba(255,255,255,.08)' : 'rgba(0,0,0,.06)'};`);

    const saveBtn = el('button', `
      padding:7px 14px; border-radius:7px; cursor:pointer; font:600 13px/1.3 ${FONT.split(' ').slice(1).join(' ')};
      border:none; background:${accent}; color:#fff;
    `, { type: 'button', textContent: 'Save' });
    hoverable(saveBtn, '', `background:${accentDark};`);

    const actions = el('div', 'display:flex; justify-content:flex-end; gap:8px; margin-top:16px;');
    actions.append(closeBtn, saveBtn);

    cardEl.append(heading, urlField.wrap, tokenField.wrap, loginRow, status, actions);
    overlay.appendChild(cardEl);
    root.append(toggle, overlay);

    async function openSettings() {
      try {
        const config = await ipcRenderer.invoke('get-config');
        urlField.input.value = config.serverUrl || '';
        tokenField.input.value = config.token || '';
        loginCheck.checked = !!config.openAtLogin;
      } catch { /* leave fields blank */ }
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
    loginCheck.addEventListener('change', () => ipcRenderer.invoke('set-open-at-login', loginCheck.checked));
    saveBtn.addEventListener('click', async () => {
      status.textContent = '';
      try {
        // Only actually navigates (dropping any live call) when the server URL changed; a token-only
        // change is saved for next reconnect so an in-progress call isn't interrupted just to look at
        // settings - see the comment on save-config in main.js.
        const result = await ipcRenderer.invoke('save-config', { serverUrl: urlField.input.value.trim(), token: tokenField.input.value.trim() });
        if (result?.reloaded) return;
        status.style.color = accent;
        status.textContent = 'Saved. The new token is used next time the app reconnects or restarts.';
      } catch (err) {
        status.style.color = danger;
        status.textContent = err?.message || 'Could not save.';
      }
    });

    ipcRenderer.on('toggle-settings', toggleSettings);
  });
}
