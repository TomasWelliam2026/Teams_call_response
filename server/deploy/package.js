// Builds the server release that you copy to a VPS: dist/call-bridge-server.zip and .tar.gz, each
// holding a call-bridge-server/ folder with the server, its npm packages and both setups (setup.cmd
// for Windows, setup.sh for Linux). No secrets: .env, bin/, logs/ and the Caddyfile stay out.
//   npm run package
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const SERVER = path.join(__dirname, '..');
const DIST = path.join(SERVER, '..', 'dist');
const NAME = 'call-bridge-server';
const FILES = [
  'server.js', 'turn-server.js', 'package.json', 'package-lock.json', 'README.md',
  'setup.cmd', 'setup.sh', 'start.bat', 'monitor.bat', 'uninstall.bat', 'public', 'deploy', 'node_modules',
];

for (const pkg of ['ws', 'node-turn']) {
  if (!fs.existsSync(path.join(SERVER, 'node_modules', pkg))) throw new Error(`node_modules/${pkg} is missing: run npm ci --omit=dev first.`);
}

const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'callbridge-'));
const root = path.join(stage, NAME);
for (const f of FILES) fs.cpSync(path.join(SERVER, f), path.join(root, f), { recursive: true });
// A Windows checkout may have CRLF shell scripts; bash on Linux can't run those.
for (const f of fs.readdirSync(root, { recursive: true })) {
  const file = path.join(root, f);
  if (f.endsWith('.sh')) fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n'));
}

fs.mkdirSync(DIST, { recursive: true });
const zip = path.join(DIST, `${NAME}.zip`);
const tgz = path.join(DIST, `${NAME}.tar.gz`);
for (const f of [zip, tgz]) fs.rmSync(f, { force: true });
// Windows' own tar (bsdtar) writes both formats; elsewhere tar.gz with tar, zip with zip.
const winTar = process.platform === 'win32' && path.join(process.env.SystemRoot, 'System32', 'tar.exe');
execFileSync(winTar || 'tar', ['-czf', tgz, '-C', stage, NAME]);
if (winTar) execFileSync(winTar, ['-a', '-cf', zip, '-C', stage, NAME]);
else execFileSync('zip', ['-qr', zip, NAME], { cwd: stage });
fs.rmSync(stage, { recursive: true, force: true });

const size = (f) => `${(fs.statSync(f).size / 1024).toFixed(0)} KB`;
console.log(`Built ${path.relative(process.cwd(), zip)} (${size(zip)}) and ${path.relative(process.cwd(), tgz)} (${size(tgz)}).`);
