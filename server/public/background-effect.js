// Background effect for the camera the app sends into the call ("Take full control (camera)").
//
// Teams' own background setting can't reach the caller in that mode: the extension replaces the
// Teams computer's video with this app's camera, so Teams' processed track never goes out. The
// background is therefore applied here, before the camera leaves this computer.
//
// Same method as Teams web's own background effects (its calling-webcv module): the camera track's
// frames are read with a MediaStreamTrackProcessor, segmented on the GPU in a worker
// (background-worker.js), composited there, and written to a MediaStreamTrackGenerator whose track
// is what gets sent. Teams uses its own WasmCV model; this uses MediaPipe's selfie segmenter
// (served from /vendor/mediapipe, since the page's CSP allows no CDN). Like Teams, it falls back to
// compositing on a canvas in the page (applyOnCanvas) where Chrome lacks those APIs.
//
// window.BackgroundEffect.apply(stream, settings) -> { stream, setSettings(settings), stop() }
//   settings: { mode: 'none' | 'blur' | 'image', image: ImageBitmap | HTMLImageElement | null }

(() => {
  const VENDOR = '/vendor/mediapipe/';
  const BLUR_PX = 14;
  const FEATHER_PX = 2; // softens the cut-out edge so hair doesn't look clipped

  let segmenterPromise = null;

  function loadSegmenter() {
    segmenterPromise ||= (async () => {
      const { ImageSegmenter } = await import(`${VENDOR}vision_bundle.mjs`);
      // Given directly (not via FilesetResolver), so it never picks the no-SIMD build we don't ship.
      const fileset = { wasmLoaderPath: `${VENDOR}vision_wasm_internal.js`, wasmBinaryPath: `${VENDOR}vision_wasm_internal.wasm` };
      const options = (delegate) => ({
        baseOptions: { modelAssetPath: `${VENDOR}selfie_segmenter.tflite`, delegate },
        runningMode: 'VIDEO',
        outputConfidenceMasks: true,
        outputCategoryMask: false,
      });
      try {
        return await ImageSegmenter.createFromOptions(fileset, options('GPU'));
      } catch {
        return ImageSegmenter.createFromOptions(fileset, options('CPU'));
      }
    })();
    segmenterPromise.catch(() => { segmenterPromise = null; }); // let a later attempt retry
    return segmenterPromise;
  }

  /** Draws `img` to fill w x h like CSS object-fit: cover. */
  function drawCover(ctx, img, w, h) {
    const iw = img.width || img.videoWidth, ih = img.height || img.videoHeight;
    const scale = Math.max(w / iw, h / ih);
    const dw = iw * scale, dh = ih * scale;
    ctx.drawImage(img, (w - dw) / 2, (h - dh) / 2, dw, dh);
  }

  async function applyOnCanvas(source, initial = { mode: 'none' }) {
    let settings = { ...initial };
    const srcTrack = source.getVideoTracks()[0];
    const { width = 640, height = 480, frameRate = 15 } = srcTrack.getSettings();

    const video = document.createElement('video');
    video.muted = true;
    video.playsInline = true;
    video.srcObject = new MediaStream([srcTrack]);
    await video.play();

    const out = document.createElement('canvas');
    out.width = width; out.height = height;
    const ctx = out.getContext('2d');
    const person = new OffscreenCanvas(width, height);
    const pctx = person.getContext('2d');
    const mask = new OffscreenCanvas(width, height);
    const mctx = mask.getContext('2d');
    let maskData = null;

    let segmenter = null;
    let failed = false;
    const ready = loadSegmenter().then((s) => { segmenter = s; }, () => { failed = true; });

    let stopped = false;
    let lastTs = -1;

    function render() {
      if (stopped) return;
      if (video.readyState >= 2) {
        const mode = (settings.mode === 'image' && !settings.image) ? 'blur' : settings.mode;
        if (mode === 'none' || !segmenter || failed) {
          ctx.filter = 'none';
          ctx.drawImage(video, 0, 0, width, height);
        } else {
          let ts = performance.now();
          if (ts <= lastTs) ts = lastTs + 1; // MediaPipe needs strictly increasing timestamps
          lastTs = ts;
          const result = segmenter.segmentForVideo(video, ts);
          const conf = result.confidenceMasks?.[0];
          if (conf) {
            const mw = conf.width, mh = conf.height;
            const values = conf.getAsFloat32Array();
            if (mask.width !== mw || mask.height !== mh) { mask.width = mw; mask.height = mh; maskData = null; }
            maskData ||= mctx.createImageData(mw, mh);
            const px = maskData.data;
            for (let i = 0, j = 3; i < values.length; i++, j += 4) px[j] = values[i] * 255;
            mctx.putImageData(maskData, 0, 0);
          }
          result.close();

          // Person only: the frame, kept where the (feathered) mask is opaque.
          pctx.globalCompositeOperation = 'copy';
          pctx.filter = 'none';
          pctx.drawImage(video, 0, 0, width, height);
          pctx.globalCompositeOperation = 'destination-in';
          pctx.filter = `blur(${FEATHER_PX}px)`;
          pctx.drawImage(mask, 0, 0, width, height);

          // Background, then the person on top.
          if (mode === 'blur') {
            ctx.filter = `blur(${BLUR_PX}px)`;
            ctx.drawImage(video, -BLUR_PX, -BLUR_PX, width + 2 * BLUR_PX, height + 2 * BLUR_PX); // overscan hides blurred edges
          } else {
            ctx.filter = 'none';
            drawCover(ctx, settings.image, width, height);
          }
          ctx.filter = 'none';
          ctx.drawImage(person, 0, 0);
        }
      }
      // requestVideoFrameCallback keeps pace with the camera and, unlike requestAnimationFrame,
      // keeps running when this window is in the background or minimised.
      video.requestVideoFrameCallback(render);
    }
    video.requestVideoFrameCallback(render);

    const stream = out.captureStream(frameRate);
    if (settings.mode !== 'none') await ready; // first frames already have the background, if it loads

    return {
      stream,
      get failed() { return failed; },
      setSettings(next) {
        settings = { ...settings, ...next };
        if (settings.mode !== 'none') loadSegmenter().then((s) => { segmenter = s; }, () => { failed = true; });
      },
      stop() {
        stopped = true;
        stream.getTracks().forEach(t => t.stop());
        video.srcObject = null;
      },
    };
  }

  const toBitmap = (img) => (img ? createImageBitmap(img) : Promise.resolve(null));

  /** Teams' method: processor -> worker (segment + composite) -> generator. */
  async function applyInWorker(source, initial = { mode: 'none' }) {
    const settings = { ...initial };
    const srcTrack = source.getVideoTracks()[0];
    const processor = new MediaStreamTrackProcessor({ track: srcTrack });
    const generator = new MediaStreamTrackGenerator({ kind: 'video' });
    const worker = new Worker('background-worker.js');
    let failed = false;
    const ready = new Promise((resolve) => {
      worker.onmessage = ({ data }) => {
        if (data.type === 'failed') { failed = true; console.warn('Background effect unavailable:', data.message); }
        resolve();
      };
      worker.onerror = () => { failed = true; resolve(); };
    });
    const image = await toBitmap(settings.image);
    worker.postMessage(
      { type: 'start', readable: processor.readable, writable: generator.writable, settings: { mode: settings.mode }, image },
      [processor.readable, generator.writable, ...(image ? [image] : [])],
    );
    if (settings.mode !== 'none') await ready; // first frames already have the background, if it loads

    return {
      stream: new MediaStream([generator]),
      get failed() { return failed; },
      async setSettings(next) {
        const imageChanged = 'image' in next && next.image !== settings.image;
        Object.assign(settings, next);
        const bitmap = imageChanged ? await toBitmap(settings.image) : null;
        worker.postMessage({ type: 'settings', settings: { mode: settings.mode }, image: bitmap }, bitmap ? [bitmap] : []);
      },
      stop() {
        worker.postMessage({ type: 'stop' });
        generator.stop();
      },
    };
  }

  const workerSupported = 'MediaStreamTrackProcessor' in window && 'MediaStreamTrackGenerator' in window;

  window.BackgroundEffect = {
    apply: (source, settings) => (workerSupported ? applyInWorker : applyOnCanvas)(source, settings),
    preload: () => (workerSupported ? Promise.resolve() : loadSegmenter()), // the worker loads its own copy
    method: workerSupported ? 'worker' : 'canvas',
  };
})();
