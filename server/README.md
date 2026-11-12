# Call Bridge Server

The online middle of three machines:

| Machine | Runs |
|---|---|
| **VPS** | This server (always on, HTTPS) |
| **Teams computer** | Chrome + Teams web + the extension, linked to the server |
| **Your computer** | The **Call Bridge app** (`https://your-server/`, installable) |

When Teams rings on the Teams computer, the extension tells the server, and the Call Bridge app rings.
Click **Answer** in the app: the extension answers in Teams and the call's audio is routed to you.
You hear the caller on your computer's speakers, and your microphone goes to the caller.
All of it is relayed live, in 20 ms frames.

What the server does with a call:

- **You answer it in the app.** The call goes straight to you.
- **An operator takes it.** A call answered on the Teams computer itself shows under **Live calls**.
  Any signed-in app can click **Take call**.
  **Hand back to Teams computer** stops the bridge only; the call keeps going and the person at the
  Teams computer gets it back. **End call** instead actually hangs up on the Teams computer too — it
  presses Teams' own Leave button there, so the call ends for everyone, not just for the bridge.
- **Nobody takes it.** `FALLBACK=silence` (default) sends silence. `FALLBACK=echo` plays the caller's
  own audio back, which is useful for testing.

Audio is relayed in memory only. Nothing is written to disk.

## Camera control

While on a call, the app's **Take full control (camera)** button sends this computer's own camera
into the call in place of the Teams computer's — on top of the mic bridge above, which keeps running
either way. Unlike audio (relayed as raw bytes through this server), video travels over a direct
WebRTC connection between the app and the extension, only *signaled* through this server; the actual
media needs a TURN relay to cross networks, which is what `turn-server.js` is for (see below). Stopping
the camera, or the call ending, hands the video sender back to whatever Teams had there.

Turning the camera on or off is also shared with Teams, the same way mute already is: the extension
presses Teams' own Camera button to match, so Teams (and the caller) see the call as having video.
It only presses that button on behalf of the app's own camera session — never a camera the person at
the Teams computer turned on themselves.

## Run

```bash
npm install
BRIDGE_TOKEN=<random secret, 16+ chars> npm start
```

| Variable | Default | Meaning |
|---|---|---|
| `BRIDGE_TOKEN` | (required) | Secret the extension sends. Paste it into the side panel's **Access token** field. |
| `OPERATOR_TOKEN` | `BRIDGE_TOKEN` | Secret for the operator console. Set a different one so console users can't impersonate the extension. |
| `PORT` | `8080` | HTTP/WebSocket port |
| `HOST` | `0.0.0.0` | Interface to listen on. Use `127.0.0.1` when a local HTTPS proxy is the only way in. |
| `FALLBACK` | `silence` | `silence` or `echo` for calls no operator has taken |
| `TURN_PORT` | `3478` | UDP port for the camera-control TURN relay (`turn-server.js`); must match on both |
| `TURN_MIN_PORT` / `TURN_MAX_PORT` | `49152` / `49452` | UDP port range TURN uses to relay media |

Generate a token with `node -e "console.log(require('crypto').randomBytes(24).toString('base64url'))"`.

Camera control also needs `turn-server.js` running (same `BRIDGE_TOKEN`, doubling as the TURN password):

```bash
BRIDGE_TOKEN=<same secret> node turn-server.js
```

It's a separate process from `server.js` by design — a crash or restart on either side doesn't affect
the other. `install.ps1` below sets it up as its own startup task automatically; running it elsewhere,
start it the same way you start `server.js` and open UDP 3478 and 49152-49452 on it.

## Deploy on a Windows VPS (always on, HTTPS, no domain needed)

