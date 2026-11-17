// Worker half of the camera background effect (see background-effect.js), built the way Teams web
// builds its own: the camera's frames arrive here as VideoFrames from a MediaStreamTrackProcessor,
// are segmented on the GPU in this worker, composited, and written to a MediaStreamTrackGenerator
// whose track is what the call sends. Nothing touches the page's main thread, so a busy or hidden
// window doesn't stutter the video.
//
// Messages in:  {type:'start', readable, writable, settings, image?}  (streams transferred)
//               {type:'settings', settings, image?}   image: ImageBitmap or null to keep the old one
//               {type:'stop'}
// Messages out: {type:'ready'} once the segmenter has loaded, or {type:'failed', message}

const VENDOR = '/vendor/mediapipe/';
const BLUR_PX = 14;
const FEATHER_PX = 2;   // softens the cut-out edge so hair doesn't look clipped
const SMOOTHING = 0.5;  // share of the previous frame's mask kept, which stops edges flickering

let segmenter = null;
let settings = { mode: 'none' };
let image = null;
let reader = null;

let out, ctx, person, pctx, mask, mctx, maskData, prevMask;

async function loadSegmenter() {
  const { ImageSegmenter } = await import(`${VENDOR}vision_bundle.mjs`);
  const fileset = { wasmLoaderPath: `${VENDOR}vision_wasm_internal.js`, wasmBinaryPath: `${VENDOR}vision_wasm_internal.wasm` };
  const options = (delegate) => ({
    baseOptions: { modelAssetPath: `${VENDOR}selfie_segmenter.tflite`, delegate },
    runningMode: 'VIDEO',
    outputConfidenceMasks: true,
    outputCategoryMask: false,
    canvas: new OffscreenCanvas(1, 1), // the GPU delegate's WebGL2 context, since a worker has no DOM
  });
  try {
    return await ImageSegmenter.createFromOptions(fileset, options('GPU'));
  } catch {
    return ImageSegmenter.createFromOptions(fileset, options('CPU'));
  }
}

function size(w, h) {
  if (out?.width === w && out?.height === h) return;
  out = new OffscreenCanvas(w, h); ctx = out.getContext('2d');
  person = new OffscreenCanvas(w, h); pctx = person.getContext('2d');
  mask = new OffscreenCanvas(1, 1); mctx = mask.getContext('2d');
  maskData = null; prevMask = null;
}

/** Draws `img` to fill w x h like CSS object-fit: cover. */
function drawCover(c, img, w, h) {
  const scale = Math.max(w / img.width, h / img.height);
  const dw = img.width * scale, dh = img.height * scale;
  c.drawImage(img, (w - dw) / 2, (h - dh) / 2, dw, dh);
}

let lastTs = -1;
function composite(frame) {
  const w = frame.displayWidth, h = frame.displayHeight;
  size(w, h);
  const mode = settings.mode === 'image' && !image ? 'blur' : settings.mode;

  let ts = frame.timestamp / 1000; // microseconds -> ms
  if (ts <= lastTs) ts = lastTs + 1; // MediaPipe needs strictly increasing timestamps
  lastTs = ts;
  const result = segmenter.segmentForVideo(frame, ts);
  const conf = result.confidenceMasks?.[0];
  if (conf) {
    const values = conf.getAsFloat32Array();
    if (mask.width !== conf.width || mask.height !== conf.height) {
      mask.width = conf.width; mask.height = conf.height; maskData = null; prevMask = null;
    }
    maskData ||= mctx.createImageData(conf.width, conf.height);
    if (!prevMask) prevMask = Float32Array.from(values);
    const px = maskData.data;
    for (let i = 0, j = 3; i < values.length; i++, j += 4) {
      const v = prevMask[i] = prevMask[i] * SMOOTHING + values[i] * (1 - SMOOTHING);
      px[j] = v * 255;
    }
    mctx.putImageData(maskData, 0, 0);
  }
  result.close();

  // Person only: the frame, kept where the (feathered) mask is opaque.
  pctx.globalCompositeOperation = 'copy';
  pctx.filter = 'none';
  pctx.drawImage(frame, 0, 0, w, h);
  pctx.globalCompositeOperation = 'destination-in';
  pctx.filter = `blur(${FEATHER_PX}px)`;
  pctx.drawImage(mask, 0, 0, w, h);

  // Background, then the person on top.
  if (mode === 'blur') {
    ctx.filter = `blur(${BLUR_PX}px)`;
    ctx.drawImage(frame, -BLUR_PX, -BLUR_PX, w + 2 * BLUR_PX, h + 2 * BLUR_PX); // overscan hides blurred edges
  } else {
    ctx.filter = 'none';
    drawCover(ctx, image, w, h);
  }
  ctx.filter = 'none';
  ctx.drawImage(person, 0, 0);
  return new VideoFrame(out, { timestamp: frame.timestamp, duration: frame.duration ?? undefined });
}

async function pump(readable, writable) {
  reader = readable.getReader();
  const writer = writable.getWriter();
  for (;;) {
    const { value: frame, done } = await reader.read().catch(() => ({ done: true }));
    if (done) break;
    if (settings.mode === 'none' || !segmenter) {
      await writer.write(frame).catch(() => frame.close()); // the generator closes the frame it takes
      continue;
    }
    let next;
    try { next = composite(frame); } catch { next = null; }
    frame.close();
    if (next) await writer.write(next).catch(() => next.close());
  }
  writer.close().catch(() => {});
}

self.onmessage = async ({ data }) => {
  if (data.type === 'start') {
    settings = data.settings || settings;
    if (data.image) image = data.image;
    pump(data.readable, data.writable);
    try {
      segmenter = await loadSegmenter();
      self.postMessage({ type: 'ready' });
    } catch (err) {
      self.postMessage({ type: 'failed', message: err.message || String(err) });
    }
  } else if (data.type === 'settings') {
    settings = data.settings;
    if (data.image) { image?.close?.(); image = data.image; }
  } else if (data.type === 'stop') {
    reader?.cancel().catch(() => {});
    segmenter?.close();
    self.close();
  }
};
