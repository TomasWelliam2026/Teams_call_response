// STUN/TURN relay for the camera-control feature (see README.md "Camera control"). Runs as its
// own process, separate from server.js, so a crash or restart on either side doesn't affect the
// other. The operator app and the extension page both already know BRIDGE_TOKEN, so it doubles as
// the single TURN credential instead of distributing a separate secret.
const Turn = require('node-turn');

const LISTEN_PORT = Number(process.env.TURN_PORT) || 3478;
const MIN_PORT = Number(process.env.TURN_MIN_PORT) || 49152;
const MAX_PORT = Number(process.env.TURN_MAX_PORT) || 49452;
const TOKEN = process.env.BRIDGE_TOKEN || '';
const REALM = process.env.TURN_REALM || 'call-bridge';
const USERNAME = 'call-bridge'; // fixed; server.js hands this out alongside the token as the password

if (TOKEN.length < 16) {
  console.error('BRIDGE_TOKEN is not set (it must be the same secret server.js uses).');
  process.exit(1);
}

const log = (...args) => console.log(new Date().toISOString(), ...args);

const server = new Turn({
  authMech: 'long-term',
  credentials: { [USERNAME]: TOKEN },
  realm: REALM,
  listeningPort: LISTEN_PORT,
  minPort: MIN_PORT,
  maxPort: MAX_PORT,
  debugLevel: process.env.TURN_DEBUG || 'ERROR',
});

server.start();
log(`TURN/STUN server on UDP ${LISTEN_PORT} (relay ports ${MIN_PORT}-${MAX_PORT})`);

function shutdown() {
  server.stop();
  process.exit(0);
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
