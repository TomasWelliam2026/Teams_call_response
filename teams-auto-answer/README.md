# Teams Call Answerer

A Chrome / Edge extension (Manifest V3) for the **Teams computer**: it links Teams web to your Call Bridge
server, so calls are answered and talked on from the **Call Bridge app** on another computer
(the server and the app are in [`../server`](../server/README.md)).

- Every Teams call that rings here also rings in the app. **Answer** / **Decline** there presses Teams' own button here.
- Once a call is answered (in the app, by a person clicking Teams' Accept here, or by joining a meeting), the
  call's audio streams to the server and on to the app, and the app's microphone goes to the caller in
  place of this computer's.
- **Mute**, **camera control** and **End call** in the app act on Teams here.

It shows nothing but its connection settings: everything about calls is recorded in the server's log.

> Works with Teams **in the browser** only (teams.microsoft.com, teams.cloud.microsoft, teams.live.com).
> The Teams desktop app can't load browser extensions.

## Install

1. Open `chrome://extensions` (or `edge://extensions`).
2. Turn on **Developer mode**.
3. Click **Load unpacked** and select this `teams-auto-answer` folder.
4. Open Teams in a tab (Teams tabs that were already open reload by themselves).
5. In the Teams tab, allow the microphone when the browser asks, so a permission prompt never holds up a call.

## Connecting to the server

Click the extension's toolbar icon: its side panel opens on the right. Enter the **Server URL**
(`wss://your-server/call`) and the **Access token** (`BRIDGE_TOKEN` from `server\.env` on the server; see
**Server URL and tokens** in [`server/README.md`](../server/README.md)). That's the whole setup: the
extension connects as soon as both are valid, and the status shows **Not set up**, **Connecting…**,
**Connected** or **Disconnected** (with the reason; it keeps retrying).
The token is stored only on this computer (`chrome.storage.local`), not synced.

**Setting up a Teams computer without typing secrets:** put a `bridge-config.json` next to `manifest.json`:

```json
{ "serverUrl": "wss://your-server/call", "token": "<BRIDGE_TOKEN>" }
```

The extension applies it when it's installed or reloaded. The file is git-ignored because it holds a secret.

## What happens on a call

The bridge starts when a person answers: **Answer in the Call Bridge app**, or a click on **Teams' own
Accept button** here. A click the extension makes by itself never starts it, and Decline doesn't either.
**Meetings** have no ring: the bridge starts when Teams' in-call toolbar (Leave + Mic) appears, however
the meeting was joined.

- Everything you'd hear from the caller goes to the server as 16 kHz mono PCM.
- What the server sends back replaces this computer's microphone in the call.
- **Mute is shared.** Mute in the app presses Teams' **Mute mic** here, and Teams' Mute here mutes the
  bridge and shows in the app. If this computer has no microphone, the app's Mute alone decides.
- **Take full control (camera)** in the app puts that computer's camera into the call in place of this
  one's, and turns Teams' Camera button on (and back off, if the extension turned it on).
- **End call** in the app presses Teams' Leave/Hang up here; **Hand back to Teams computer** only stops
  the bridge, and this computer's microphone goes back into the call.

The bridge stops, and Teams gets its microphone back, when the call ends or the app hands it back.
Connection drops of up to a minute, including a server restart, don't lose any audio: the last minute is
kept and sent again (see the server README, "No audio lost").

> **Consent.** The bridge sends other people's voices to a server. In many places, including several US states and the EU,
> everyone on the call must be told, or must agree, before a call is recorded or relayed. Your organization's Teams policy
> may also forbid it. Tell callers, for example with a greeting from the server, and check the rules that apply to you.

## How it works

`page-audio.js` runs in Teams' own page context from the first moment, to see the WebRTC connections
Teams creates. It does nothing until armed. Then it reads every incoming audio track
(`MediaStreamTrackProcessor`), resamples it to 16 kHz, and swaps the outgoing microphone track
(`RTCRtpSender.replaceTrack`) for one that plays the server audio (`MediaStreamTrackGenerator`, which needs
no click in the page), on every connection of the call, including ones Teams adds mid-call. When Teams
moves a call to another media server, it briefly carries the same audio on two connections; the extension
recognizes the copies by their loudness pattern and plays them once, switching to the new connection
during a pause, so nothing is doubled or cut. What it notices is sent to the server log.

`content.js` finds ringing calls, presses Teams' buttons for the app, relays the audio to the background
worker (which holds the WebSocket, `bridge.js`), and decides *when* to arm: a trusted press on a detected
call's Accept button (`personAnswered()`), the app answering (`remote-answer`), or, for a meeting,
`checkMeetingJoin()` noticing the in-call toolbar. A 1:1 call's Leave button is `data-tid="hangup-button"`;
a meeting's is `"hangup-main-btn"`, and as a participant (not the organizer) it has only its label; a
meeting's Mic/Camera buttons also drop `data-tid`. So `callUiActive()` pairs the Leave button with a second,
tid-based signal (`[data-tid="microphone-button"], [data-tid="camera-button"], [data-tid="myself-video-more-menu"]`)
to confirm it's really a call toolbar. It re-checks every scan until the bridge is up, so it also
self-heals if the bridge drops while the meeting continues.

Camera control travels over a direct WebRTC connection to the app (signaled through the server), which
needs the server's TURN relay (`server/turn-server.js`) to cross networks; see
[`server/README.md`](../server/README.md#camera-control). `page-audio.js` answers that offer and swaps the
app's camera into the call's video sender, forcing the transceiver to `sendrecv` first if Teams had it
`recvonly` or hadn't negotiated video at all. Stopping puts back the previous track and direction (a `null`
track alone would leave the far end showing a frozen frame).

**Detecting a ringing call.** Teams' markup changes often, so the extension doesn't rely on class names.
It looks for visible buttons whose accessible name (`aria-label`, `title`, `data-tid` or text) looks like
*accept/answer (audio/video)* or *decline*, then walks up from each to a small container (a few buttons,
short text) that mentions an incoming call ("Incoming call from …", "… is calling you", a `data-tid` with
`call-toast`). This keeps it from pressing other "Accept" buttons, such as meeting invites or file transfers.

## Files

| File | Purpose |
|---|---|
| `manifest.json` | Permissions and content-script matches |
| `detector.js` | Finds ringing calls and their Accept/Decline buttons (no Chrome APIs) |
| `content.js` | Runs in Teams: reports rings, presses buttons for the app, arms the bridge, shares mute/camera, relays audio |
| `page-audio.js` | Runs in the page's own context: reads the call's audio, swaps the mic track, answers camera-control offers |
| `bridge.js` | WebSocket client for the server (also used by the server's tests) |
| `background.js` | The always-on link to the server, the bridge connections, keeps Teams tabs from being put to sleep |
| `panel.*` | Side panel: server URL, access token and connection status |
| `test/` | A mock Teams page plus a `chrome.*` API shim for testing without Teams |

## Testing without Teams

```bash
node test/serve.js 8765
```

Open `http://localhost:8765/test/mock-teams.html`. The page runs the real `detector.js`, `content.js`,
`page-audio.js` and `bridge.js` against fake call notifications and decoy "Accept" buttons. Answering starts
a WebRTC loopback call: the caller sends a 440 Hz tone and the local mic is a 220 Hz tone.

To test the bridge, start the server with `FALLBACK=echo BRIDGE_TOKEN=local-dev-token-not-secret PORT=8787 node ../server/server.js` and run:

```js
__bridgeConfig = { serverUrl: 'ws://localhost:8787/call', token: 'local-dev-token-not-secret' };
__ringFluent('Jane Doe');
const ring = __sentToBackground.find(m => m.type === 'call-detected');
await __sendToContent({ type: 'remote-answer', ringId: ring.ringId, action: 'audio' });   // what the app's Answer does
await __callerHears(2000);   // bridged: echo440 loud, mic220 silent
```

Then `__switchServer()`, `__closeOld()`, `__addOtherSpeaker()` and `__speak(seconds)` simulate Teams moving
the call to another media server, another participant, and speech; `__out` records the loudness of every
frame the extension hands on, `__notes` what it noticed. To test camera control without a camera, play the
app's part with a canvas instead of `getUserMedia`, using the same unpatched `window.__NativePC` the mock's
own caller uses:

```js
const canvas = document.createElement('canvas'); canvas.width = canvas.height = 64;
setInterval(() => canvas.getContext('2d').fillRect(0, 0, 64, 64), 100); // any changing pixels
const opPc = new window.__NativePC();
opPc.addTransceiver(canvas.captureStream(15).getVideoTracks()[0], { direction: 'sendonly' });
opPc.onicecandidate = (e) => e.candidate && __tcaPort.postMessage({ type: 'video-ice', callId: 'cam-test', candidate: e.candidate.toJSON() });
const offer = await opPc.createOffer(); await opPc.setLocalDescription(offer);
__tcaPort.postMessage({ type: 'video-offer', callId: 'cam-test', sdp: offer.sdp });
// then feed opPc the resulting video-answer/video-ice messages the same way __tcaPort delivers them
```

## Limitations

- The Teams tab must stay open and signed in. If calls stop ringing in the app, turn off the browser's
  Memory Saver for Teams.
- The extension can't click Windows notifications, only the call UI inside the Teams page.
  Teams web shows that UI even when its tab is in the background.
- Ring detection matches English Teams labels. Another language needs the patterns in `detector.js` extended.
- The audio bridge relies on Teams web using standard WebRTC in the page.
- Camera control adds a video transceiver to an audio-only call and counts on Teams renegotiating on its
  own in response. Meeting join, camera control and End call are verified against a real Teams meeting.
