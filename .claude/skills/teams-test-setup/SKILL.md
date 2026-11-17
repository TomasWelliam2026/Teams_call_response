---
name: teams-test-setup
description: Set up the live two-browser Teams test bench for this project - find the Eric (caller) and Sisu (extension) Chrome profiles in Claude in Chrome, start the local bridge server, point Sisu's extension at it and sign the operator app in. Use before any live Teams call or meeting test, or when a test says "no Teams computer is linked".
---

# Teams test bench setup

The live tests use two Chrome profiles, each signed in to Teams (consumer) at **https://teams.live.com/v2/**
(not teams.microsoft.com, which only shows a sign-in page for these accounts):

| Role | Chrome profile | Teams account | Notes |
|---|---|---|---|
| Caller / meeting organizer | US_Jiangyun | Eric Lee | may be on another computer |
| Teams computer (extension installed) | Sisu | Jason ChanMing | must be on **this** computer for `localhost` |

A third connected browser may also be signed in as Jason. It is **not** Sisu; don't test there.

## 1. Find the browsers

1. Load the Chrome tools in one ToolSearch call (`tabs_context_mcp, navigate, computer, find,
   tabs_create_mcp, list_connected_browsers, select_browser, javascript_tool, browser_batch`).
2. `list_connected_browsers`. The display names ("Browser 1/2/3") are **not stable**: always go by `deviceId`.
3. For each candidate: `select_browser`, open https://teams.live.com/v2/ in a new tab, read the left-rail
   "(You)" entry under Favorites to see whose account it is.
4. Sisu is the Jason browser with `onThisComputer: true`. Confirm by opening `http://localhost:8787/` in
   it: a browser on another computer gets an error page.
5. Note both deviceIds and tabIds; every later step starts with `select_browser`.

## 2. Local bridge server

- Start it with `preview_start {name: "bridge-server"}` (from `.claude/launch.json`): port 8787, token
  `local-dev-token-not-secret`, echo fallback. Never start servers with Bash.
- After changing anything in `server/server.js` or adding a file under `server/public/` (the `STATIC`
  map), restart: `preview_stop` + `preview_start`. Public files are served `no-cache`, so a page reload
  picks up edits to existing files without a restart.
- `curl -s localhost:8787/healthz` shows `teamsComputers` (linked extensions) and `apps` (operator apps).

## 3. Point Sisu's extension at it (user step)

Claude can't open the extension's side panel. Ask the user to set, in Sisu's "Teams Call Answerer"
side panel:
- Server URL: `ws://localhost:8787/call` (ws:// is only accepted for localhost)
- Access token: `local-dev-token-not-secret`

Wait until `/healthz` shows `teamsComputers: 1`. After editing anything in `teams-auto-answer/`, ask the
user to click reload on the extension in `chrome://extensions` (loaded unpacked from this repo).
That reloads every Teams tab, including one in a meeting, so Sisu has to rejoin. A tab that hasn't
reloaded keeps running the old content script, which no longer receives anything from the app: for
example, Sisu stays muted.

When testing is over, remind the user to switch the extension back to their real `wss://` server.

## 4. Operator app

- Open `http://localhost:8787/` **in the Sisu browser** (a new tab). It is the only local Chrome with
  a camera and mic. The desktop app's built-in browser pane refuses camera access.
- Sign in: click the "Operator token" field, type the dev token, click Connect ("Remember" is checked by
  default so reloads reconnect by themselves).
- Ready when it shows "Connected. Waiting for calls." and "Teams computer linked."

## Gotchas

- Sisu's Chrome has the **Background Noise Remover** extension, which (with "always use" on) wraps
  `getUserMedia` and returns a `MediaStreamAudioDestinationNode` track for every audio request. The
  operator app bypasses it (it calls Chrome's own functions from a blank iframe, `media` in
  console.js), so leave BNR on. Test scripts that patch `navigator.mediaDevices.getUserMedia` (such as
  `test-mic.js`) must patch `media.getUserMedia` in the operator page instead.
- This computer's camera mic ("USB2.0 MIC") has no Windows recording endpoint, so Chrome can't see it
  and "Not Headset" reports that no camera mic was found. To test switching anyway, temporarily
  reassign `cameraMic` in the operator page to return another input.

- Teams consumer needs both people online in a Teams tab, or a call ends as "Unavailable".
- A new Teams tab in a profile doesn't receive a ring that started before the tab finished loading.
- Avoid dialogs (alert/confirm): they block the extension and every further browser command.