1. Put `caddy.exe` (Windows amd64, from https://github.com/caddyserver/caddy/releases) in `server\bin\`.
2. Open PowerShell with **Run as administrator** and run:

   ```powershell
   powershell -ExecutionPolicy Bypass -File server\deploy\windows\install.ps1
   ```

   The script creates `server\.env` with two new secrets, opens TCP 80 and 443 plus UDP 3478 and
   49152-49452 in Windows Firewall, and registers three startup tasks running as SYSTEM:
   **CallBridge Server** (Node, only on 127.0.0.1), **CallBridge HTTPS** (Caddy with a free Let's
   Encrypt certificate) and **CallBridge TURN** (`turn-server.js`, the camera-control relay). It then
   checks the site. All three tasks restart if they stop and come back after a reboot.
   The address is `https://<your-ip-with-dashes>.sslip.io` unless you pass `-Domain your.domain`.
3. If your provider also has a network firewall (for example Hetzner Cloud Firewall), allow inbound
   TCP 80 and 443, and UDP 3478 and 49152-49452 (camera control), there too.
4. Set up the extension and the app with the server URL and tokens (see below).

### Server URL and tokens

| Where | Server URL | Token |
|---|---|---|
| **Extension** side panel (Teams computer) | `wss://<domain>/call` | **Access token** = `BRIDGE_TOKEN` |
| **Call Bridge app** (your own computer, in Chrome) | open `https://<domain>/` | **Operator token** = `OPERATOR_TOKEN` |

`<domain>` is what `install.ps1` printed, for example `95-216-122-142.sslip.io`.
It only changes if the server moves to another IP or you pass `-Domain`.

Both tokens are in `server\.env`. Only administrators can read that file. To get a token without showing it
on screen, run one of these in **PowerShell → Run as administrator** on the VPS, then paste it with Ctrl+V.
Remote Desktop shares the clipboard with your own computer.

```powershell
# Extension token
(Get-Content server\.env | Where-Object { $_ -like 'BRIDGE_TOKEN=*' }) -replace '^BRIDGE_TOKEN=', '' | Set-Clipboard
# App token
(Get-Content server\.env | Where-Object { $_ -like 'OPERATOR_TOKEN=*' }) -replace '^OPERATOR_TOKEN=', '' | Set-Clipboard
```

Run them from the repository folder, or put the full path to `server\.env` in place of `server\.env`.
Or open `server\.env` in Notepad started with **Run as administrator** (File → Open, file type **All Files**)
and copy the part after `=`.

For the extension you can skip typing. Put a `bridge-config.json` with the URL and `BRIDGE_TOKEN` next to its
`manifest.json` (see the extension README), and it fills both fields in when it's loaded or reloaded.

`tools\package-extension.ps1` builds two packages:
- **`dist\teams-call-answerer-extension.zip`**: no token, safe to share or commit. Enter the URL and token in the panel.
- **`dist\private\teams-call-answerer-extension-with-token.zip`**: includes `bridge-config.json`. It's git-ignored; never commit or share it.

Treat both tokens like passwords. To change them, delete `server\.env`, run `install.ps1` again, and enter
the new tokens in the extension and the app.

The server has no window of its own; it runs invisibly in the background. To see it, double-click
`server\monitor.bat`. It shows whether all three tasks run, how many Teams computers and Call Bridge
apps are connected, and the server's log as it happens. Closing that window doesn't stop the server.

Logs are in `server\logs\` (`turn.log` for the TURN relay). If the server was stopped, double-click
`server\start.bat`. It starts all three tasks (it asks for administrator rights) and checks that the
site answers. Don't use `npm start` on the VPS: the task already runs the server with the tokens from `.env`.
Remove everything with `server\deploy\windows\uninstall.ps1`.

## Deploy elsewhere

The server must be reachable over **TLS** (`wss://`), because the extension refuses plain `ws://`
for anything but localhost, and the console's microphone needs `https://`.
Any host that runs a Docker container or Node 18+ and terminates TLS works, for example
Render, Fly.io, Railway, Azure App Service or a VM behind Caddy or nginx.

```bash
docker build -t call-bridge .
docker run -p 8080:8080 -e BRIDGE_TOKEN=... call-bridge
```

Then put the URL `wss://<your-host>/call` in the extension's side panel. If your platform has an idle
timeout, make sure it allows WebSockets. The server pings every 20 s to keep connections open.
`GET /healthz` returns `{ ok: true, calls: n }` for health checks.

Camera control additionally needs `turn-server.js` reachable over UDP at the same hostname (see
"Camera control" above); most container platforms don't forward arbitrary UDP ports to a container,
so this piece is the one most likely to need a VM instead.

## The Call Bridge app (your computer)

1. On your own computer, open `https://<your-server>/` in Chrome or Edge.
2. Enter the operator token, keep **Remember on this computer** ticked, and click **Connect**.
   Allow the microphone and notifications.
3. Click **Install app** (or the install icon in the address bar). Call Bridge now has its own window and taskbar icon.
   To start it with Windows, open `chrome://apps`, right-click **Call Bridge**, and choose **Start app when you sign in**.

The app reconnects by itself after a network drop or a server restart. "Teams computer linked" shows that the extension is online.
Only one app can answer a given ring. If the app is closed, the call keeps ringing in Teams as usual.

**Take full control (camera)**, shown once on a call, sends this computer's camera into the call (see
"Camera control" above). It asks for the camera the first time it's clicked, not at sign-in, since it's
only needed while actually in control. **Stop camera** hands the video back; leaving the call does the same.

