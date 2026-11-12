// Runs in the Teams page's own JavaScript world ("world": "MAIN") at document_start, so it can
// see the RTCPeerConnections Teams creates. Until content.js says a call was answered it only
// records which connections exist. Once a call's audio is flowing it:
//   - mixes the call's remote audio, resamples it to 16 kHz PCM and hands it to content.js
//   - swaps the microphone track Teams sends for a track that plays the server's audio
// When the call or the bridge ends, Teams' own microphone track is put back.
// Camera control (independent of the above, can start/stop at any point in the call): on
// 'video-offer' it answers a WebRTC connection to the operator app and, once that connection's
// camera track arrives, swaps it in as the call's outgoing video the same way — see startVideo().
(() => {
  if (window.__tcaPageAudio || !window.RTCPeerConnection) return;
  window.__tcaPageAudio = true;

  const RATE = 16000;            // wire format: PCM16 mono 16 kHz
  const FRAME = 320;             // 20 ms at 16 kHz
  const ARM_TIMEOUT_MS = 30000;  // after "answer", wait this long for call audio to appear
  const PREFER_NEW_MS = 3000;     // after "answer", prefer a connection that wasn't already up this long
  const RECENT_MS = 2000;         // a connection that came up this shortly before "answer" counts as new
  const START_BUFFER_S = 0.25;   // playback jitter buffer for server audio (over two WAN hops, 80 ms was too thin and caused cutouts)
  const MAX_AHEAD_S = 1.2;       // drop server audio that would queue beyond this (keeps latency bounded)

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

  // Teams checks sender.track before unmuting; finding our bridge track there instead of its own
  // mic, it refuses ("Teams couldn't unmute"). So while bridged, Teams sees its own track. The
  // bridge track still goes out, because it was set with the native replaceTrack.
  const nativeTrackGetter = Object.getOwnPropertyDescriptor(RTCRtpSender.prototype, 'track').get;
  Object.defineProperty(RTCRtpSender.prototype, 'track', {
    configurable: true,
    enumerable: true,
    get() { return bridge?.owns(this) ? bridge.originalOf(this) : nativeTrackGetter.call(this); },
  });

  const isOpen = (pc) => pc.signalingState !== 'closed' && !['closed', 'failed'].includes(pc.connectionState);
  const isConnected = (pc) => pc.connectionState === 'connected' || ['connected', 'completed'].includes(pc.iceConnectionState);
  const remoteAudio = (pc) => pc.getReceivers().map(r => r.track).filter(t => t?.kind === 'audio' && t.readyState === 'live');
  // Includes a transceiver negotiated "recvonly" (Teams does this when the computer's microphone
  // is muted or missing, which is also why Teams' own Mute button is disabled then). inject() below
  // flips it to sendrecv so the bridge's track actually goes out instead of being silently dropped.
  const audioSenders = (pc) => pc.getTransceivers()
    .filter(t => t.receiver.track?.kind === 'audio' || t.sender.track?.kind === 'audio')
    .map(t => t);
  /** The call's video transceiver, if Teams already negotiated one (e.g. video was on, or it's a meeting). */
  const videoTransceiver = (pc) => pc.getTransceivers()
    .find(t => t.receiver.track?.kind === 'video' || t.sender.track?.kind === 'video');

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

  // ---- The bridge: one answered call ------------------------------------------------------

  async function createBridge(callId, ignore) {
    // Web Audio needs a click in the page first (Chrome's autoplay rule). A call answered from the
    // local app has none, so then the track engine takes over; it needs no click.
    const engine = (await webAudioEngine()) || trackEngine();
    const injected = new Map(); // sender -> original track
    const remotes = new Set();
    const peers = new Set();
    const startedAt = Date.now();
    const watch = setInterval(checkEnded, 1000);

    function addRemote(track) {
      if (remotes.has(track)) return;
      remotes.add(track);
      engine.addRemote(track);
      track.addEventListener('ended', () => { remotes.delete(track); engine.dropRemote(track); }, { once: true });
    }

    function setOriginal(sender, track) {
      injected.set(sender, track);
      engine.setMic(sender, options.keepMic && track?.readyState === 'live' ? track : null);
    }

    /** Swaps `transceiver`'s outgoing track for `outTrack` (defaults to the audio engine's). Kind-agnostic:
     * also used for the operator's camera (see startVideo below), which just passes a video track. */
    function inject(transceiver, outTrack = engine.outTrack) {
      const sender = transceiver.sender;
      const firstTime = !injected.has(sender);
      if (firstTime) {
        // Only audio senders feed the mic-mixing engine; a video sender has nothing to mix.
        if (outTrack.kind === 'audio') setOriginal(sender, sender.track);
        else injected.set(sender, sender.track);
      }
      // "recvonly" (no mic/camera on this computer, or video never negotiated) would have the sender
      // drop every packet; sendrecv lets the bridge's track actually reach the call.
      if (transceiver.direction !== 'sendrecv' && transceiver.direction !== 'sendonly') transceiver.direction = 'sendrecv';
      nativeReplaceTrack.call(sender, outTrack).catch((err) => post({ type: 'log', message: `Could not replace the ${outTrack.kind}: ${err.message}` }));
    }

    // ---- Camera control: the operator's camera, received over a separate WebRTC connection to the
    // operator app (signaled through content.js/the server), injected into the call the same way as
    // the mic-bridge audio above. Independent of audio: can start or stop at any point in the call.
    let vpc = null;              // RTCPeerConnection to the operator app, receiving its camera only
    let operatorVideoTrack = null;
    const videoSenders = new Set(); // senders currently carrying operatorVideoTrack, so stopVideo() reverts only those

    function applyVideo() {
      if (!operatorVideoTrack) return;
      for (const pc of peers) {
        const t = videoTransceiver(pc) || pc.addTransceiver('video', { direction: 'sendrecv' });
        inject(t, operatorVideoTrack);
        videoSenders.add(t.sender);
      }
    }

    async function startVideo(sdp) {
      if (vpc) stopVideo('Replaced by a new camera offer.');
      vpc = new NativePC({ iceServers: options.iceServers || [] });
      vpc.ontrack = (e) => { if (e.track.kind === 'video') { operatorVideoTrack = e.track; applyVideo(); } };
      // RTCIceCandidate itself doesn't survive postMessage to content.js (isolated world); its plain
      // JSON shape does, and addIceCandidate() accepts that shape just as well.
      vpc.onicecandidate = (e) => post({ type: 'video-ice', candidate: e.candidate ? e.candidate.toJSON() : null });
      try {
        await vpc.setRemoteDescription({ type: 'offer', sdp });
        const answer = await vpc.createAnswer();
        await vpc.setLocalDescription(answer);
        post({ type: 'video-answer', sdp: vpc.localDescription.sdp });
      } catch (err) {
        post({ type: 'log', message: `Could not start the camera: ${err.message}` });
        stopVideo('Camera offer failed.');
      }
    }

    function videoIce(candidate) {
      if (candidate) vpc?.addIceCandidate(candidate).catch(() => {});
    }

    function stopVideo(reason) {
      vpc?.close();
      vpc = null;
      operatorVideoTrack = null;
      for (const sender of videoSenders) nativeReplaceTrack.call(sender, injected.get(sender) ?? null).catch(() => {});
      videoSenders.clear();
      if (reason) post({ type: 'log', message: reason });
    }

    /** Picks up the call's connections, including ones Teams adds mid-call (e.g. after renegotiation). */
    function sync() {
      for (const pc of callPeers()) {
        if (ignore.has(pc)) continue;
        peers.add(pc);
        remoteAudio(pc).forEach(addRemote);
        audioSenders(pc).forEach(t => inject(t));
      }
      applyVideo(); // a newly-synced peer (or a late Teams video transceiver) also gets the camera
    }

    function checkEnded() {
      for (const pc of peers) if (!isOpen(pc)) peers.delete(pc);
      // Not ended just because the remote side went quiet: a caller on mute sends no audio either.
      if (!peers.size) return stop('Call ended.');
      sync();
    }

    let stopped = false;
    function stop(reason) {
      if (stopped) return;
      stopped = true;
      clearInterval(watch);
      if (bridge === self) bridge = null;
      stopVideo();
      for (const [sender, original] of injected) {
        nativeReplaceTrack.call(sender, original).catch(() => {}); // fails harmlessly if the call is gone
      }
      engine.close();
      post({ type: 'stopped', callId, reason, seconds: Math.round((Date.now() - startedAt) / 1000) });
    }

    const self = {
      callId,
      sync,
      play: (pcm) => engine.play(pcm),
      setMuted: (muted) => engine.setMuted(muted),
      stop,
      startVideo,
      videoIce,
      stopVideo: () => stopVideo('Stopped from the app.'),
      owns: (sender) => injected.has(sender),
      originalOf: (sender) => injected.get(sender) ?? null,
      setOriginal,
      info: () => ({ peers: peers.size, remoteTracks: remotes.size, senders: injected.size, video: !!operatorVideoTrack, ...engine.info }),
    };
    return self;
  }

  const emitPcm = (pcm) => post({ type: 'audio', pcm }, [pcm]);

  /** Web Audio engine: mixes and resamples in an audio graph. Returns null if Chrome won't run audio here yet. */
  async function webAudioEngine() {
    const ctx = new AudioContext();
    if (ctx.state !== 'running') {
      await Promise.race([ctx.resume(), new Promise(r => setTimeout(r, 300))]);
      if (ctx.state !== 'running') { ctx.close(); return null; }
    }
    // Outgoing: server audio (+ optionally the real mic) -> mute gain -> one track that replaces Teams' mic.
    const out = ctx.createMediaStreamDestination();
    const outGain = new GainNode(ctx, { gain: 1 });
    outGain.connect(out);
    const mics = new Map(); // sender -> MediaStreamAudioSourceNode
    // Incoming: every remote audio track -> mono mix -> anti-alias filter -> tap -> 16 kHz PCM.
    const mix = ctx.createGain();
    Object.assign(mix, { channelCount: 1, channelCountMode: 'explicit', channelInterpretation: 'speakers' });
    const lowpass1 = new BiquadFilterNode(ctx, { type: 'lowpass', frequency: 7000 });
    const lowpass2 = new BiquadFilterNode(ctx, { type: 'lowpass', frequency: 7000 });
    const sink = new GainNode(ctx, { gain: 0 }); // taps only run while connected to the destination
    mix.connect(lowpass1).connect(lowpass2);
    sink.connect(ctx.destination);
    const toFrames = framer(emitPcm);
    const resample = resampler(ctx.sampleRate);
    const tap = await connectTap(ctx, lowpass2, sink, (x) => toFrames(resample(x)));
    const remotes = new Map(); // track -> { el, src }
    let nextTime = 0;

    return {
      outTrack: out.stream.getAudioTracks()[0],
      info: { engine: 'webaudio', tap, sampleRate: ctx.sampleRate },
      addRemote(track) {
        const stream = new MediaStream([track]);
        // Chrome only feeds remote WebRTC audio into Web Audio while a media element is playing it.
        const el = new Audio();
        el.muted = true;
        el.srcObject = stream;
        el.play().catch(() => {});
        const src = ctx.createMediaStreamSource(stream);
        src.connect(mix);
        remotes.set(track, { el, src });
      },
      dropRemote(track) {
        const r = remotes.get(track);
        if (!r) return;
        r.src.disconnect();
        r.el.srcObject = null;
        remotes.delete(track);
      },
      setMic(sender, track) {
        mics.get(sender)?.disconnect();
        mics.delete(sender);
        if (!track) return;
        const mic = ctx.createMediaStreamSource(new MediaStream([track]));
        mic.connect(outGain);
        mics.set(sender, mic);
      },
      play(pcm) {
        const samples = new Int16Array(pcm);
        if (!samples.length) return;
        const buf = ctx.createBuffer(1, samples.length, RATE);
        const ch = buf.getChannelData(0);
        for (let i = 0; i < samples.length; i++) ch[i] = samples[i] / 0x8000;
        const now = ctx.currentTime;
        if (nextTime < now + 0.01) nextTime = now + START_BUFFER_S;
        if (nextTime > now + MAX_AHEAD_S) return;
        const src = new AudioBufferSourceNode(ctx, { buffer: buf });
        src.connect(outGain);
        src.start(nextTime);
        nextTime += buf.duration;
      },
      setMuted(muted) {
        outGain.gain.setValueAtTime(muted ? 0 : 1, ctx.currentTime);
      },
      close() {
        for (const m of mics.values()) m.disconnect();
        for (const track of [...remotes.keys()]) this.dropRemote(track);
        out.stream.getAudioTracks()[0].stop();
        ctx.close();
      },
    };
  }

  /**
   * Track engine: MediaStreamTrackProcessor reads the caller's audio as AudioData and
   * MediaStreamTrackGenerator makes the outgoing track from the server's audio. Unlike Web Audio it
   * runs without a click in the page, so it works on an unattended Teams computer.
   * "Also send my microphone" isn't mixed in this mode.
   */
  function trackEngine() {
    if (!window.MediaStreamTrackProcessor || !window.MediaStreamTrackGenerator) {
      throw new Error('The browser blocked audio processing on this page. Click anywhere in Teams once, then answer again.');
    }
    const generator = new MediaStreamTrackGenerator({ kind: 'audio' });
    const writer = generator.writable.getWriter();
    let timestamp = 0; // µs, must only grow
    let muted = false;
    const remotes = new Map(); // track -> { reader, queue: number[] of 16 kHz samples }
    let primary = null; // the first remote track paces the frames; others are mixed into it
    const toFrames = framer(emitPcm);
    if (options.keepMic) post({ type: 'log', message: 'Answered without a click on the Teams computer: "Also send my microphone" is off for this call.' });

    function mixOut() {
      const lead = remotes.get(primary);
      if (!lead || lead.queue.length < FRAME) return;
      const n = lead.queue.length;
      const mixed = new Float32Array(n);
      for (const r of remotes.values()) {
        for (let i = 0; i < n && i < r.queue.length; i++) mixed[i] += r.queue[i];
        r.queue.splice(0, n);
      }
      toFrames(mixed);
    }

    async function pump(track, entry) {
      const filters = [];
      let resample = null;
      let rate = 0;
      for (;;) {
        let chunk;
        try { chunk = await entry.reader.read(); } catch { break; }
        if (chunk.done) break;
        const data = chunk.value;
        try {
          if (data.sampleRate !== rate) {
            rate = data.sampleRate;
            resample = resampler(rate);
            filters.length = 0;
            filters.push(lowpass(rate, 7000), lowpass(rate, 7000));
          }
          const n = data.numberOfFrames;
          const mono = new Float32Array(n);
          const plane = new Float32Array(n);
          for (let c = 0; c < data.numberOfChannels; c++) {
            data.copyTo(plane, { planeIndex: c, format: 'f32-planar' });
            for (let i = 0; i < n; i++) mono[i] += plane[i] / data.numberOfChannels;
          }
          for (const f of filters) f(mono);
          const out = resample(mono);
          for (let i = 0; i < out.length; i++) entry.queue.push(out[i]);
          if (track !== primary && entry.queue.length > FRAME * 4) entry.queue.splice(0, entry.queue.length - FRAME * 4);
          if (track === primary) mixOut();
        } finally {
          data.close();
        }
      }
    }

    return {
      outTrack: generator,
      info: { engine: 'tracks', tap: 'track-processor' },
      addRemote(track) {
        const entry = { reader: new MediaStreamTrackProcessor({ track }).readable.getReader(), queue: [] };
        remotes.set(track, entry);
        primary ||= track;
        pump(track, entry);
      },
      dropRemote(track) {
        const r = remotes.get(track);
        if (!r) return;
        r.reader.cancel().catch(() => {});
        remotes.delete(track);
        if (primary === track) primary = remotes.keys().next().value || null;
      },
      setMic() {},
      setMuted(value) { muted = value; },
      play(pcm) {
        const samples = new Int16Array(pcm);
        if (!samples.length) return;
        const f32 = new Float32Array(samples.length); // stays silent while muted
        if (!muted) for (let i = 0; i < samples.length; i++) f32[i] = samples[i] / 0x8000;
        const data = new AudioData({ format: 'f32-planar', sampleRate: RATE, numberOfFrames: f32.length, numberOfChannels: 1, timestamp, data: f32 });
        timestamp += Math.round(f32.length * 1e6 / RATE);
        writer.write(data).catch(() => {});
      },
      close() {
        for (const track of [...remotes.keys()]) this.dropRemote(track);
        writer.close().catch(() => {});
        generator.stop();
      },
    };
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

  /** Second-order low-pass (RBJ biquad) that filters a Float32Array in place, keeping state between calls. */
  function lowpass(fs, f0) {
    const w = 2 * Math.PI * f0 / fs;
    const alpha = Math.sin(w) / (2 * Math.SQRT1_2);
    const cos = Math.cos(w);
    const a0 = 1 + alpha;
    const b0 = (1 - cos) / 2 / a0, b1 = (1 - cos) / a0, b2 = b0, a1 = -2 * cos / a0, a2 = (1 - alpha) / a0;
    let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
    return (x) => {
      for (let i = 0; i < x.length; i++) {
        const y = b0 * x[i] + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
        x2 = x1; x1 = x[i]; y2 = y1; y1 = y;
        x[i] = y;
      }
    };
  }

  /** Float32 at `fromRate` -> Float32 at 16 kHz (linear interpolation; input is already low-passed). */
  function resampler(fromRate) {
    const step = fromRate / RATE;
    let pos = 0;   // read position in the current chunk; -1 means `last`
    let last = 0;  // final sample of the previous chunk
    return (input) => {
      const out = [];
      while (pos < input.length - 1) {
        const i = Math.floor(pos);
        const a = i < 0 ? last : input[i];
        out.push(a + (input[i + 1] - a) * (pos - i));
        pos += step;
      }
      pos -= input.length;
      last = input[input.length - 1];
      return out;
    };
  }

  /** Collects 16 kHz float samples into 20 ms Int16 frames. */
  function framer(emit) {
    let frame = new Int16Array(FRAME);
    let filled = 0;
    return (samples) => {
      for (let k = 0; k < samples.length; k++) {
        const s = Math.max(-1, Math.min(1, samples[k]));
        frame[filled++] = s < 0 ? s * 0x8000 : s * 0x7fff;
        if (filled === FRAME) { emit(frame.buffer); frame = new Int16Array(FRAME); filled = 0; }
      }
    };
  }

  // ---- Channel to content.js ---------------------------------------------------------------

  function onCommand({ data }) {
    switch (data?.type) {
      case 'config': options = { ...options, ...data.options }; break;
      case 'arm': arm(data.callId); break;
      case 'audio': if (bridge?.callId === data.callId) bridge.play(data.pcm); break;
      case 'mute': if (bridge?.callId === data.callId) bridge.setMuted(!!data.muted); break;
      case 'stop': disarm(); if (!data.callId || bridge?.callId === data.callId) bridge?.stop(data.reason || 'Stopped.'); break;
      case 'video-offer': if (bridge?.callId === data.callId) bridge.startVideo(data.sdp); break;
      case 'video-ice': if (bridge?.callId === data.callId) bridge.videoIce(data.candidate); break;
      case 'video-stop': if (bridge?.callId === data.callId) bridge.stopVideo(); break;
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
