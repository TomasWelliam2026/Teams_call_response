// Received size and frame rate of the first playing <video> with a stream, over 3 s.
const v = [...document.querySelectorAll('video')].find(x => x.srcObject && x.videoWidth);
let n = 0; const t = performance.now();
await new Promise(r => { const f = () => { n++; performance.now() - t < 3000 ? v.requestVideoFrameCallback(f) : r(); }; v.requestVideoFrameCallback(f); });
JSON.stringify({ size: [v.videoWidth, v.videoHeight], fps: +(n / 3).toFixed(1) });
