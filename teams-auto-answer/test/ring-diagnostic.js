// Ring diagnostic: run in the DevTools console of a Teams tab where incoming calls aren't reported
// to the Call Bridge app. Paste it, press Enter, then call this Teams account within 2 minutes.
// While it rings, it records the buttons Teams adds (labels and the elements around them) and
// the page's language, then copies a report to the clipboard.
(() => {
  const label = (el) => [el.getAttribute('aria-label'), el.getAttribute('title'), el.getAttribute('data-tid'), el.getAttribute('role')]
    .map((s) => (s || '').trim()).join(' | ');
  const btns = () => [...document.querySelectorAll('button, [role="button"]')];
  const before = new Set(btns());
  const seen = new Map();
  const report = {
    host: location.host, path: location.pathname, lang: document.documentElement.lang, uiLang: navigator.language,
    visible: document.visibilityState, frame: window === top ? 'top' : 'iframe',
    newButtons: [],
  };
  const t = setInterval(() => {
    for (const b of btns()) {
      if (before.has(b) || seen.has(b)) continue;
      const chain = [];
      for (let el = b.parentElement, i = 0; el && i < 6; el = el.parentElement, i++) chain.push(label(el) + ' :: ' + (el.innerText || '').replace(/\s+/g, ' ').slice(0, 120));
      seen.set(b, { button: label(b), text: (b.textContent || '').trim().slice(0, 60), around: chain });
    }
  }, 300);
  setTimeout(() => {
    clearInterval(t);
    report.newButtons = [...seen.values()].slice(0, 40);
    const text = JSON.stringify(report, null, 1);
    try { copy(text); console.log('Ring diagnostic copied to the clipboard. Paste it to Claude.'); } catch { console.log(text); }
  }, 120000);
  console.log('Ring diagnostic running for 2 minutes: call this Teams account now and let it ring ~10 s.');
})();
