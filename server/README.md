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
| `PUBLIC_IP` | (none) | This server's public IPv4. `turn-server.js` hands it out as the relay address, which matters behind NAT. Setup fills it in. |
| `DOMAIN` | (none) | Your own domain, if any. Only setup reads it, to write the Caddyfile. |

Generate a token with `node -e "console.log(require('crypto').randomBytes(24).toString('base64url'))"`.

Camera control also needs `turn-server.js` running (same `BRIDGE_TOKEN`, doubling as the TURN password):

```bash
BRIDGE_TOKEN=<same secret> node turn-server.js
```

It's a separate process from `server.js` by design — a crash or restart on either side doesn't affect
the other. Setup (below) runs it as its own service; running it elsewhere, start it the same way you
start `server.js` and open UDP 3478 and 49152-49452 on it.

## Install on a VPS (Windows or Linux)

One setup per system does everything: it gets Node.js and Caddy if they're missing (checksum-verified
downloads), creates the tokens, sets up HTTPS with free Let's Encrypt certificates (no domain needed),
opens the firewall, and runs the server, the HTTPS front and the TURN relay as services that start at
boot and restart if they stop. It ends by checking the server answers and printing the addresses.

**Get the server onto the VPS:** copy `dist/call-bridge-server.zip` (Windows) or
`dist/call-bridge-server.tar.gz` (Linux) there and unpack it, or clone this repository. The package
already holds the npm packages and no secrets; rebuild it with `npm run package` in `server/`.

| | Windows Server 2016+ | Linux with systemd (Ubuntu, Debian, Rocky, Alma, Fedora, ...) |
|---|---|---|
| Run setup | Double-click **`setup.cmd`** (asks for administrator rights) | `sudo bash setup.sh` |
| Installs to | Where you unpacked it (tasks run as SYSTEM) | `/opt/call-bridge` (`--dir` to change), runs as user `callbridge` |
| Status and live log | `monitor.bat` | `callbridge status`, `callbridge logs` |
| Start / restart | `start.bat` | `sudo callbridge start` / `restart` |
| Tokens | `.env` in the folder (administrators only) | `sudo callbridge tokens` |
| Uninstall | `uninstall.bat` (keeps `.env`) | `sudo callbridge uninstall` (keeps `.env`; `--purge` deletes all) |

Options, the same on both (Windows spelling first):

| Option | Meaning |
|---|---|
| `-Domain` / `--domain bridge.example.com` | Also answer on your own domain. Point its DNS A record at the VPS first. Remembered; `none` drops it. |
| `-PublicIp` / `--ip 1.2.3.4` | Use this IP instead of the one detected. |
| `-Port` / `--port 8080` | Local port of `server.js` (only Caddy talks to it). |
| `-Force` / `--yes` | Don't ask before restarting a server that has live calls. |

For example `setup.cmd -Domain bridge.example.com` or `sudo bash setup.sh --domain bridge.example.com`.

If your provider also has a network firewall (AWS security group, Hetzner Cloud Firewall, ...), allow
inbound TCP 80 and 443, and UDP 3478 and 49152-49452 (camera control), there too. Setup can't reach
that one. Ports 80 and 443 must be free: setup warns if IIS, nginx or apache already holds them.

### Server URL and tokens

Setup prints every address the server answers on. They all reach the same server; use whichever one
your networks allow (some web filters block `sslip.io`, for example):

| Address | Example |
|---|---|
| Your domain (with `-Domain`) | `bridge.example.com` |
| `<ip-with-dashes>.sslip.io` | `95-216-122-142.sslip.io` |
| `<ip-with-dashes>.nip.io` | `95-216-122-142.nip.io` |
| The bare IP | `95.216.122.142` (Let's Encrypt's 6-day certificates, renewed automatically) |

| Where | Server URL | Token |
|---|---|---|
| **Extension** side panel (Teams computer) | `wss://<address>/call` | **Access token** = `BRIDGE_TOKEN` |
| **Call Bridge app** (your own computer, in Chrome) | open `https://<address>/` | **Operator token** = `OPERATOR_TOKEN` |

Both tokens are in `.env` in the server folder, readable only by administrators (root on Linux). On
Windows, to get a token without showing it on screen, run one of these in **PowerShell → Run as
administrator** in the server folder, then paste it with Ctrl+V (Remote Desktop shares the clipboard):

```powershell
# Extension token
(Get-Content .env | Where-Object { $_ -like 'BRIDGE_TOKEN=*' }) -replace '^BRIDGE_TOKEN=', '' | Set-Clipboard
# App token
(Get-Content .env | Where-Object { $_ -like 'OPERATOR_TOKEN=*' }) -replace '^OPERATOR_TOKEN=', '' | Set-Clipboard
```

For the extension you can skip typing. Put a `bridge-config.json` with the URL and `BRIDGE_TOKEN` next to its
`manifest.json` (see the extension README), and it fills both fields in when it's loaded or reloaded.

`tools\package-extension.ps1` builds two packages:
- **`dist\teams-call-answerer-extension.zip`**: no token, safe to share or commit. Enter the URL and token in the panel.
- **`dist\private\teams-call-answerer-extension-with-token.zip`**: includes `bridge-config.json`. It's git-ignored; never commit or share it.

Treat both tokens like passwords. To change them, delete `.env`, run setup again, and enter the new
tokens in the extension and the app.

The server has no window of its own. Its logs are in `logs/` (`server.log`, `caddy.log`, `turn.log`).
Don't start it with `npm start` on the VPS: the services already run it with the settings from `.env`.

### Move to another VPS

Everything that makes a server *yours* is in `.env`: the two tokens, plus the port and domain.

