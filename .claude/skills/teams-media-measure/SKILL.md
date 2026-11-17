---
name: teams-media-measure
description: Measure what actually reaches the other side of a live Teams call or meeting in this project - inbound audio level and spectrum, WebRTC stats, received video fps, a repeatable test microphone (speech + noise) for the operator app, and how to inspect Teams web's own code. Use when a claim about audio or video quality needs numbers, not a guess.
---

# Measuring Teams media

The snippets live in `scripts/` next to this file. Run them with `javascript_tool` in the tab named.
They're plain JS with top-level `await`. Paste the file's contents as the `text`.

| Script | Run in | Gives |
|---|---|---|
| `hook-pc.js` | receiver's Teams tab, **before** the call connects | collects `window.__pcs` (RTCPeerConnections) |
| `inbound-audio-stats.js` | same tab, during the call | per-second inbound-rtp audio: level, energy, bytes |
| `measure-remote-audio.js` | receiver's Teams tab | defines `__rec(secs)` / `__summary()`: level, silence share, 50 Hz hum |
| `video-fps.js` | any tab with the video | received size and fps over 3 s |
| `test-mic.js` | operator app tab, after load and **before** "Take call" | replaces the mic with speech + fan + hum + clicks; `__tm.speak()` |
| `preview-corner-color.js` | operator app tab | the camera preview's corner colour (checks the background) |

## Audio A/B procedure

1. Receiver (Eric): paste `measure-remote-audio.js`, then call `__rec(18)` (starts recording, returns at once).
2. Operator tab: `__tm.speak()` (12 s clip), with whatever setting is under test.
3. Receiver: `while(!window.__recDone) await new Promise(r=>setTimeout(r,500)); JSON.stringify(__summary())`.
4. Change one thing and repeat. Report a table.

Reading the numbers:
- `quietRmsDb` about -110 to -120 is true silence between words.
- `audibleFrac` is the share of time anything is heard.
- `hum50DbWhileAudible` is the noise left under speech (speech has almost nothing at 50 Hz).

Treat a difference of 2 dB or less as noise.

**Test speech:** `test-mic.js` fetches `/test-speech.wav`. The real server doesn't serve it. Make it
with Windows SAPI into the scratchpad:
```powershell
Add-Type -AssemblyName System.Speech; $s=New-Object System.Speech.Synthesis.SpeechSynthesizer
$f=New-Object System.Speech.AudioFormat.SpeechAudioFormatInfo(16000,'Sixteen','Mono')
$s.SetOutputToWaveFile("<scratchpad>\speech.wav",$f); $s.Speak("Hello Eric, this is a test..."); $s.Dispose()
```
Then serve it with `scripts/test-server.js`: add a temporary `launch.json` entry that runs
`node <skill>/scripts/test-server.js <repo>/server/server.js <scratchpad>/speech.wav` on port 8787.
Use it in place of `bridge-server` and revert `launch.json` afterwards. Its CSP-safe same-origin
route is why: the operator page's CSP only allows `'self'`.

**Real-room check:** when the input itself is very quiet (about -75 dB at the mic), Teams/Opus sends
comfort silence. Low levels at the receiver then aren't caused by our code. Measure the mic too:
`audio.stream` in the operator page.

## Inspecting Teams web itself

Teams' code is in Cache Storage (`teams-precache-v2`), and the resource-timing buffer fills at 250
entries, so search the cache instead of the network log:
```js
for (const k of await caches.keys()) { const c = await caches.open(k);
  for (const q of await c.keys()) { if (!/\.js$/.test(q.url.split('?')[0])) continue;
    const t = await (await c.match(q)).text(); if (t.includes('MediaStreamTrackGenerator')) console.log(q.url.split('/').pop()); } }
```
Strip `? & = %` and URLs from any snippet you return, or the tool blocks the output as query-string
data. Known modules:
- `calling-webcv`: background effects. MediaStreamTrackProcessor, then the WasmCV / TF.js
  segmentation worker, then GPU blur and composite, then MediaStreamTrackGenerator.
- `precompiled-wasmcv-web-worker-inner`: the worker side of that pipeline.

Teams' stock backgrounds are at
`https://statics.teams.cdn.office.net/evergreen-assets/consumerbackgroundimages/<name>.jpg`
(thumbnails use `<name>_thumb.jpg`). Read the names from the Background filters panel's `<img>` alts.
