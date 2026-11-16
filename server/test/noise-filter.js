// Runs the app's capture-worklet.js the way Chrome does (48 kHz, 128-sample blocks) with the real
// rnnoise.wasm: noise alone must come out as silence with the filter on, and unchanged with it off.
// Run: npm test   (after smoke.js)
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

const PUBLIC = path.join(__dirname, '..', 'public');
const RATE = 48000;

function worklet(processorOptions, rate = RATE) {
  let Processor;
  const posted = [];
  vm.runInNewContext(fs.readFileSync(path.join(PUBLIC, 'capture-worklet.js'), 'utf8'), {
    sampleRate: rate, WebAssembly, Float32Array, Uint8Array, Math, Error, String,
    AudioWorkletProcessor: class { constructor() { this.port = { postMessage: (m) => posted.push(m) }; } },
    registerProcessor: (name, cls) => { Processor = cls; },
  });
  const node = new Processor({ processorOptions });
  return {
    node,
    report: () => posted.find((m) => !(m instanceof Float32Array)),
    feed(input) {
      posted.length = posted.indexOf(this.report()) + 1; // keep only the report
      for (let i = 0; i + 128 <= input.length; i += 128) node.process([[input.subarray(i, i + 128)]]);
      return posted.filter((m) => m instanceof Float32Array);
    },
  };
}

let seed = 1;
const noise = (secs, level) => new Float32Array(RATE * secs).map(() => level * (((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648) * 2 - 1));
const loud = (batches) => batches.filter((b) => b.some((v) => v !== 0)).length;
const wasm = fs.readFileSync(path.join(PUBLIC, 'rnnoise.wasm'));
const bytes = wasm.buffer.slice(wasm.byteOffset, wasm.byteOffset + wasm.length);

const on = worklet({ denoise: true, rnnoise: bytes });
assert.strictEqual(on.report().denoiser, true);
let out = on.feed(noise(5, 0.08));
assert.strictEqual(out.length, 250, '5 s comes out as 250 batches of 20 ms');
assert.strictEqual(loud(out), 0, 'noise alone is silenced with the filter on');
console.log('ok  noise filter: 5 s of loud noise alone comes out as silence');

on.node.port.onmessage({ data: { denoise: false } });
const input = noise(1, 0.08);
out = on.feed(input);
assert.strictEqual(loud(out), out.length, 'switched off mid-call, the microphone passes unchanged');
assert.deepStrictEqual(out[1], input.subarray(960, 1920));
console.log('ok  noise filter: switched off mid-call, the microphone passes through unchanged');

const odd = worklet({ denoise: true, rnnoise: bytes }, 44100).report();
assert.strictEqual(odd.denoiser, false);
console.log('ok  noise filter: reports when it cannot run (not 48 kHz)');
console.log('\nnoise filter tests passed');