1. Copy `.env` from the old server folder (Linux: `/opt/call-bridge/.env`) into the new copy, next to
   `setup.cmd` / `setup.sh`. Windows and Linux use the same file, so you can move between them.
2. Run setup on the new VPS. It keeps the tokens and detects the new IP.
3. Point the clients at the new address: the extension's **Server URL**, and the Call Bridge app at the
   new `https://<address>/` (install the app again from there; the installed app is tied to its address).
   The tokens stay the same. With your own domain, change its DNS A record instead and nothing else changes.
4. Uninstall on the old VPS. Do the switch when no call is live; calls don't move between servers.

### Update

Unpack the newer package over the old folder (Windows; `.env`, `bin\` and `logs\` stay) or anywhere
(Linux), and run setup again. It replaces the app files, keeps the tokens and certificates, and
restarts the services; if calls are live, it asks first. Run setup again too if the VPS's IP changed.

## Other hosting

The server must be reachable over **TLS** (`wss://`), because the extension refuses plain `ws://`
for anything but localhost, and the console's microphone needs `https://`.
Any host that runs a Docker container or Node 20.6+ and terminates TLS works, for example
Render, Fly.io, Railway, Azure App Service or a VM behind your own Caddy or nginx.

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

The app reconnects by itself after a network drop or a server restart. During a call it keeps the call
through either (for up to a minute) and nothing said in the meantime is lost: see "No audio lost" below.
"Teams computer linked" shows that the extension is online.
Only one app can answer a given ring. If the app is closed, the call keeps ringing in Teams as usual.

**Take full control (camera)**, shown once on a call, sends this computer's camera into the call (see
"Camera control" above). It asks for the camera the first time it's clicked, not at sign-in, since it's
only needed while actually in control. **Stop camera** hands the video back; leaving the call does the same.

## Protocol

Plug your own handler in here, for example a speech bot, instead of the operator console.

**`/call`**, used by the extension:

1. The client sends text: `{"type":"hello","token":"…","callId":"<uuid>","caller":"Jane Doe","format":{"encoding":"pcm_s16le","sampleRate":16000,"channels":1,"frameMs":20},"client":"teams-call-answerer/0.5.1","have":0,"sent":0,"since":<ms>}`
   (`have`, `sent` and `since` matter on a reconnect, see below).
2. The server replies with `{"type":"ready","callId":"…","handler":"operator|echo|silence","iceServers":[…],"got":n}`, or closes with code `4001` for a bad token or `4002` for a bad or missing hello within 5 s. `iceServers` is a standard `RTCConfiguration.iceServers` array pointing at `turn-server.js`, for camera control.
3. Both directions then carry **binary** frames: PCM signed 16-bit little-endian, mono, 16 kHz, 20 ms (640 bytes).
4. Mute is shared. The server sends `{"type":"mute","muted"}` when the app presses Mute.
   The extension presses Teams' own Mute button and answers with `{"type":"mute-state","muted"}`, which it also sends when someone mutes in Teams.
5. Camera control: the operator app offers a WebRTC video connection and the extension answers it, relayed as-is: `{"type":"video-offer"|"video-answer","sdp":"…"}` and `{"type":"video-ice","candidate":{…}|null}` either direction, `{"type":"video-stop"}` either direction to end it. The server never looks inside the SDP.
6. Either side can end the bridge. The server sends `{"type":"stop","reason":"…"}`, and the extension
   then gives the microphone back to Teams. The client sends `{"type":"end","reason":"…"}` when the call ends.
7. `{"type":"hello",…,"test":true}` is answered with `ready` and closed.

**No audio lost.** Every frame is numbered by its position in the call, per direction. When a
connection drops mid-call (or dies without anyone noticing yet), the side reconnects within a minute
and says how many frames it has; the other side's missing frames are sent again, in order:

- The extension reconnects with the same `callId` for up to a minute; the server keeps the session,
  and its operator, as long. `hello.have` is how many of the app's frames it received: the server
  sends the rest (it keeps the last 60 s of each direction). `ready.got` is how many caller frames the
  server has: the extension sends again everything after that (it keeps the last 60 s too).
- The app reconnects with `{"type":"hello","token","resume":"<callId>","have":n}` and gets the call
  back: `{"type":"taken",…,"seq":n,"got":m}` followed by the caller frames after `n`; it then sends
  again its own frames after `m`. A call that ended meanwhile is answered with `released`.
- After a server restart, whichever side comes back first waits for the other; the call continues
  under the same `callId`. If the app misses frames that died with the old server process, the server
  sends `{"type":"rewind","from":n}` and the extension answers `{"type":"rewound"}`, then sends
  those frames again.
- Both players catch up on a backlog by leaving out pauses, never speech.

The extension also sends `{"type":"note","message"}` for things worth knowing after the call (Teams
moving the call to another media connection, say); the server writes them to its log, together with
a summary per call: frames each way, frames sent again after reconnects, and anything lost.

**`/station`**, the extension's always-on link, authenticated with `BRIDGE_TOKEN`:
the client sends `{"type":"hello","role":"station","token"}`, then `{"type":"ringing","ringId","caller"}`,
`{"type":"ring-ended","ringId"}`, `{"type":"answer-result","ringId","ok","message"}` and `{"type":"ping"}`
every 20 s. The server sends `{"type":"answer"|"decline","ringId","mode"}`.
A `/call` hello that carries the answered `ringId` is routed to the operator who pressed Answer.

**`/operator`**, used by the app: the client sends `{"type":"hello","token":"…"}` (plus `resume` and `have` to get its call back after a reconnect, see above). The server
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
