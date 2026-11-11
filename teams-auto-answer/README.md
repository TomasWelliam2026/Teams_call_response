# Teams Call Answerer (prototype)

A Chrome / Edge extension (Manifest V3) that answers or declines **Microsoft Teams web** calls
without you touching the Teams window:

- **Global shortcuts** that work in any app: answer with audio, answer with video, decline, toggle auto-answer.
- **Auto-answer rules**: ring delay, audio or video, allow list, block list, active hours and days.
- **Side panel** (opens on the right of the browser when you click the toolbar icon) with answer/decline buttons, settings, recent activity and a "Scan Teams tab" diagnostic.
- **Audio bridge** (optional): when you answer a call with Teams' own Answer button, the caller's audio streams to your online server
  and the server's audio is sent to the caller in place of your microphone. The server is in [`../server`](../server/README.md).
- Keeps Teams tabs from being put to sleep so calls aren't missed.

With the bridge off, audio stays entirely inside Teams and the extension only presses Teams' own buttons.

> Works with Teams **in the browser** only (teams.microsoft.com, teams.cloud.microsoft, teams.live.com).
> The Teams desktop app can't load browser extensions.

## Install

1. Open `chrome://extensions` (or `edge://extensions`).
2. Turn on **Developer mode**.
3. Click **Load unpacked** and select this `teams-auto-answer` folder.
4. Open Teams in a tab, then reload that tab once so the extension's script loads.
5. Click the extension's toolbar icon to open its side panel on the right. Pin the icon from the puzzle-piece menu so it's always visible.
   The panel stays open while you switch tabs, so you can keep it next to any page.