## Protocol

Plug your own handler in here, for example a speech bot, instead of the operator console.

**`/call`**, used by the extension:

1. The client sends text: `{"type":"hello","token":"…","callId":"<uuid>","caller":"Jane Doe","format":{"encoding":"pcm_s16le","sampleRate":16000,"channels":1,"frameMs":20},"client":"teams-call-answerer/0.2.0"}`
2. The server replies with `{"type":"ready","callId":"…","handler":"operator|echo|silence","iceServers":[…]}`, or closes with code `4001` for a bad token or `4002` for a bad or missing hello within 5 s. `iceServers` is a standard `RTCConfiguration.iceServers` array pointing at `turn-server.js`, for camera control.
3. Both directions then carry **binary** frames: PCM signed 16-bit little-endian, mono, 16 kHz, 20 ms (640 bytes).
4. Mute is shared. The server sends `{"type":"mute","muted"}` when the app presses Mute.
   The extension presses Teams' own Mute button and answers with `{"type":"mute-state","muted"}`, which it also sends when someone mutes in Teams.
5. Camera control: the operator app offers a WebRTC video connection and the extension answers it, relayed as-is: `{"type":"video-offer"|"video-answer","sdp":"…"}` and `{"type":"video-ice","candidate":{…}|null}` either direction, `{"type":"video-stop"}` either direction to end it. The server never looks inside the SDP.
6. Either side can end the bridge. The server sends `{"type":"stop","reason":"…"}`, and the extension
   then gives the microphone back to Teams. The client sends `{"type":"end","reason":"…"}` when the call ends.
7. `{"type":"hello",…,"test":true}` is answered with `ready` and closed.

If the extension's connection drops mid-call, it reconnects with the same `callId` up to 3 times.
The server keeps the session, and its operator, for 15 s.

**`/station`**, the extension's always-on link, authenticated with `BRIDGE_TOKEN`:
the client sends `{"type":"hello","role":"station","token"}`, then `{"type":"ringing","ringId","caller"}`,
`{"type":"ring-ended","ringId"}`, `{"type":"answer-result","ringId","ok","message"}` and `{"type":"ping"}`
every 20 s. The server sends `{"type":"answer"|"decline","ringId","mode"}`.
A `/call` hello that carries the answered `ringId` is routed to the operator who pressed Answer.

**`/operator`**, used by the app: the client sends `{"type":"hello","token":"…"}`. The server
sends `{"type":"ready","iceServers":[…]}` then `{"type":"calls","calls":[…],"rings":[…],"stations":n,"mine":id}` whenever anything changes.
The client can send `{"type":"answer"|"decline","ringId"}`, `{"type":"take","callId"}`, `{"type":"mute","muted"}`,
`{"type":"release"}`, `{"type":"stop","callId"}` (hand the bridge back) or `{"type":"end-call","callId"}`
(hang up on the Teams computer too). The server sends `{"type":"mute-state","callId","muted"}`
whenever the Teams computer's mute changes.
Binary frames use the same PCM format.
Camera control (`callId` required, so the server knows which `/call` to relay to): the client sends
`{"type":"video-offer","callId","sdp"}` or `{"type":"video-ice"|"video-stop","callId",…}`; the server
relays `{"type":"video-answer"|"video-ice","sdp"|"candidate"}` back from the extension, unchanged.

## Test

```bash
npm test
```

The test starts the server on a random port. It checks authentication, the echo fallback,
operator take and hand-back, camera-control signaling relay, and runs the extension's own `bridge.js`
against the server. It doesn't exercise `turn-server.js` or real WebRTC media (no camera/network in CI);
see `teams-auto-answer/README.md` for how that was verified against a mock Teams page.
