// Runs in the Teams page's own JavaScript world ("world": "MAIN") at document_start, so it can
// see the RTCPeerConnections Teams creates. Until content.js says a call was answered it only
// records which connections exist. Once a call's audio is flowing it:
//   - mixes the call's remote audio, resamples it to 16 kHz PCM and hands it to content.js
//   - swaps the microphone track Teams sends for a track that plays the server's audio
// When the call or the bridge ends, Teams' own microphone track is put back.
(() => {
  if (window.__tcaPageAudio || !window.RTCPeerConnection) return;
  window.__tcaPageAudio = true;

  const RATE = 16000;            // wire format: PCM16 mono 16 kHz
  const FRAME = 320;             // 20 ms at 16 kHz
  const ARM_TIMEOUT_MS = 30000;  // after "answer", wait this long for call audio to appear
  const PREFER_NEW_MS = 3000;     // after "answer", prefer a connection that wasn't already up this long
  const RECENT_MS = 2000;         // a connection that came up this shortly before "answer" counts as new
  const START_BUFFER_S = 0.08;   // playback jitter buffer for server audio
  const MAX_AHEAD_S = 0.6;       // drop server audio that would queue beyond this (keeps latency bounded)

  const NativePC = window.RTCPeerConnection;
  const nativeReplaceTrack = RTCRtpSender.prototype.replaceTrack;
  const pcs = new Set();
  const connectedAt = new WeakMap(); // pc -> when it first reached "connected"
  let port = null;     // MessagePort to content.js
  let options = { keepMic: false, workletUrl: '' };
  let armed = null;    // { callId, timer, poll }
  let bridge = null;

  const post = (msg, transfer) => port?.postMessage(msg, transfer || []);

  // ---- Track Teams' peer connections -------------------------------------------------------

  // A Proxy (not a wrapper function) so `class X extends RTCPeerConnection` still gets X's prototype.
  const PeerConnection = new Proxy(NativePC, {
    construct(target, args, newTarget) {
      const pc = Reflect.construct(target, args, newTarget);
      pcs.add(pc);
      pc.addEventListener('track', () => { if (armed) tryStart(); else bridge?.sync(); });
      pc.addEventListener('connectionstatechange', () => {
        if (pc.connectionState === 'connected' && !connectedAt.has(pc)) connectedAt.set(pc, Date.now());
        if (armed) tryStart();
      });
      return pc;
    },
  });
  window.RTCPeerConnection = PeerConnection;
  if (window.webkitRTCPeerConnection) window.webkitRTCPeerConnection = PeerConnection;

  // While a sender carries server audio, Teams' own replaceTrack calls (mute, device switch) only
  // update the track we restore later, so they can't cut the server off mid-call.
  RTCRtpSender.prototype.replaceTrack = function replaceTrack(track) {
    if (!bridge?.owns(this)) return nativeReplaceTrack.call(this, track);
    bridge.setOriginal(this, track);
    return Promise.resolve();
  };

  const isOpen = (pc) => pc.signalingState !== 'closed' && !['closed', 'failed'].includes(pc.connectionState);
  const isConnected = (pc) => pc.connectionState === 'connected' || ['connected', 'completed'].includes(pc.iceConnectionState);
  const remoteAudio = (pc) => pc.getReceivers().map(r => r.track).filter(t => t?.kind === 'audio' && t.readyState === 'live');
  const audioSenders = (pc) => pc.getTransceivers()
    .filter(t => t.receiver.track?.kind === 'audio' && ['sendrecv', 'sendonly'].includes(t.currentDirection || t.direction))
    .map(t => t.sender);

  function callPeers() {
    for (const pc of pcs) if (!isOpen(pc)) pcs.delete(pc);
    return [...pcs].filter(pc => isConnected(pc) && remoteAudio(pc).length);
  }

  // ---- Arming: content.js tells us a call was just answered ---------------------------------

  function arm(callId) {
    disarm();
    armed = {
      callId,
      at: Date.now(),
      // Connections already live before the answer (another call or meeting still open) are only
      // used if no new one shows up; Teams may also connect the call while it is still ringing.
      preexisting: new Set(callPeers().filter(pc => Date.now() - (connectedAt.get(pc) ?? 0) > RECENT_MS)),
      timer: setTimeout(() => {
        disarm();
        if (window === window.top) post({ type: 'failed', callId, reason: 'No call audio appeared within 30 s of answering.' });
      }, ARM_TIMEOUT_MS),
      poll: setInterval(tryStart, 500),
    };
    tryStart();
  }

  function disarm() {
    if (!armed) return;
    clearTimeout(armed.timer);
    clearInterval(armed.poll);
    armed = null;
  }

  async function tryStart() {
    if (!armed || armed.starting) return;
    const peers = callPeers();
    const fresh = peers.filter(pc => !armed.preexisting.has(pc));
    if (!fresh.length && (!peers.length || Date.now() - armed.at < PREFER_NEW_MS)) return;
    armed.starting = true;
    const { callId, preexisting } = armed;
    disarm();
    bridge?.stop('A new call was answered.');
    try {
      bridge = await createBridge(callId, fresh.length ? preexisting : new Set());
      bridge.sync();
      post({ type: 'started', callId, info: bridge.info() });
    } catch (err) {
      bridge = null;
      post({ type: 'failed', callId, reason: err.message });
    }
  }

  // ---- The bridge: audio graph for one call ------------------------------------------------

  async function createBridge(callId, ignore) {
    const ctx = new AudioContext();
    if (ctx.state !== 'running') {
      await Promise.race([ctx.resume(), new Promise(r => setTimeout(r, 1500))]);
      if (ctx.state !== 'running') {
        ctx.close();
        throw new Error('The browser blocked audio processing on this page. Click anywhere in Teams once, then answer again.');
      }
    }

    // Outgoing: server audio (+ optionally the real mic) -> one track that replaces Teams' mic.
    const out = ctx.createMediaStreamDestination();
    const outTrack = out.stream.getAudioTracks()[0];
    const injected = new Map(); // sender -> { original, mic }

    // Incoming: every remote audio track -> mono mix -> anti-alias filter -> tap -> 16 kHz PCM.
    const mix = ctx.createGain();
    Object.assign(mix, { channelCount: 1, channelCountMode: 'explicit', channelInterpretation: 'speakers' });
    const lowpass1 = new BiquadFilterNode(ctx, { type: 'lowpass', frequency: 7000 });
    const lowpass2 = new BiquadFilterNode(ctx, { type: 'lowpass', frequency: 7000 });
    const sink = new GainNode(ctx, { gain: 0 }); // taps only run while connected to the destination
    mix.connect(lowpass1).connect(lowpass2);
    sink.connect(ctx.destination);
    const remotes = new Map(); // track -> { el, src }
    const peers = new Set();
    const toPcm = downsampler(ctx.sampleRate, (pcm) => post({ type: 'audio', pcm }, [pcm]));
    const tapKind = await connectTap(ctx, lowpass2, sink, toPcm);

    let nextTime = 0;
    const startedAt = Date.now();
    const watch = setInterval(checkEnded, 1000);

    function addRemote(track) {
      if (remotes.has(track)) return;
      const stream = new MediaStream([track]);
      // Chrome only feeds remote WebRTC audio into Web Audio while a media element is playing it.
      const el = new Audio();
      el.muted = true;
      el.srcObject = stream;
      el.play().catch(() => {});
      const src = ctx.createMediaStreamSource(stream);
      src.connect(mix);
      remotes.set(track, { el, src });
      track.addEventListener('ended', () => dropRemote(track), { once: true });
    }

    function dropRemote(track) {
      const r = remotes.get(track);
      if (!r) return;
      r.src.disconnect();
      r.el.srcObject = null;
      remotes.delete(track);
    }

    function setOriginal(sender, track) {
      const entry = injected.get(sender);
      entry.mic?.disconnect();
      entry.original = track;
      entry.mic = null;
      if (options.keepMic && track?.readyState === 'live') {
        entry.mic = ctx.createMediaStreamSource(new MediaStream([track]));
        entry.mic.connect(out);
      }
    }

    function inject(sender) {
      if (injected.has(sender)) return;
      injected.set(sender, { original: sender.track, mic: null });
      setOriginal(sender, sender.track);
      nativeReplaceTrack.call(sender, outTrack).catch((err) => post({ type: 'log', message: `Could not replace the microphone: ${err.message}` }));
    }

    /** Picks up the call's connections, including ones Teams adds mid-call (e.g. after renegotiation). */
    function sync() {
      for (const pc of callPeers()) {
        if (ignore.has(pc)) continue;
        peers.add(pc);
        remoteAudio(pc).forEach(addRemote);
        audioSenders(pc).forEach(inject);
      }
    }

    function checkEnded() {
      for (const pc of peers) if (!isOpen(pc)) peers.delete(pc);
      // Not ended just because the remote side went quiet: a caller on mute sends no audio either.
      if (!peers.size) return stop('Call ended.');
      sync();
    }

    function play(pcm) {
      const samples = new Int16Array(pcm);
      if (!samples.length) return;
      const buf = ctx.createBuffer(1, samples.length, RATE);
      const ch = buf.getChannelData(0);
      for (let i = 0; i < samples.length; i++) ch[i] = samples[i] / 0x8000;
      const now = ctx.currentTime;
      if (nextTime < now + 0.01) nextTime = now + START_BUFFER_S;
      if (nextTime > now + MAX_AHEAD_S) return;
      const src = new AudioBufferSourceNode(ctx, { buffer: buf });
      src.connect(out);
      src.start(nextTime);
      nextTime += buf.duration;
    }

    let stopped = false;
    function stop(reason) {
      if (stopped) return;
      stopped = true;
      clearInterval(watch);
      if (bridge === self) bridge = null;
      for (const [sender, entry] of injected) {
        entry.mic?.disconnect();
        nativeReplaceTrack.call(sender, entry.original).catch(() => {}); // fails harmlessly if the call is gone
      }
      for (const track of [...remotes.keys()]) dropRemote(track);
      outTrack.stop();
      ctx.close();
      post({ type: 'stopped', callId, reason, seconds: Math.round((Date.now() - startedAt) / 1000) });
    }

    const self = {
      callId,
      sync,
      play,
      stop,
      owns: (sender) => injected.has(sender),
      setOriginal,
      info: () => ({ peers: peers.size, remoteTracks: remotes.size, senders: injected.size, tap: tapKind, sampleRate: ctx.sampleRate }),
    };
    return self;
  }

  // AudioWorklet keeps resampling off Teams' busy main thread. Teams' CSP blocks blob: modules, so
  // the module comes from the extension (content.js passes its URL). If that is blocked too, fall
  // back to ScriptProcessor (deprecated, but not subject to CSP).
  async function connectTap(ctx, input, sink, onSamples) {
    const size = Math.round(ctx.sampleRate / 50); // 20 ms batches
    try {
      if (!options.workletUrl) throw new Error('no worklet URL');
      await ctx.audioWorklet.addModule(options.workletUrl);
      const node = new AudioWorkletNode(ctx, 'tca-tap', { numberOfInputs: 1, numberOfOutputs: 1, channelCount: 1, channelCountMode: 'explicit', processorOptions: { size } });
      node.port.onmessage = (e) => onSamples(e.data);
      input.connect(node).connect(sink);
      return 'worklet';
    } catch {
      const node = ctx.createScriptProcessor(2048, 1, 1);
      node.onaudioprocess = (e) => onSamples(e.inputBuffer.getChannelData(0));
      input.connect(node).connect(sink);
      return 'script-processor';
    }
  }

  /** Float32 at `fromRate` -> 20 ms Int16 frames at 16 kHz (linear interpolation; input is already low-passed). */
  function downsampler(fromRate, emit) {
    const step = fromRate / RATE;
    let pos = 0;        // read position in the current chunk; -1 means `last`
    let last = 0;       // final sample of the previous chunk
    let frame = new Int16Array(FRAME);
    let filled = 0;
    return (input) => {
      while (pos < input.length - 1) {
        const i = Math.floor(pos);
        const frac = pos - i;
        const a = i < 0 ? last : input[i];
        const s = Math.max(-1, Math.min(1, a + (input[i + 1] - a) * frac));
        frame[filled++] = s < 0 ? s * 0x8000 : s * 0x7fff;
        if (filled === FRAME) { emit(frame.buffer); frame = new Int16Array(FRAME); filled = 0; }
        pos += step;
      }
      pos -= input.length;
      last = input[input.length - 1];
    };
  }

  // ---- Channel to content.js ---------------------------------------------------------------

  function onCommand({ data }) {
    switch (data?.type) {
      case 'config': options = { ...options, ...data.options }; break;
      case 'arm': arm(data.callId); break;
      case 'audio': if (bridge?.callId === data.callId) bridge.play(data.pcm); break;
      case 'stop': disarm(); if (!data.callId || bridge?.callId === data.callId) bridge?.stop(data.reason || 'Stopped.'); break;
    }
  }

  // content.js (isolated world) hands us a MessagePort; a newer one (extension reloaded) replaces the old.
  window.addEventListener('message', (e) => {
    if (e.source !== window || e.data?.__tca !== 'connect' || !e.ports[0]) return;
    port?.close();
    port = e.ports[0];
    port.onmessage = onCommand;
  });
})();