6. In the Teams tab, allow microphone (and camera, if you'll answer with video) when the browser asks.
   Do this before relying on auto-answer, because a permission prompt mid-call blocks it.

## Shortcuts

| Action | Default |
|---|---|
| Answer (audio) | Ctrl+Shift+1 |
| Answer (video) | Ctrl+Shift+2 |
| Decline | Ctrl+Shift+3 |
| Auto-answer on/off | Ctrl+Shift+4 |

They're registered as **global**, so they work even when the browser isn't focused (the browser must be running).
Change them at `chrome://extensions/shortcuts`. Make sure the scope says **Global**.
Chrome only allows Ctrl+Shift+0–9 for global shortcuts.

## Audio bridge

1. Deploy the server (see [`server/README.md`](../server/README.md)) and note its URL and `BRIDGE_TOKEN`.
2. In the side panel, under **Audio bridge**, enter the server URL (`wss://your-host/call`) and the access token,
   click **Test connection**, then tick **Stream answered calls to my server**.
3. Reload the Teams tab once, so the extension's audio hook loads before Teams starts.

From then on, the bridge starts when **you click Teams' own Answer button** on a ringing call (or press Enter on it).
Calls answered by the extension (the side panel's Answer buttons, the shortcuts or auto-answer) are not bridged.
Neither is a click on Decline.
When the call's audio connection is up:

- Everything you'd hear from the caller is sent to the server as 16 kHz mono PCM.
- What the server sends back replaces your microphone in the call. Tick **Also send my microphone** to mix your voice in.
- The badge shows **LIVE**, and the side panel shows the caller and duration.

The bridge stops, and Teams gets your microphone back, when the call ends, when you click **Stop bridge**, or when the server stops it.
If the server can't be reached or drops for good, the bridge also stops and your microphone comes back.
The access token is stored only on this computer (`chrome.storage.local`), not synced.

How it works: `page-audio.js` runs in Teams' own page context from the first moment, to see the WebRTC connections Teams creates.
It does nothing until a call is answered. Then it taps the remote audio tracks with Web Audio,
resamples them to 16 kHz, and swaps the outgoing microphone track (`RTCRtpSender.replaceTrack`) for one that plays the server audio.
`content.js` relays the audio to the background worker, which holds the WebSocket (`bridge.js`).

> **Consent.** The bridge sends other people's voices to a server. In many places, including several US states and the EU,
> everyone on the call must be told, or must agree, before a call is recorded or relayed. Your organization's Teams policy
> may also forbid it. Tell callers, for example with a greeting from the server, and check the rules that apply to you.

## Auto-answer rules

The rules are checked in this order:

1. Auto-answer must be on.
2. If the caller matches the **block list**, the call isn't auto-answered.
3. If the **allow list** isn't empty, the caller must match it.
4. If **active hours** are on, the current day and time must be inside them. Overnight ranges such as 22:00–06:00 work.

Names are matched as case-insensitive substrings of the call notification's text.
After **Ring for N seconds**, the extension presses Accept. If the call stopped ringing in the meantime, it does nothing.
In **Video** mode it falls back to audio if there's no video button.
In **Audio** mode it never falls back to video.

## How detection works

Teams' markup changes often, so the extension doesn't rely on class names.
It looks for visible buttons whose accessible name (`aria-label`, `title`, `data-tid` or text) looks like *accept/answer (audio/video)* or *decline*.
It then walks up from each button looking for a small container (a few buttons, short text) that mentions an incoming call.
Examples of matching text: "Incoming call from …", "… is calling you", or a `data-tid` containing `call-toast`.
This keeps it from pressing other "Accept" buttons, such as meeting invites or file transfers.

**If it stops working after a Teams update, or your Teams isn't in English:**

1. Make a test call to yourself from another account.
2. While it rings, open the side panel → **Advanced** → **Scan Teams tab now**.
3. Check `candidates`, which lists every accept/decline-looking button and whether it was recognized as part of a call (`inCallUi`).
4. Add regex overrides in **Advanced**, for example `Annehmen|Accepter` for the accept button and `eingehender Anruf|appel entrant` for the incoming-call text.

## Files

| File | Purpose |
|---|---|
| `manifest.json` | Permissions, content-script matches, global shortcuts |
| `detector.js` | Shared logic: button classification, call detection, rules (no Chrome APIs) |
| `content.js` | Runs in Teams: watches the page, auto-answers, executes shortcut and side panel actions, relays bridge audio |
| `page-audio.js` | Runs in the page's own context: taps call audio and swaps the mic track during a bridge |
| `bridge.js` | WebSocket client for the server, plus base64 helpers (shared by the worker, the content script and tests) |
| `background.js` | Shortcuts, badge (AUTO / RING / LIVE), notifications, activity log, keeps tabs awake, bridge connections |
| `panel.*` | Side panel: settings and manual controls |
| `test/` | A mock Teams page plus a `chrome.*` API shim for testing without Teams |

## Testing without Teams

```bash
node test/serve.js 8765
```

Open `http://localhost:8765/test/mock-teams.html`. The page runs the real `detector.js`, `content.js`, `page-audio.js` and `bridge.js` against fake call notifications and decoy "Accept" buttons.
Answering starts a WebRTC loopback call. The caller sends a 440 Hz tone and the local mic is a 220 Hz tone.

To test the bridge, start the server with `FALLBACK=echo BRIDGE_TOKEN=local-dev-token-not-secret PORT=8787 node ../server/server.js` and run:

```js
__bridgeConfig = { serverUrl: 'ws://localhost:8787/call', token: 'local-dev-token-not-secret' };
chrome.storage.sync.set({ bridgeEnabled: true }); __ringFluent('Jane Doe');   // then click the accept button yourself (a script .click() doesn't start the bridge)
await __callerHears();   // bridged: echo440 loud, mic220 silent. After "Stop bridge" or hang-up: the reverse.
```
To drive it from the browser console:

```js
chrome.storage.sync.set({ enabled: true, delaySec: 1 }); __ringFluent('Jane Doe');   // auto-answers after 1 s
await __sendToContent({ type: 'action', action: 'decline' });                        // what a shortcut does
```

## Limitations

- The Teams tab must stay open and signed in. Turn off the browser's Memory Saver for Teams if the badge never shows RING.
- The extension can't click Windows notifications, only the call UI inside the Teams page.
  Teams web shows that UI even when its tab is in the background.
- Tested against a mock page, not live Teams. Real Teams button labels may need the regex overrides above.
  The audio bridge relies on Teams web using standard WebRTC in the page. If a Teams update moves calling elsewhere, the side panel shows "No call audio appeared".
- Your organization may block Teams web or unapproved extensions. Auto-answering means callers may be connected before you're at the keyboard.
