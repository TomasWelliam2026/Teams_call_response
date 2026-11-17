// Run in the operator app tab after it loads and BEFORE "Take call": the app's next getUserMedia
// (audio only) gets speech (/test-speech.wav, see SKILL.md) over fan noise, 50/150 Hz hum and key clicks.
// __tm.speak() plays the clip once and returns its length in seconds.
window.__tm = (() => {
  const ctx = new AudioContext({ sampleRate: 48000 });
  const dest = ctx.createMediaStreamDestination();
  const noiseGain = new GainNode(ctx, { gain: 0.05 }), speechGain = new GainNode(ctx, { gain: 0.5 });
  noiseGain.connect(dest); speechGain.connect(dest);
  const n = ctx.createBuffer(1, ctx.sampleRate * 4, ctx.sampleRate), d = n.getChannelData(0);
  for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  for (let i = 0; i < d.length; i += Math.floor(ctx.sampleRate * (0.15 + Math.random() * 0.4)))
    for (let k = 0; k < 200 && i + k < d.length; k++) d[i + k] += (Math.random() * 2 - 1) * 6 * Math.exp(-k / 30);
  const ns = new AudioBufferSourceNode(ctx, { buffer: n, loop: true });
  ns.connect(new BiquadFilterNode(ctx, { type: 'lowpass', frequency: 4000 })).connect(noiseGain); ns.start();
  for (const [f, g] of [[50, 0.6], [150, 0.3]]) { const o = new OscillatorNode(ctx, { frequency: f }); o.connect(new GainNode(ctx, { gain: g })).connect(noiseGain); o.start(); }
  let speechBuf = null;
  const ready = fetch('/test-speech.wav').then(r => r.arrayBuffer()).then(b => ctx.decodeAudioData(b)).then(b => { speechBuf = b; });
  const speak = () => { const s = new AudioBufferSourceNode(ctx, { buffer: speechBuf }); s.connect(speechGain); s.start(); return speechBuf.duration; };
  const orig = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
  navigator.mediaDevices.getUserMedia = async (c) => (c && c.audio && !c.video)
    ? (await ctx.resume(), new MediaStream(dest.stream.getAudioTracks().map(t => t.clone()))) : orig(c);
  return { ctx, ready, speak, noiseGain, speechGain };
})();
await __tm.ready; 'test mic ready';
