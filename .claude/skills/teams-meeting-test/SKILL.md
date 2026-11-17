---
name: teams-meeting-test
description: Run a live Teams meeting test for this project - Eric hosts a meeting, Sisu (extension) joins, Eric admits, the operator app takes the call and sends its camera with a background, then compare what Eric sees with Sisu's own Teams self-view. Use for testing the camera, backgrounds, self-view or meeting handling.
---

# Live meeting test (Eric hosts, Sisu joins)

Do `teams-test-setup` first. `select_browser` before every switch.

## 1. Meeting link

- If Eric is already in a meeting: expand it, open **People -> Share invite**, and read the join URL
  from the "Share via default email" mailto link (no clipboard needed):
  ```js
  [...document.querySelectorAll('a[href^="mailto"]')].map(a => decodeURIComponent(a.href).match(/https:\/\/teams\.live\.com\/meet\/[^\s"<>]+/)?.[0])
  ```
- Otherwise use **Meet -> Create a meeting link**, or reuse a known link
  `https://teams.live.com/meet/<id>?p=<code>`.
- A meeting ends when everyone has left. Rejoining through the same link starts it again.

## 2. Join

For each of Eric (first) and Sisu:
1. Navigate the Teams tab to the meeting link, click **"Join meeting from this browser"** (`find` it;
   sometimes it needs a second click), and wait about 8 s for the pre-join screen.
2. On **Sisu, keep Teams' own camera off** ("Turn camera off" if it shows), so any video Eric sees can
   only come from the extension.
3. Click **Join now**. Sisu lands in the lobby.
4. **Eric:** `find` "Admit" (toast or People panel) and click it.

## 3. Operator app takes over

In the Sisu browser's operator tab (`http://localhost:8787/`), script it to save round trips:
```js
const sel = document.getElementById('bgMode'); sel.value = 'inTheZone1'; sel.dispatchEvent(new Event('change'));
[...document.querySelectorAll('button')].find(x => /take call/i.test(x.textContent) && !x.disabled)?.click();
await new Promise(r => setTimeout(r, 3000));
document.getElementById('camera').click();   // "Take full control (camera)"
```
Background choices: `none`, `blur`, `inTheZone1`, `inTheZone2`, `starfieldGravJump`.
`BackgroundEffect.method` should be `'worker'` (processor -> worker -> generator, the same method
Teams uses). `'canvas'` means the fallback path.

## 4. Verify

- **Eric:** screenshot. Jason's tile shows the person over the chosen background.
- **Sisu's self-view** (bottom-right "you" tile, `data-tid="calling-stream"`): zoom on it. It must
  match Eric's view: same background, **not mirrored** (check that something one-sided, like a headset
  mic, is on the same side in both). Its `<video>` should have computed `transform: none`.
- **Frame rate / size on Eric:** `video-fps.js` from `teams-media-measure`. Teams adapts the size
  (320x240 is normal for a small tile).
- **Switching:** change `bgMode` while sending and confirm both views follow within about 2 s.
  `preview-corner-color.js` gives an objective check per choice (the corner colour differs for each).
- **Stopping:** click Stop camera. Teams' camera goes back off and the self-view tile disappears.

## Note

- Teams on Sisu gets placeholder tracks from the extension, never real devices:
  `(await navigator.mediaDevices.getUserMedia({audio:true,video:true})).getTracks().map(t=>t.constructor.name)`
  should give `MediaStreamTrackGenerator` and `CanvasCaptureMediaStreamTrack` in a few ms. If audio
  isn't reaching Eric, check Sisu's audio transceiver is `sendrecv`: hook
  `RTCPeerConnection.prototype.getStats` (Teams polls it) to collect the connections.
- Deterministic audio check: in the operator page, make `media.getUserMedia` return an oscillator
  track (440 Hz) before Take call, then read the 440 Hz bin on Eric's remote `<audio>`.
- With the app's camera off, Sisu's Teams camera must be off, from pre-join on (it's switched back
  within about 1-3 s if turned on). Pre-join's camera is `input[data-tid="toggle-video"]`; a scripted
  `.click()` doesn't toggle it, so use a real (mouse) click to test.
- Mute is one-way, app to Teams: in Eric's People panel, Jason must show Unmuted while the app is
  unmuted, Muted while it's muted. Read it from the `[aria-label=Muted|Unmuted]` icon inside Jason's
  treeitem. Pressing Mute in Sisu's Teams is switched back within about 3 s.

- The meeting launcher page sometimes stalls ("Join meeting from this browser" does nothing, with an
  MSAL `empty_response` error). Open https://teams.live.com/v2/ and use the meeting chat's **Join**.

If someone is out of frame, the output is just the background. Check the raw camera
(`camera.raw` in the operator page) before suspecting the segmentation.
