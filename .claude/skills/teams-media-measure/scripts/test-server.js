// Test-only wrapper: runs the real bridge server (argv[2]) and also serves /test-speech.wav (argv[3]).
// Usage: node test-server.js <repo>/server/server.js <path>/speech.wav
const http = require('http');
const fs = require('fs');
const [, , serverJs, wav] = process.argv;
const orig = http.createServer;
http.createServer = (handler) => orig((req, res) => {
  if (req.url === '/test-speech.wav') { res.writeHead(200, { 'Content-Type': 'audio/wav' }).end(fs.readFileSync(wav)); return; }
  handler(req, res);
});
process.env.BRIDGE_TOKEN ||= 'local-dev-token-not-secret';
process.env.PORT = '8787';
process.env.FALLBACK ||= 'echo';
require(serverJs);
