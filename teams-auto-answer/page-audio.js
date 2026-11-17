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
  let options = {};    // { iceServers } for camera control, from the server
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

  // ---- Teams' media comes from the relay, not from this computer's devices --------------------
  // This computer's camera and microphones aren't used: what goes out is the server's audio and the
  // Call Bridge app's camera. The extension answers Teams' camera/microphone requests itself:
  //  - Audio: a near-silent Web Audio track, so Teams sets up sending audio at once. The bridge
  //    then puts the server's audio on Teams' audio sender in its place (original logic), so the
  //    server's audio goes out unprocessed, past Teams' own microphone processing. The extension
  //    adds no processing of its own.
  //  - Video: black placeholder frames, replaced on Teams' sender by the Call Bridge app's camera.
  // Teams always gets an answer at once, so it always sets up sending audio and video.
  const placeholderTracks = new Set();

  function placeholderVideoTrack(video) {
    const want = typeof video === 'object' ? video : {};
    const pick = (v, d) => (typeof v === 'number' ? v : v?.ideal ?? v?.exact ?? v?.max ?? d);
    const width = pick(want.width, 640), height = pick(want.height, 360);
    const canvas = document.createElement('canvas');
    canvas.width = width; canvas.height = height;
    const g = canvas.getContext('2d');
    const paint = () => { g.fillStyle = '#000'; g.fillRect(0, 0, width, height); };
    paint();
    const track = canvas.captureStream(pick(want.frameRate, 15)).getVideoTracks()[0];
    const timer = setInterval(() => { // a canvas only emits frames when drawn
      if (track.readyState === 'ended') { clearInterval(timer); placeholderTracks.delete(track); } else paint();
    }, 200);
    placeholderTracks.add(track);
    return track;
  }

  let hub = null; // { ctx, input, dest } once Teams first asks for a microphone

  /** The relay hub: server audio in (input), one audio track out (dest), at 48 kHz. */
  function relayHub() {
    if (hub && hub.ctx.state !== 'closed') return hub;
    const ctx = new AudioContext({ sampleRate: 48000 });
    const input = new GainNode(ctx);
    const dest = ctx.createMediaStreamDestination();
    input.connect(dest);
    // Inaudible dither (about -90 dBFS) between calls, so the track is never digital zeros, which
    // Teams (and noise removers) read as a dead microphone.
    const noise = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
    const d = noise.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = (Math.random() - 0.5) * 6e-5;
    const dither = new AudioBufferSourceNode(ctx, { buffer: noise, loop: true });
    dither.connect(dest);
    dither.start();
    const resume = () => ctx.resume().catch(() => {});
    resume();
    // Chrome keeps an AudioContext suspended until the page has been interacted with.
    for (const ev of ['pointerdown', 'keydown']) addEventListener(ev, resume, { capture: true });
    hub = { ctx, input, dest };
    return hub;
  }

  function relayAudioTrack() {
    return relayHub().dest.stream.getAudioTracks()[0].clone();
  }

  const nativeGetUserMedia = MediaDevices.prototype.getUserMedia;
  function relayGetUserMedia(constraints = {}) {
    const { audio, video } = constraints || {};
    if (!audio && !video) return nativeGetUserMedia.call(this, constraints); // let Chrome report the error
    try {
      const tracks = [];
      if (audio) tracks.push(relayAudioTrack());
      if (video) tracks.push(placeholderVideoTrack(video));
      return Promise.resolve(new MediaStream(tracks));
    } catch (err) {
      return Promise.reject(err);
    }
  }
  // On the prototype, so Teams' requests (and anything that wraps getUserMedia) get these tracks.
  MediaDevices.prototype.getUserMedia = relayGetUserMedia;

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

  // Every <audio>/<video> given a stream (Teams plays the call's audio through these, attached to the
  // page or not), so the bridge can silence this computer's speakers; see silenceSpeakers().
  const players = new Set();
  const ownPlayers = new WeakSet(); // the receiver's own muted elements
  const srcObjectDesc = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'srcObject');
  Object.defineProperty(HTMLMediaElement.prototype, 'srcObject', {
    configurable: true,
    enumerable: true,
    get() { return srcObjectDesc.get.call(this); },
    set(stream) {
      srcObjectDesc.set.call(this, stream);
      if (!stream || ownPlayers.has(this)) return;
      players.add(this);
      bridge?.silenceSpeakers();
    },
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
      timer: setTimeout(disarm, ARM_TIMEOUT_MS), // no call audio appeared: this frame doesn't hold the call
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
      bridge = createBridge(callId, fresh.length ? preexisting : new Set());
      bridge.sync();
      post({ type: 'started', callId });
    } catch {
      bridge = null; // this browser can't process call audio (needs Chrome or Edge 94+)
    }
  }

  // ---- The bridge: one answered call ------------------------------------------------------

  function createBridge(callId, ignore) {
    const engine = trackEngine();
    const toFrames = framer((pcm) => post({ type: 'audio', pcm }, [pcm]));
    // The incoming audio also clocks the outgoing (see trackEngine).
    const receiver = createReceiver((samples) => { toFrames(samples); engine.tick(); }, (message) => post({ type: 'note', message }));
    const injected = new Map(); // sender -> original track
    const peers = new Set();
    const startedAt = Date.now();
    const watch = setInterval(checkEnded, 1000);

    /** Swaps `transceiver`'s outgoing track for `outTrack` (defaults to the audio engine's). Kind-agnostic:
     * also used for the operator's camera (see startVideo below), which just passes a video track.
     * `settled`: the connection is up, so its direction may be changed (not while Teams is negotiating it). */
    function inject(transceiver, outTrack = engine.outTrack, settled = true) {
      const sender = transceiver.sender;
      if (!injected.has(sender)) injected.set(sender, nativeTrackGetter.call(sender)); // Teams' own track, put back at the end
      // "recvonly" (no mic/camera on this computer, or video never negotiated) would have the sender
      // drop every packet; sendrecv lets the bridge's track actually reach the call.
      if (settled && transceiver.direction !== 'sendrecv' && transceiver.direction !== 'sendonly') {
        try { transceiver.direction = 'sendrecv'; } catch { /* transceiver stopped */ }
      }
      if (nativeTrackGetter.call(sender) === outTrack) return;
      nativeReplaceTrack.call(sender, outTrack).catch((err) => post({ type: 'note', message: `Could not replace the ${outTrack.kind}: ${err.message}` }));
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

    // ---- Self view: this computer's Teams shows what the caller sees -----------------------------
    // Teams' own preview of "you" plays the local camera, so while the operator's camera goes out
    // instead it would show something the caller never sees. Each such <video> is pointed at the
    // operator's track for as long as it's sent, unmirrored like the caller's view, and given back
    // to Teams afterwards. Checked on a timer too, since Teams re-renders it (layout or view changes).
    const selfViews = new Map(); // <video> -> { original, ours, transform, priority }
    let selfViewTimer = null;

    function remoteTracks() {
      const tracks = new Set();
      for (const pc of pcs) {
        try { pc.getReceivers().forEach(r => r.track && tracks.add(r.track)); } catch { /* closed */ }
      }
      return tracks;
    }

    function showSelfView() {
      if (!operatorVideoTrack) return;
      const remote = remoteTracks();
      for (const v of document.querySelectorAll('video')) {
        const entry = selfViews.get(v);
        if (entry && v.srcObject === entry.ours) continue;
        const tracks = v.srcObject?.getVideoTracks?.() || [];
        // Only Teams' local preview: a video with no track that comes from the call (other people).
        if (!tracks.length || tracks.some(t => remote.has(t) || t === operatorVideoTrack)) continue;
        const ours = new MediaStream([operatorVideoTrack]);
        selfViews.set(v, {
          original: v.srcObject, // Teams' own (or a newer one it set since)
          ours,
          transform: entry ? entry.transform : v.style.getPropertyValue('transform'),
          priority: entry ? entry.priority : v.style.getPropertyPriority('transform'),
        });
        v.srcObject = ours;
        v.style.setProperty('transform', 'none', 'important'); // Teams mirrors its preview; the caller sees it unmirrored
        v.play().catch(() => {});
      }
    }

    function restoreSelfViews() {
      clearInterval(selfViewTimer);
      selfViewTimer = null;
      for (const [v, { original, ours, transform, priority }] of selfViews) {
        if (v.srcObject === ours) v.srcObject = original;
        if (transform) v.style.setProperty('transform', transform, priority);
        else v.style.removeProperty('transform');
        if (v.srcObject) v.play().catch(() => {});
      }
      selfViews.clear();
    }

    function applyVideo() {
      if (!operatorVideoTrack) return;
      showSelfView();
      selfViewTimer ??= setInterval(showSelfView, 500);
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
        post({ type: 'note', message: `Could not start the camera: ${err.message}` });
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
      restoreSelfViews();
      // A null track alone leaves the far end showing a frozen last frame (no "track ended" signal
      // reaches it): also put the transceiver's direction back so the m-line actually goes inactive.
      for (const [sender, { transceiver, originalDirection }] of videoTransceivers) {
        nativeReplaceTrack.call(sender, injected.get(sender) ?? null).catch(() => {});
        if (transceiver.direction !== originalDirection) transceiver.direction = originalDirection;
      }
      videoTransceivers.clear();
      reportVideoState();
      if (reason) post({ type: 'note', message: `Camera: ${reason}` });
    }

    // ---- Speakers: the caller is heard in the Call Bridge app, not here --------------------------
    // Otherwise this computer plays the caller too, and anyone near both hears every word twice.
    // Only the volume of Teams' players goes to 0: they keep playing, so Chrome keeps delivering the
    // call's audio to the receiver (muting the whole tab stops that after a few seconds). Checked on
    // every sync too, in case Teams sets a volume itself; put back when the bridge stops.
    const silenced = new Map(); // element -> its volume before

    function silenceSpeakers() {
      if (stopped) return;
      for (const el of new Set([...players, ...document.querySelectorAll('audio, video')])) {
        const stream = el.srcObject;
        if (!stream) { players.delete(el); continue; }
        if (ownPlayers.has(el) || !stream.getAudioTracks?.().length) continue;
        if (!silenced.has(el)) silenced.set(el, el.volume);
        if (el.volume !== 0) el.volume = 0;
      }
    }

    function restoreSpeakers() {
      for (const [el, volume] of silenced) if (el.volume === 0) el.volume = volume;
      silenced.clear();
    }

    /** Picks up the call's connections, including ones Teams adds mid-call (moving to another media
     * server, renegotiation): their incoming audio is read and their microphone replaced right away. */
    function sync() {
      if (stopped) return;
      silenceSpeakers();
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
      restoreSpeakers();
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
      silenceSpeakers,
      owns: (sender) => injected.has(sender),
      originalOf: (sender) => injected.get(sender) ?? null,
      setOriginal: (sender, track) => injected.set(sender, track),
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
      ownPlayers.add(el);
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

  /**
   * The outgoing track, made with MediaStreamTrackGenerator: it needs no click in the page (unlike
   * Web Audio), so it works on an unattended Teams computer. The server's audio goes out on a steady
   * 20 ms clock (ticked by the call's incoming audio, a timer as backup), so network jitter doesn't
   * reach the caller; silence fills any gap.
   */
  function trackEngine() {
    if (!window.MediaStreamTrackGenerator) throw new Error('This browser cannot make an audio track here.');
    const generator = new MediaStreamTrackGenerator({ kind: 'audio' });
    const writer = generator.writable.getWriter();
    const queue = playout();
    const silence = new Float32Array(FRAME);
    let muted = false;
    let startedAt = 0;
    let written = 0;   // frames
    let timestamp = 0; // µs, must only grow

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
