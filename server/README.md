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
  **Hand back to Teams computer** stops the bridge, and the person at the Teams computer gets the call back.
- **Nobody takes it.** `FALLBACK=silence` (default) sends silence. `FALLBACK=echo` plays the caller's
  own audio back, which is useful for testing.

Audio is relayed in memory only. Nothing is written to disk.

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

Generate a token with `node -e "console.log(require('crypto').randomBytes(24).toString('base64url'))"`.

## Deploy on a Windows VPS (always on, HTTPS, no domain needed)

1. Put `caddy.exe` (Windows amd64, from https://github.com/caddyserver/caddy/releases) in `server\bin\`.
2. Open PowerShell with **Run as administrator** and run:

   ```powershell
   powershell -ExecutionPolicy Bypass -File server\deploy\windows\install.ps1
   ```

   The script creates `server\.env` with two new secrets, opens TCP 80 and 443 in Windows Firewall,
   and registers two startup tasks running as SYSTEM: **CallBridge Server** (Node, only on 127.0.0.1)
   and **CallBridge HTTPS** (Caddy with a free Let's Encrypt certificate). It then checks the site.
   Both tasks restart if they stop and come back after a reboot.
   The address is `https://<your-ip-with-dashes>.sslip.io` unless you pass `-Domain your.domain`.
3. If your provider also has a network firewall (for example Hetzner Cloud Firewall), allow inbound TCP 80 and 443 there.
4. Open `server\.env` and copy the tokens:
   - Extension side panel: **Server URL** `wss://<domain>/call`, **Access token** = `BRIDGE_TOKEN`
   - Operator console: open `https://<domain>/` **on your own computer**, enter `OPERATOR_TOKEN`, allow the microphone.

The server has no window of its own; it runs invisibly in the background. To see it, double-click
`server\monitor.bat`. It shows whether both tasks run, how many Teams computers and Call Bridge apps
are connected, and the server's log as it happens. Closing that window doesn't stop the server.

Logs are in `server\logs\`. If the server was stopped, double-click `server\start.bat`. It starts both tasks
(it asks for administrator rights) and checks that the site answers. Don't use `npm start` on the VPS:
the task already runs the server with the tokens from `.env`.
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

## The Call Bridge app (your computer)

1. On your own computer, open `https://<your-server>/` in Chrome or Edge.
2. Enter the operator token, keep **Remember on this computer** ticked, and click **Connect**.
   Allow the microphone and notifications.
3. Click **Install app** (or the install icon in the address bar). Call Bridge now has its own window and taskbar icon.
   To start it with Windows, open `chrome://apps`, right-click **Call Bridge**, and choose **Start app when you sign in**.

The app reconnects by itself after a network drop or a server restart. "Teams computer linked" shows that the extension is online.
Only one app can answer a given ring. If the app is closed, the call keeps ringing in Teams as usual.

## Protocol

Plug your own handler in here, for example a speech bot, instead of the operator console.

**`/call`**, used by the extension:

1. The client sends text: `{"type":"hello","token":"…","callId":"<uuid>","caller":"Jane Doe","format":{"encoding":"pcm_s16le","sampleRate":16000,"channels":1,"frameMs":20},"client":"teams-call-answerer/0.2.0"}`
2. The server replies with `{"type":"ready","callId":"…","handler":"operator|echo|silence"}`, or closes with code `4001` for a bad token or `4002` for a bad or missing hello within 5 s.
3. Both directions then carry **binary** frames: PCM signed 16-bit little-endian, mono, 16 kHz, 20 ms (640 bytes).
4. Mute is shared. The server sends `{"type":"mute","muted"}` when the app presses Mute.
   The extension presses Teams' own Mute button and answers with `{"type":"mute-state","muted"}`, which it also sends when someone mutes in Teams.
5. Either side can end the bridge. The server sends `{"type":"stop","reason":"…"}`, and the extension
   then gives the microphone back to Teams. The client sends `{"type":"end","reason":"…"}` when the call ends.
6. `{"type":"hello",…,"test":true}` is answered with `ready` and closed.

If the extension's connection drops mid-call, it reconnects with the same `callId` up to 3 times.
The server keeps the session, and its operator, for 15 s.

**`/station`**, the extension's always-on link, authenticated with `BRIDGE_TOKEN`:
the client sends `{"type":"hello","role":"station","token"}`, then `{"type":"ringing","ringId","caller"}`,
`{"type":"ring-ended","ringId"}`, `{"type":"answer-result","ringId","ok","message"}` and `{"type":"ping"}`
every 20 s. The server sends `{"type":"answer"|"decline","ringId","mode"}`.
A `/call` hello that carries the answered `ringId` is routed to the operator who pressed Answer.

**`/operator`**, used by the app: the client sends `{"type":"hello","token":"…"}`. The server
sends `{"type":"calls","calls":[…],"rings":[…],"stations":n,"mine":id}` whenever anything changes.
The client can send `{"type":"answer"|"decline","ringId"}`, `{"type":"take","callId"}`, `{"type":"mute","muted"}`,
`{"type":"release"}` or `{"type":"stop","callId"}`. The server sends `{"type":"mute-state","callId","muted"}`
whenever the Teams computer's mute changes.
Binary frames use the same PCM format.

## Test

```bash
npm test
```

The test starts the server on a random port. It checks authentication, the echo fallback,
operator take and hand-back, and runs the extension's own `bridge.js` against the server.
