// AudioWorklet for console.js: hands the microphone to the page in ~20 ms batches from the audio
// thread, so a busy or background window delays the batches but never loses any.
// Noise filter: given the bytes of rnnoise.wasm (processorOptions.rnnoise) and a 48 kHz context, it
// first removes background noise with RNNoise (a small speech-trained neural network), then a gate
// silences everything between words, so the caller hears only the voice. On/off with
// port.postMessage({ denoise }). It reports once, as { denoiser: true } or { denoiser: false, error }.
const FRAME = 480;      // RNNoise works on 10 ms frames at 48 kHz
const VOICE = 0.5;      // RNNoise's chance that a frame holds speech, above which the gate opens
const HOLD = 30;        // frames (300 ms) the gate stays open after the last speech, so word endings aren't cut
const WARMUP = 80;      // frames (800 ms) at the start with the gate shut: RNNoise takes up to ~0.5 s to learn the room's noise
const OPEN_STEP = 1 / 96;    // gate fades in over 2 ms...
const CLOSE_STEP = 1 / 2400; // ...and out over 50 ms, so it never clicks

/** RNNoise from Jitsi's build (@jitsi/rnnoise-wasm 0.2.1), loaded without its Emscripten wrapper. */
class Denoiser {
  constructor(bytes) {
    let memory;
    const env = {
      a(size) { // emscripten_resize_heap
        try { memory.grow(Math.ceil((size - memory.buffer.byteLength) / 65536)); return 1; } catch { return 0; }
      },
      b(dest, src, num) { new Uint8Array(memory.buffer).copyWithin(dest, src, src + num); }, // emscripten_memcpy_big
    };
    const x = new WebAssembly.Instance(new WebAssembly.Module(bytes), { a: env }).exports;
    memory = x.c;
    x.d(); // static constructors
    this.memory = memory;
    this.process = x.j; // rnnoise_process_frame(state, out, in) -> chance of speech
    this.state = x.f(0); // rnnoise_create(default model)
    this.ptr = x.g(FRAME * 4); // malloc
  }

  /** Denoises one frame in place; returns the chance (0-1) that it holds speech. */
  run(frame) {
    let heap = new Float32Array(this.memory.buffer, this.ptr, FRAME);
    for (let i = 0; i < FRAME; i++) heap[i] = frame[i] * 32768; // RNNoise expects 16-bit sample values
    const voice = this.process(this.state, this.ptr, this.ptr);
    heap = new Float32Array(this.memory.buffer, this.ptr, FRAME);
    for (let i = 0; i < FRAME; i++) frame[i] = heap[i] / 32768;
    return voice;
  }
}

registerProcessor('capture', class extends AudioWorkletProcessor {
  constructor({ processorOptions = {} } = {}) {
    super();
    this.size = Math.round(sampleRate / 50);
    this.buf = new Float32Array(this.size);
    this.n = 0;
    this.frame = new Float32Array(FRAME);
    this.f = 0;
    this.on = !!processorOptions.denoise;
    this.gain = 0;
    this.hold = 0;
    this.frames = 0;
    if (processorOptions.rnnoise) {
      try {
        if (sampleRate !== 48000) throw new Error(`needs 48 kHz audio, got ${sampleRate} Hz`);
        this.denoiser = new Denoiser(processorOptions.rnnoise);
        this.port.postMessage({ denoiser: true });
      } catch (err) {
        this.port.postMessage({ denoiser: false, error: err.message || String(err) });
      }
    }
    this.port.onmessage = (e) => { this.on = !!e.data.denoise; };
  }

  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (ch) {
      for (let i = 0; i < ch.length; i++) {
        this.frame[this.f++] = ch[i];
        if (this.f === FRAME) { this.filter(this.frame); this.f = 0; }
      }
    }
    return true;
  }

  /** One 10 ms frame: noise filter (when on), then into the 20 ms batches for the page. */
  filter(frame) {
    if (this.on && this.denoiser) {
      const voice = this.denoiser.run(frame);
      const warm = ++this.frames > WARMUP;
      this.hold = warm && voice >= VOICE ? HOLD : Math.max(0, this.hold - 1);
      const target = this.hold > 0 ? 1 : 0;
      for (let i = 0; i < FRAME; i++) {
        this.gain = target > this.gain ? Math.min(1, this.gain + OPEN_STEP) : Math.max(0, this.gain - CLOSE_STEP);
        frame[i] *= this.gain;
      }
    }
    for (let i = 0; i < FRAME; i++) {
      this.buf[this.n++] = frame[i];
      if (this.n === this.size) {
        this.port.postMessage(this.buf, [this.buf.buffer]);
        this.buf = new Float32Array(this.size);
        this.n = 0;
      }
    }
  }
});
