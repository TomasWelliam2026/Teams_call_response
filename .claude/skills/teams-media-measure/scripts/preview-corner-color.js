// Operator app tab while the camera is on: average colour of the preview's top-left corner, a quick
// objective check that the chosen background is the one being sent.
const p = document.getElementById('cameraPreview');
const c = new OffscreenCanvas(64, 48), g = c.getContext('2d'); g.drawImage(p, 0, 0, 64, 48);
const d = g.getImageData(0, 0, 8, 8).data; let r = 0, gg = 0, b = 0;
for (let i = 0; i < d.length; i += 4) { r += d[i]; gg += d[i + 1]; b += d[i + 2]; }
JSON.stringify({ choice: document.getElementById('bgMode').value, rgb: [r / 64 | 0, gg / 64 | 0, b / 64 | 0] });
