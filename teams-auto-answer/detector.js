// Shared by the content script, the background worker (via importScripts) and the side panel.
// Detection works on accessible names (aria-label, title, data-tid, visible text) instead of
// hard-coded class names, because Teams changes its markup often.
(() => {
  const DEFAULT_SETTINGS = {
    enabled: false,          // auto-answer on/off (shortcuts work either way)
    mode: 'audio',           // 'audio' | 'video'
    delaySec: 3,             // let it ring this long before auto-answering
    allowlist: '',           // one name per line; empty = anyone
    blocklist: '',           // one name per line; never auto-answer these
    hoursEnabled: false,
    hoursStart: '09:00',
    hoursEnd: '17:00',
    days: [1, 2, 3, 4, 5],   // 0 = Sunday
    notify: true,
    keepAlive: true,         // stop the browser from discarding Teams tabs
    // Audio bridge: after a person answers, stream the call to serverUrl (access token lives in
    // storage.local). Always on since 0.4: entering the URL and token is the whole setup.
    bridgeEnabled: true,
    serverUrl: '',
    bridgeKeepMic: false,    // also send the real microphone, mixed with the server's audio
    // Advanced: regex overrides, e.g. for a non-English Teams UI.
    customContext: '',
    customAcceptAudio: '',
    customAcceptVideo: '',
    customAccept: '',
    customDecline: '',
  };

  const DEFAULT_PATTERNS = {
    // Text found on (or around) an incoming-call notification.
    context: /incoming (audio |video )?call|is calling|calling you|call from|wants to (video )?call|incoming[-_ ]?call|call[-_ ]?toast/i,
    acceptAudio: /\b(accept|answer)\b.*\b(audio|voice|without video)\b|\baudio\b.*\b(accept|answer)\b/i,
    acceptVideo: /\b(accept|answer)\b.*\bvideo\b|\bvideo\b.*\b(accept|answer)\b/i,
    accept: /^\s*(accept|answer)( call)?\s*$|\b(call[-_ ]?accept|accept[-_ ]?call)\b/i,
    decline: /\b(decline|reject)\b/i,
  };

  const MAX_CONTEXT_DEPTH = 8;
  const MAX_CONTEXT_TEXT = 300;
  const MAX_CONTEXT_BUTTONS = 6; // a call notification has a handful of buttons, a page section has many

  function compile(custom, fallback) {
    if (!custom) return fallback;
    try { return new RegExp(custom, 'i'); } catch { return fallback; }
  }

  function patternsFrom(settings = {}) {
    return {
      context: compile(settings.customContext, DEFAULT_PATTERNS.context),
      acceptAudio: compile(settings.customAcceptAudio, DEFAULT_PATTERNS.acceptAudio),
      acceptVideo: compile(settings.customAcceptVideo, DEFAULT_PATTERNS.acceptVideo),
      accept: compile(settings.customAccept, DEFAULT_PATTERNS.accept),
      decline: compile(settings.customDecline, DEFAULT_PATTERNS.decline),
    };
  }

  // textContent rather than innerText: it doesn't force layout, and scans run often.
  function namesOf(el) {
    return [el.getAttribute('aria-label'), el.getAttribute('title'), el.getAttribute('data-tid'), el.textContent]
      .filter(Boolean).map(s => s.replace(/\s+/g, ' ').trim());
  }

  // Order matters: "Answer without video" must count as audio, not video.
  function classify(names, p) {
    names = [].concat(names).filter(Boolean);
    if (names.some(n => p.acceptAudio.test(n))) return 'audio';
    if (names.some(n => p.acceptVideo.test(n))) return 'video';
    if (names.some(n => p.accept.test(n))) return 'accept';
    if (names.some(n => p.decline.test(n))) return 'decline';
    return null;
  }

  function isVisible(el) {
    if (el.disabled || el.getAttribute('aria-disabled') === 'true') return false;
    if (!el.getClientRects().length) return false;
    const style = el.ownerDocument.defaultView.getComputedStyle(el);
    return style.visibility !== 'hidden' && style.display !== 'none';
  }

  // Walk up from a button to the nearest small element that looks like an incoming-call UI.
  // The size cap keeps us from matching a whole chat pane that merely mentions "call from".
  function findCallContainer(button, p) {
    const doc = button.ownerDocument;
    let el = button.parentElement;
    for (let depth = 0; el && depth < MAX_CONTEXT_DEPTH; depth++, el = el.parentElement) {
      if (el === doc.body || el === doc.documentElement) return null;
      if (el.querySelectorAll('button, [role="button"]').length > MAX_CONTEXT_BUTTONS) return null;
      const label = [el.getAttribute('aria-label'), el.getAttribute('data-tid'), el.id].filter(Boolean).join(' ');
      if (label && p.context.test(label)) return el;
      const text = el.innerText || '';
      if (text.length <= MAX_CONTEXT_TEXT && p.context.test(text)) return el;
    }
    return null;
  }

  function extractCaller(text, p) {
    const m = text.match(/(?:call from|calling from)\s*:?\s+([^\n.,;]+)/i)
      || text.match(/^\s*([^\n]+?)\s+(?:is calling|wants to (?:video )?call)/im);
    if (m) return m[1].trim();
    const lines = text.split('\n').map(s => s.trim())
      .filter(l => l && !classify(l, p) && !p.context.test(l) && l.length < 60);
    return lines[0] || 'Unknown caller';
  }

  /** Returns every visible incoming call in the document, newest (last in DOM order) last. */
  function detectCalls(doc, settings) {
    const p = patternsFrom(settings);
    const calls = new Map();
    for (const btn of doc.querySelectorAll('button, [role="button"]')) {
      const kind = classify(namesOf(btn), p);
      if (!kind || !isVisible(btn)) continue;
      const container = findCallContainer(btn, p);
      if (!container) continue;
      let call = calls.get(container);
      if (!call) {
        const text = [container.getAttribute('aria-label'), container.innerText].filter(Boolean).join('\n');
        call = { container, text, caller: extractCaller(text, p), actions: {} };
        calls.set(container, call);
      }
      if (!call.actions[kind]) call.actions[kind] = btn;
    }
    return [...calls.values()].filter(c => c.actions.audio || c.actions.video || c.actions.accept);
  }

  /** For the side panel's "Scan" button: what the detector sees, to help tune regex overrides. */
  function diagnose(doc, settings) {
    const p = patternsFrom(settings);
    const candidates = [];
    for (const btn of doc.querySelectorAll('button, [role="button"]')) {
      const names = namesOf(btn);
      const kind = classify(names, p);
      if (!kind || !isVisible(btn)) continue;
      candidates.push({ kind, name: names.join(' | ').slice(0, 120), inCallUi: !!findCallContainer(btn, p) });
      if (candidates.length >= 15) break;
    }
    const calls = detectCalls(doc, settings).map(c => ({ caller: c.caller, actions: Object.keys(c.actions) }));
    return { calls, candidates };
  }

  /** Button to press for an action. Never falls back from audio to video (privacy). */
  function pickButton(call, action) {
    const a = call.actions;
    if (action === 'decline') return a.decline || null;
    if (action === 'video') return a.video || a.audio || a.accept || null;
    return a.audio || a.accept || null;
  }

  function lines(s) {
    return (s || '').split('\n').map(x => x.trim().toLowerCase()).filter(Boolean);
  }

  function minutes(hhmm) {
    const [h, m] = (hhmm || '0:0').split(':').map(Number);
    return h * 60 + (m || 0);
  }

  /** Decide whether a detected call should be auto-answered. Returns { answer, reason }. */
  function evaluateRules(caller, callText, settings, now = new Date()) {
    const s = { ...DEFAULT_SETTINGS, ...settings };
    if (!s.enabled) return { answer: false, reason: 'auto-answer is off' };
    const haystack = `${caller}\n${callText}`.toLowerCase();
    const blocked = lines(s.blocklist).find(n => haystack.includes(n));
    if (blocked) return { answer: false, reason: `"${blocked}" is on the block list` };
    const allow = lines(s.allowlist);
    if (allow.length && !allow.some(n => haystack.includes(n))) {
      return { answer: false, reason: 'caller is not on the allow list' };
    }
    if (s.hoursEnabled) {
      if (!s.days.includes(now.getDay())) return { answer: false, reason: 'outside active days' };
      const t = now.getHours() * 60 + now.getMinutes();
      const start = minutes(s.hoursStart), end = minutes(s.hoursEnd);
      const inside = start <= end ? t >= start && t < end : t >= start || t < end; // supports overnight
      if (!inside) return { answer: false, reason: 'outside active hours' };
    }
    return { answer: true, reason: 'rules matched' };
  }

  globalThis.TeamsCallDetector = {
    DEFAULT_SETTINGS, DEFAULT_PATTERNS, patternsFrom, classify, detectCalls, diagnose, pickButton, evaluateRules, extractCaller,
  };
})();
