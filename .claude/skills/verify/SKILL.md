---
name: verify
description: Verify a change to this repo (Call Bridge server/operator app in server/, Teams Call Answerer extension in teams-auto-answer/) by running it live - local server, operator app, and a real Teams meeting between the Eric and Sisu Chrome profiles - and capturing what each side sees and hears. Use for /verify or "check that X works" in this project.
---

# Verifying changes in this repo

Verification here is a live Teams run, not `npm test`. The surfaces are:

| Change in | Surface | Observe |
|---|---|---|
| `server/server.js` | HTTP + WebSocket on :8787 | `curl` routes and headers, server log (`preview_logs`) |
| `server/public/*` (operator app) | the app page at `http://localhost:8787/` | its UI state, preview, what Eric receives |
| `teams-auto-answer/*` (extension) | Sisu's Teams tab and Eric's Teams tab | buttons, tiles, People panel, received audio/video |

## Setup (see `teams-test-setup` for details)

1. Scope: `git diff HEAD --stat` plus `git status --short` (most work here is uncommitted).
2. Server: `preview_start {name: "bridge-server"}` (token `local-dev-token-not-secret`). Restart it
   after editing `server.js` or adding files to `server/public/` (the `STATIC` map).
3. Browsers via Claude in Chrome, chosen by **deviceId** (names change): Sisu = Jason's profile with
   the extension, Eric = Eric Lee. Both are on this computer and reach `localhost`.
4. Extension edits: the user reloads it in `chrome://extensions`. That reloads every Teams tab, so
   Sisu must rejoin. A tab that hasn't reloaded runs stale code.
5. Operator app: open `http://localhost:8787/` in a tab in **Eric's** browser (it has a camera and
   mic and no Background Noise Remover). The built-in browser pane has no camera.

## The run (see `teams-meeting-test`)

1. Eric: open the meeting link, "Join meeting from this browser", then **Join now**. If the launcher
   stalls, open https://teams.live.com/v2/ and use the meeting chat's **Join**.
2. Sisu: same. On pre-join, mouse-click the camera on: it must flip back off within about 3 s.
3. Eric: **Admit**. In People, Jason must show **Unmuted**.
4. App: make `media.getUserMedia` return a 440 Hz oscillator, then click **Take call**.
5. Eric: read the 440 Hz bin of the remote `<audio>` (`teams-media-measure` scripts). Expect about
   -28 dB.
6. App **Mute**: Eric shows Jason Muted and the tone gone. **Unmute**: both back.
7. App: pick a background, then **Take full control (camera)**. Eric sees the person over that
   background. Sisu's self-view (`data-tid="calling-stream"`) shows the same video, `transform: none`.
8. App **Stop camera**: Eric sees Jason's avatar. Sisu's Teams camera is off with no `<video>`.

## Probes worth doing

- Sisu: press Teams' own Mute with the mouse. It's switched back within about 3 s, and the app's audio continues.
- Sisu: turn Teams' camera on while the app's camera is off. It's switched back off.
- Switch background while sending: `preview-corner-color.js` differs per choice.
- Not Headset: on this PC no camera mic is visible to Chrome, so expect the "No camera microphone was
  found" message and the headset kept.
- Server: `/backgrounds/../server.js` gives 404, and `HEAD /` gives 404 (static files are GET only).

## Gotchas

- A scripted `.click()` doesn't toggle Teams' pre-join switches. Use a real click (`computer` with a `ref`).
- Teams labels lag about 1-3 s after a click. Sample state every 500 ms rather than once.
- Sisu's Chrome has Background Noise Remover. Its own wrapper shows up as a non-native `getUserMedia`; that is expected.
- After the run: release the call in the app and reload the app tab, to drop the test tone override.
