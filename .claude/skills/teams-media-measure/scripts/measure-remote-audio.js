// Run in the receiver's Teams tab. Defines __rec(secs) (starts recording the remote <audio>, returns
// at once) and __summary(). Frames above -50 dBFS count as audible.
window.__rec = (secs) => {
  const el = [...document.querySelectorAll('audio')].find(a => a.srcObject);
  const ctx = window.__actx ||= new AudioContext(); ctx.resume();
  const src = ctx.createMediaStreamSource(el.srcObject);
  const an = ctx.createAnalyser(); an.fftSize = 8192; an.smoothingTimeConstant = 0; src.connect(an);
  const hz = ctx.sampleRate / an.fftSize, buf = new Float32Array(an.fftSize), spec = new Float32Array(an.frequencyBinCount);
  const frames = []; window.__frames = frames; window.__recDone = false;
  const t = setInterval(() => {
    an.getFloatTimeDomainData(buf);
    let s = 0; for (let i = buf.length - 2400; i < buf.length; i++) s += buf[i] * buf[i];
    an.getFloatFrequencyData(spec);
    const bin = f => { const k = Math.round(f / hz); return Math.max(spec[k - 1], spec[k], spec[k + 1]); };
    frames.push({ rms: Math.sqrt(s / 2400), hum: bin(50) });
    if (frames.length >= secs * 20) { clearInterval(t); src.disconnect(); window.__recDone = true; }
  }, 50);
  return 'recording';
};
window.__summary = () => {
  const f = window.__frames, db = x => x > 0 ? 20 * Math.log10(x) : -120;
  const loud = f.filter(x => db(x.rms) > -50), quiet = f.filter(x => db(x.rms) <= -50);
  const med = a => a.length ? +[...a].sort((x, y) => x - y)[a.length >> 1].toFixed(1) : null;
  return { frames: f.length, audibleFrac: +(loud.length / f.length).toFixed(2), audibleRmsDb: med(loud.map(x => db(x.rms))),
    quietRmsDb: med(quiet.map(x => db(x.rms))), hum50DbWhileAudible: med(loud.map(x => x.hum).filter(Number.isFinite)),
    hum50DbWhileQuiet: med(quiet.map(x => x.hum).filter(Number.isFinite)) };
};
'ready';
