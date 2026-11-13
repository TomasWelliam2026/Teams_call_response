// Runs in the Teams page's own JavaScript world ("world": "MAIN") at document_start, so it can
// see the RTCPeerConnections Teams creates. Until content.js says a call was answered it only
// records which connections exist. Once a call's audio is flowing it:
//   - reads the call's incoming audio with every voice exactly once (see createReceiver), resamples
//     it to 16 kHz PCM and hands it to content.js
//   - swaps the microphone track Teams sends for a track that plays the server's audio, on every
//     connection of the call, including ones Teams adds mid-call
// When the call or the bridge ends, Teams' own microphone track is put back.
// Camera control (independent of the above, can start/stop at any point in the call): on
// 'video-offer' it answers a WebRTC connection to the operator app and, once that connection's
// camera track arrives, swaps it in as the call's outgoing video the same way — see startVideo().
(() => {
  if (window.__tcaPageAudio || !window.RTCPeerConnection) return;
  window.__tcaPageAudio = true;

  const RATE = 16000;            // wire format: PCM16 mono 16 kHz
  const FRAME = 320;             // 20 ms at 16 kHz
  const FRAME_S = FRAME / RATE;
  const ARM_TIMEOUT_MS = 30000;  // after "answer", wait this long for call audio to appear
  const PREFER_NEW_MS = 3000;     // after "answer", prefer a connection that wasn't already up this long
  const RECENT_MS = 2000;         // a connection that came up this shortly before "answer" counts as new
  const START_BUFFER_S = 0.25;   // playback jitter buffer for server audio (over two WAN hops, 80 ms was too thin and caused cutouts)
  const CATCHUP_S = 0.6;         // more server audio waiting than this (after a hiccup or reconnect): leave out pauses to catch up
  const MAX_BACKLOG_S = 20;      // only beyond this much waiting is audio with speech in it dropped
  const QUIET_RMS = 0.004;       // a 20 ms frame quieter than this is a pause

  const NativePC = window.RTCPeerConnection;
  const nativeReplaceTrack = RTCRtpSender.prototype.replaceTrack;
  const pcs = new Set();
  const connectedAt = new WeakMap(); // pc -> when it first reached "connected"
  let port = null;     // MessagePort to content.js
  let options = { keepMic: false };
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
        if (armed) tryStart(); else bridge?.sync();
      });
      // A connection Teams adds mid-call (moving the call to another media server) gets the bridge's
      // audio as soon as Teams gives it a microphone, not up to a second later.
      pc.addEventListener('negotiationneeded', () => bridge?.sync());
      pc.addEventListener('signalingstatechange', () => bridge?.sync());
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

  /** While bridged: every open connection with audio, including ones Teams is still setting up. */
  function audioPeers() {
    for (const pc of pcs) if (!isOpen(pc)) pcs.delete(pc);
    return [...pcs].filter(pc => audioSenders(pc).length);
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
    const toFrames = framer((pcm) => post({ type: 'audio', pcm }, [pcm]));
    // The incoming audio also clocks the outgoing (see trackEngine).
    const receiver = createReceiver((samples) => { toFrames(samples); engine.tick(); }, (message) => post({ type: 'note', message }));
    const injected = new Map(); // sender -> original track
    const peers = new Set();
    const startedAt = Date.now();
    const watch = setInterval(checkEnded, 1000);

    function setOriginal(sender, track) {
      injected.set(sender, track);
      engine.setMic(sender, options.keepMic && track?.readyState === 'live' ? track : null);
    }

    /** Swaps `transceiver`'s outgoing track for `outTrack` (defaults to the audio engine's). Kind-agnostic:
     * also used for the operator's camera (see startVideo below), which just passes a video track.
     * `settled`: the connection is up, so its direction may be changed (not while Teams is negotiating it). */
    function inject(transceiver, outTrack = engine.outTrack, settled = true) {
      const sender = transceiver.sender;
      const firstTime = !injected.has(sender);
      if (firstTime) {
        // Only audio senders feed the mic-mixing engine; a video sender has nothing to mix.
        if (outTrack.kind === 'audio') setOriginal(sender, nativeTrackGetter.call(sender));
        else injected.set(sender, nativeTrackGetter.call(sender));
      }
      // "recvonly" (no mic/camera on this computer, or video never negotiated) would have the sender
      // drop every packet; sendrecv lets the bridge's track actually reach the call.
      if (settled && transceiver.direction !== 'sendrecv' && transceiver.direction !== 'sendonly') {
        try { transceiver.direction = 'sendrecv'; } catch { /* transceiver stopped */ }
      }
      if (nativeTrackGetter.call(sender) === outTrack) return;
      nativeReplaceTrack.call(sender, outTrack).catch((err) => post({ type: 'log', message: `Could not replace the ${outTrack.kind}: ${err.message}` }));
    }

    // ---- Camera control: the operator's camera, received over a separate WebRTC connection to the
    // operator app (signaled through content.js/the server), injected into the call the same way as
    // the mic-bridge audio above. Independent of audio: can start or stop at any point in the call.
    let vpc = null;              // RTCPeerConnection to the operator app, receiving its camera only
    let operatorVideoTrack = null;
    const videoTransceivers = new Map(); // sender -> { transceiver, originalDirection }, so stopVideo() reverts only these
    let reportedVideoActive = null; // last 'video-state' sent, so content.js can sync Teams' own camera button

    function reportVideoState() {
      const active = !!operatorVideoTrack;
      if (active === reportedVideoActive) return;
      reportedVideoActive = active;
      post({ type: 'video-state', active });
    }

    function applyVideo() {
      if (!operatorVideoTrack) return;
      for (const pc of peers) {
        const t = videoTransceiver(pc) || pc.addTransceiver('video', { direction: 'sendrecv' });
        if (!videoTransceivers.has(t.sender)) videoTransceivers.set(t.sender, { transceiver: t, originalDirection: t.direction });
        inject(t, operatorVideoTrack);
      }
      reportVideoState();
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
      // A null track alone leaves the far end showing a frozen last frame (no "track ended" signal
      // reaches it): also put the transceiver's direction back so the m-line actually goes inactive.
      for (const [sender, { transceiver, originalDirection }] of videoTransceivers) {
        nativeReplaceTrack.call(sender, injected.get(sender) ?? null).catch(() => {});
        if (transceiver.direction !== originalDirection) transceiver.direction = originalDirection;
      }
      videoTransceivers.clear();
      reportVideoState();
      if (reason) post({ type: 'log', message: reason });
    }

    /** Picks up the call's connections, including ones Teams adds mid-call (moving to another media
     * server, renegotiation): their incoming audio is read and their microphone replaced right away. */
    function sync() {
      if (stopped) return;
      for (const pc of audioPeers()) {
        if (ignore.has(pc)) continue;
        peers.add(pc);
        remoteAudio(pc).forEach(t => receiver.add(t));
        audioSenders(pc).forEach(t => inject(t, engine.outTrack, isConnected(pc)));
      }
      receiver.prune(); // closing a connection ends its tracks without an 'ended' event
      applyVideo(); // a newly-synced peer (or a late Teams video transceiver) also gets the camera
    }

    function checkEnded() {
      for (const pc of peers) if (!isOpen(pc)) peers.delete(pc);
      // Not ended just because the remote side went quiet: a caller on mute sends no audio either.
      // A connection Teams created but never started ("new") doesn't keep the call alive.
      if (![...peers].some(pc => pc.connectionState !== 'new')) return stop('Call ended.');
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
      receiver.close();
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
      info: () => ({ peers: peers.size, ...receiver.info(), senders: injected.size, video: !!operatorVideoTrack, ...engine.info }),
    };
    return self;
  }

  // ---- Incoming: the call's audio, every voice exactly once ----------------------------------
  // Teams can carry the same audio on two connections at once: when it moves a call to another media
  // server (a call turning into a meeting, a network change) it brings the new connection up before
  // it closes the old one. Mixing both would play every word twice, slightly out of step; dropping
  // one too early would lose audio. So every incoming track is read, and its loudness pattern is
  // compared with the others': tracks that carry the same audio are copies, and only one copy is
  // played — the newest, switched to at a pause. Tracks that carry different audio are all mixed. If
  // the copy being played stalls or ends, another copy takes over at once.
  const STALL_MS = 150;          // a track that delivered nothing for this long has stalled
  const HISTORY = 150;           // loudness kept per track: 150 x 20 ms = 3 s
  const MIN_COMPARE = 50;        // a track needs 1 s of loudness history before it's compared
  const MAX_LAG = 15;            // copies may be up to 15 x 20 ms = 300 ms apart
  const MIN_OVERLAP = 40;
  const SAME_AUDIO = 0.9;        // loudness patterns this alike (correlation) are copies of one audio
  const MIN_SPREAD = 0.25;       // a pattern flatter than this (log10 loudness) has no speech to compare
  const COMPARE_EVERY = 10;      // frames (200 ms)
  const SPEECH_RMS = 0.02;
  const MAX_SWITCH_WAIT_MS = 4000; // switch to the newer copy at a pause, or after this long anyway
  const MAX_QUEUE = 25 * FRAME;  // a track can't run more than 0.5 s ahead of the others

  function createReceiver(emit, note) {
    if (!window.MediaStreamTrackProcessor) {
      throw new Error('This browser cannot read call audio here. Use a current version of Chrome or Edge.');
    }
    const sources = new Map(); // MediaStreamTrack -> source (see add)
    const playing = new Map(); // group -> the source being played for that group of copies
    const pending = new Map(); // group -> { to, since }: a newer copy waiting for a pause to take over
    let order = 0;
    let frames = 0;

    function add(track) {
      if (sources.has(track) || track.readyState !== 'live') return;
      // Keeps Chrome decoding the track even after Teams stops playing it (an old connection),
      // so a copy never goes silent before the switch to the next one.
      const el = new Audio();
      el.muted = true;
      el.srcObject = new MediaStream([track]);
      el.play().catch(() => {});
      const s = {
        track, el, n: ++order, group: order,
        reader: new MediaStreamTrackProcessor({ track }).readable.getReader(),
        queue: [],       // 16 kHz samples not yet played
        env: [],         // loudness (RMS) per 20 ms, newest last
        sq: 0, sqN: 0,   // the 20 ms of loudness being measured
        lastData: 0,
        speech: 0,       // frames in a row this unplayed copy had speech the played one didn't
      };
      sources.set(track, s);
      track.addEventListener('ended', () => drop(track), { once: true });
      read(s);
    }

    function drop(track) {
      const s = sources.get(track);
      if (!s) return;
      sources.delete(track);
      s.reader.cancel().catch(() => {});
      s.el.srcObject = null;
      if (playing.get(s.group) === s) playing.delete(s.group);
    }

    async function read(s) {
      const filters = [];
      let resample = null;
      let rate = 0;
      for (;;) {
        let chunk;
        try { chunk = await s.reader.read(); } catch { break; }
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
          for (const v of resample(mono)) {
            s.queue.push(v);
            s.sq += v * v;
            if (++s.sqN === FRAME) {
              s.env.push(Math.sqrt(s.sq / FRAME));
              if (s.env.length > HISTORY) s.env.shift();
              s.sq = s.sqN = 0;
            }
          }
          s.lastData = performance.now();
        } finally {
          data.close();
        }
        if (sources.get(s.track) === s) pump();
      }
    }

    const live = (s, now) => now - s.lastData < STALL_MS;
    const newest = (list) => list.reduce((a, b) => (b.n > a.n ? b : a));

    /** Loudness of the next `FRAME` samples a source would play. */
    function nextRms(s) {
      const n = Math.min(FRAME, s.queue.length);
      let sum = 0;
      for (let i = 0; i < n; i++) sum += s.queue[i] * s.queue[i];
      return n ? Math.sqrt(sum / n) : 0;
    }

    /** One source per group of copies: the one already playing, or the newest once there's a pause. */
    function choose(now) {
      const groups = new Map();
      for (const s of sources.values()) {
        if (!groups.has(s.group)) groups.set(s.group, []);
        groups.get(s.group).push(s);
      }
      const chosen = [];
      for (const [group, members] of groups) {
        const flowing = members.filter(s => live(s, now));
        if (!flowing.length) { playing.delete(group); continue; }
        let current = playing.get(group);
        const best = newest(flowing);
        if (!current || !flowing.includes(current)) {
          if (current) note('The connection being played stopped delivering audio; carried on with another copy of it.');
          current = best;
          pending.delete(group);
        } else if (best !== current) {
          let p = pending.get(group);
          if (p?.to !== best) pending.set(group, p = { to: best, since: now });
          const pause = nextRms(current) < QUIET_RMS && nextRms(best) < QUIET_RMS;
          if (pause || now - p.since > MAX_SWITCH_WAIT_MS) {
            note(`Teams moved the call's audio to a newer connection; switched to it ${pause ? 'during a pause' : 'after 4 s without a pause'}.`);
            current = best;
            pending.delete(group);
          }
        } else {
          pending.delete(group);
        }
        playing.set(group, current);
        chosen.push(current);
      }
      return chosen;
    }

    /** Mixes and emits 20 ms frames while every source being played has one ready. */
    function pump() {
      for (;;) {
        const now = performance.now();
        const chosen = choose(now);
        if (!chosen.length || chosen.some(s => s.queue.length < FRAME)) break;
        const out = new Float32Array(FRAME);
        for (const s of chosen) for (let i = 0; i < FRAME; i++) out[i] += s.queue[i];
        for (const s of sources.values()) {
          if (!chosen.includes(s)) checkStillCopy(s, now);
          s.queue.splice(0, Math.min(FRAME, s.queue.length)); // copies not played keep pace, so a switch picks up in step
        }
        emit(out);
        if (++frames % COMPARE_EVERY === 0) compare(now);
      }
      for (const s of sources.values()) if (s.queue.length > MAX_QUEUE) s.queue.splice(0, s.queue.length - MAX_QUEUE);
    }

    /** Safety net: an unplayed "copy" with speech while the played one has none isn't a copy. Play it too. */
    function checkStillCopy(s, now) {
      const played = playing.get(s.group);
      if (!played || played === s || !live(s, now)) return;
      const recent = played.env.slice(-(2 * MAX_LAG + 1));
      s.speech = nextRms(s) > SPEECH_RMS && Math.max(0, ...recent) < QUIET_RMS * 2 ? s.speech + 1 : 0;
      if (s.speech < 3) return;
      s.group = ++order;
      s.speech = 0;
      note('Two connections that seemed to carry the same audio differ after all: playing both.');
    }

    /** Finds tracks that carry the same audio and makes them one group of copies. */
    function compare(now) {
      const ready = [...sources.values()].filter(s => live(s, now) && s.env.length >= MIN_COMPARE);
      for (let i = 0; i < ready.length; i++) {
        for (let j = i + 1; j < ready.length; j++) {
          const a = ready[i];
          const b = ready[j];
          if (a.group === b.group) continue;
          const m = similarity(a.env, b.env);
          if (!m || m.corr < SAME_AUDIO) continue;
          const keep = Math.min(a.group, b.group);
          const gone = Math.max(a.group, b.group);
          for (const s of sources.values()) if (s.group === gone) s.group = keep;
          // Until the switch at a pause, play the copy the older group was playing.
          if (!playing.has(keep) && playing.has(gone)) playing.set(keep, playing.get(gone));
          playing.delete(gone);
          note(`Teams carried the same audio on two connections (${Math.abs(m.lag) * 20} ms apart): playing it once.`);
        }
      }
    }

    return {
      add,
      prune() { for (const track of [...sources.keys()]) if (track.readyState === 'ended') drop(track); },
      info() {
        const groups = new Set([...sources.values()].map(s => s.group)).size;
        return { remoteTracks: sources.size, copies: sources.size - groups };
      },
      close() { for (const track of [...sources.keys()]) drop(track); },
    };
  }

  /** Best correlation of two loudness histories within ±MAX_LAG frames, or null if either has no speech to compare. */
  function similarity(x, y) {
    const n = Math.min(x.length, y.length, HISTORY);
    const a = x.slice(-n).map(v => Math.log10(v + 1e-3));
    const b = y.slice(-n).map(v => Math.log10(v + 1e-3));
    if (spread(a) < MIN_SPREAD || spread(b) < MIN_SPREAD) return null;
    let best = null;
    for (let lag = -MAX_LAG; lag <= MAX_LAG; lag++) {
      const from = Math.max(0, -lag);
      const to = Math.min(n, n - lag);
      if (to - from < MIN_OVERLAP) continue;
      let sa = 0, sb = 0, saa = 0, sbb = 0, sab = 0;
      for (let i = from; i < to; i++) {
        const p = a[i], q = b[i + lag];
        sa += p; sb += q; saa += p * p; sbb += q * q; sab += p * q;
      }
      const m = to - from;
      const va = saa - sa * sa / m;
      const vb = sbb - sb * sb / m;
      const corr = va > 0 && vb > 0 ? (sab - sa * sb / m) / Math.sqrt(va * vb) : 0;
      if (!best || corr > best.corr) best = { corr, lag };
    }
    return best;
  }

  function spread(values) {
    const mean = values.reduce((s, v) => s + v, 0) / values.length;
    return Math.sqrt(values.reduce((s, v) => s + (v - mean) ** 2, 0) / values.length);
  }

  // ---- Outgoing: the server's audio into the call ------------------------------------------

  const toFloat = (pcm) => {
    const samples = new Int16Array(pcm);
    const f = new Float32Array(samples.length);
    for (let i = 0; i < samples.length; i++) f[i] = samples[i] / 0x8000;
    return f;
  };

  function isQuiet(f) {
    let sum = 0;
    for (let i = 0; i < f.length; i++) sum += f[i] * f[i];
    return Math.sqrt(sum / f.length) < QUIET_RMS;
  }

  /** Web Audio engine: server audio (+ optionally the real mic) -> mute gain -> one track. Returns
   * null if Chrome won't run audio here yet (no click in the page). */
  async function webAudioEngine() {
    const ctx = new AudioContext();
    if (ctx.state !== 'running') {
      await Promise.race([ctx.resume(), new Promise(r => setTimeout(r, 300))]);
      if (ctx.state !== 'running') { ctx.close(); return null; }
    }
    const out = ctx.createMediaStreamDestination();
    const outGain = new GainNode(ctx, { gain: 1 });
    outGain.connect(out);
    const mics = new Map(); // sender -> MediaStreamAudioSourceNode
    let nextTime = 0;

    return {
      outTrack: out.stream.getAudioTracks()[0],
      info: { engine: 'webaudio', sampleRate: ctx.sampleRate },
      setMic(sender, track) {
        mics.get(sender)?.disconnect();
        mics.delete(sender);
        if (!track) return;
        const mic = ctx.createMediaStreamSource(new MediaStream([track]));
        mic.connect(outGain);
        mics.set(sender, mic);
      },
      play(pcm) {
        const f = toFloat(pcm);
        if (!f.length) return;
        const now = ctx.currentTime;
        if (nextTime < now + 0.01) nextTime = now + START_BUFFER_S;
        const ahead = nextTime - now;
        // Behind after a hiccup or a reconnect: catch up by leaving out pauses, never speech.
        if ((ahead > CATCHUP_S && isQuiet(f)) || ahead > MAX_BACKLOG_S) return;
        const buf = ctx.createBuffer(1, f.length, RATE);
        buf.copyToChannel(f, 0);
        const src = new AudioBufferSourceNode(ctx, { buffer: buf });
        src.connect(outGain);
        src.start(nextTime);
        nextTime += buf.duration;
      },
      tick() {},
      setMuted(muted) {
        outGain.gain.setValueAtTime(muted ? 0 : 1, ctx.currentTime);
      },
      close() {
        for (const m of mics.values()) m.disconnect();
        out.stream.getAudioTracks()[0].stop();
        ctx.close();
      },
    };
  }

  /**
   * Track engine: MediaStreamTrackGenerator makes the outgoing track. Unlike Web Audio it runs without
   * a click in the page, so it works on an unattended Teams computer. The server's audio goes out on
   * a steady 20 ms clock (ticked by the call's incoming audio, a timer as backup), so network jitter
   * doesn't reach the caller; silence fills any gap. "Also send my microphone" isn't mixed in this mode.
   */
  function trackEngine() {
    if (!window.MediaStreamTrackGenerator) {
      throw new Error('The browser blocked audio processing on this page. Click anywhere in Teams once, then answer again.');
    }
    const generator = new MediaStreamTrackGenerator({ kind: 'audio' });
    const writer = generator.writable.getWriter();
    const queue = playout();
    const silence = new Float32Array(FRAME);
    let muted = false;
    let startedAt = 0;
    let written = 0;   // frames
    let timestamp = 0; // µs, must only grow
    if (options.keepMic) post({ type: 'log', message: 'Answered without a click on the Teams computer: "Also send my microphone" is off for this call.' });

    function write(f) {
      const data = new AudioData({ format: 'f32-planar', sampleRate: RATE, numberOfFrames: f.length, numberOfChannels: 1, timestamp, data: f });
      timestamp += Math.round(f.length * 1e6 / RATE);
      writer.write(data).catch(() => {});
    }

    function tick() {
      const now = performance.now();
      startedAt ||= now;
      let due = Math.floor((now - startedAt) / (FRAME_S * 1000)) - written;
      if (due > 50) { written += due - 50; due = 50; } // the page was frozen: don't flood the call afterwards
      for (; due > 0; due--, written++) {
        const f = queue.next();
        write(!f || muted ? silence : f);
      }
    }
    const timer = setInterval(tick, 20);

    return {
      outTrack: generator,
      info: { engine: 'tracks' },
      setMic() {},
      play(pcm) { queue.push(toFloat(pcm)); },
      tick,
      setMuted(value) { muted = value; },
      close() {
        clearInterval(timer);
        writer.close().catch(() => {});
        generator.stop();
      },
    };
  }

  /** Server audio waiting to go into the call, in 20 ms frames. Starts START_BUFFER_S deep (again after
   * running dry); with more than CATCHUP_S waiting it leaves out pauses, never speech, unless the
   * backlog passes MAX_BACKLOG_S. */
  function playout() {
    const frames = [];
    let primed = false;
    return {
      push(f) {
        frames.push(f);
        if (frames.length * FRAME_S > MAX_BACKLOG_S) frames.shift();
      },
      next() {
        if (!primed) {
          if (frames.length * FRAME_S < START_BUFFER_S) return null;
          primed = true;
        }
        if (!frames.length) { primed = false; return null; }
        while (frames.length * FRAME_S > CATCHUP_S && isQuiet(frames[0])) frames.shift();
        return frames.shift();
      },
    };
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
