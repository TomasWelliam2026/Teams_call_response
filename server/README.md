# Call Bridge Server

The online half of the Teams Call Answerer. After a Teams call is answered, the extension connects
here over a WebSocket and streams the call's audio. The server sends audio back, and the extension
plays it to the caller in place of the microphone.

What the server does with a call:

- **An operator takes it.** A person opens the console (`https://your-server/`), enters the operator
  token and clicks **Take call**. They hear the caller, and their microphone goes to the caller.
  **Hand back to Teams user** stops the bridge, and the person at the Teams computer gets the call back.
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
| `FALLBACK` | `silence` | `silence` or `echo` for calls no operator has taken |

Generate a token with `node -e "console.log(require('crypto').randomBytes(24).toString('base64url'))"`.

## Deploy online

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

## Protocol

Plug your own handler in here, for example a speech bot, instead of the operator console.

**`/call`**, used by the extension:

1. The client sends text: `{"type":"hello","token":"…","callId":"<uuid>","caller":"Jane Doe","format":{"encoding":"pcm_s16le","sampleRate":16000,"channels":1,"frameMs":20},"client":"teams-call-answerer/0.2.0"}`
2. The server replies with `{"type":"ready","callId":"…","handler":"operator|echo|silence"}`, or closes with code `4001` for a bad token or `4002` for a bad or missing hello within 5 s.
3. Both directions then carry **binary** frames: PCM signed 16-bit little-endian, mono, 16 kHz, 20 ms (640 bytes).
4. Either side can end the bridge. The server sends `{"type":"stop","reason":"…"}`, and the extension
   then gives the microphone back to Teams. The client sends `{"type":"end","reason":"…"}` when the call ends.
5. `{"type":"hello",…,"test":true}` is answered with `ready` and closed. The side panel's **Test connection** button uses it.

If the extension's connection drops mid-call, it reconnects with the same `callId` up to 3 times.
The server keeps the session, and its operator, for 15 s.

**`/operator`**, used by the console: the client sends `{"type":"hello","token":"…"}`. The server
sends `{"type":"calls","calls":[…],"mine":id}` whenever calls change. The client can send
`{"type":"take","callId"}`, `{"type":"release"}` or `{"type":"stop","callId"}`.
Binary frames use the same PCM format.

## Test

```bash
npm test
```

The test starts the server on a random port. It checks authentication, the echo fallback,
operator take and hand-back, and runs the extension's own `bridge.js` against the server.
