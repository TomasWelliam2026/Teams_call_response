// Finds incoming Teams calls and their Accept/Decline buttons. Used by content.js.
// Detection works on accessible names (aria-label, title, data-tid, visible text) instead of
// hard-coded class names, because Teams changes its markup often.
(() => {
  const PATTERNS = {
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

  // textContent rather than innerText: it doesn't force layout, and scans run often.
  function namesOf(el) {
    return [el.getAttribute('aria-label'), el.getAttribute('title'), el.getAttribute('data-tid'), el.textContent]
      .filter(Boolean).map(s => s.replace(/\s+/g, ' ').trim());
  }

  // Order matters: "Answer without video" must count as audio, not video.
  function classify(names) {
    names = [].concat(names).filter(Boolean);
    if (names.some(n => PATTERNS.acceptAudio.test(n))) return 'audio';
    if (names.some(n => PATTERNS.acceptVideo.test(n))) return 'video';
    if (names.some(n => PATTERNS.accept.test(n))) return 'accept';
    if (names.some(n => PATTERNS.decline.test(n))) return 'decline';
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
  function findCallContainer(button) {
    const doc = button.ownerDocument;
    let el = button.parentElement;
    for (let depth = 0; el && depth < MAX_CONTEXT_DEPTH; depth++, el = el.parentElement) {
      if (el === doc.body || el === doc.documentElement) return null;
      if (el.querySelectorAll('button, [role="button"]').length > MAX_CONTEXT_BUTTONS) return null;
      const label = [el.getAttribute('aria-label'), el.getAttribute('data-tid'), el.id].filter(Boolean).join(' ');
      if (label && PATTERNS.context.test(label)) return el;
      const text = el.innerText || '';
      if (text.length <= MAX_CONTEXT_TEXT && PATTERNS.context.test(text)) return el;
    }
    return null;
  }

  function extractCaller(text) {
    const m = text.match(/(?:call from|calling from)\s*:?\s+([^\n.,;]+)/i)
      || text.match(/^\s*([^\n]+?)\s+(?:is calling|wants to (?:video )?call)/im);
    if (m) return m[1].trim();
    const lines = text.split('\n').map(s => s.trim())
      .filter(l => l && !classify(l) && !PATTERNS.context.test(l) && l.length < 60);
    return lines[0] || 'Unknown caller';
  }

  /** Returns every visible incoming call in the document, newest (last in DOM order) last. */
  function detectCalls(doc) {
    const calls = new Map();
    for (const btn of doc.querySelectorAll('button, [role="button"]')) {
      const kind = classify(namesOf(btn));
      if (!kind || !isVisible(btn)) continue;
      const container = findCallContainer(btn);
      if (!container) continue;
      let call = calls.get(container);
      if (!call) {
        const text = [container.getAttribute('aria-label'), container.innerText].filter(Boolean).join('\n');
        call = { container, text, caller: extractCaller(text), actions: {} };
        calls.set(container, call);
      }
      if (!call.actions[kind]) call.actions[kind] = btn;
    }
    return [...calls.values()].filter(c => c.actions.audio || c.actions.video || c.actions.accept);
  }

  /** Button to press for an action. Never falls back from audio to video (privacy). */
  function pickButton(call, action) {
    const a = call.actions;
    if (action === 'decline') return a.decline || null;
    if (action === 'video') return a.video || a.audio || a.accept || null;
    return a.audio || a.accept || null;
  }

  globalThis.TeamsCallDetector = { PATTERNS, classify, detectCalls, pickButton, extractCaller };
})();
