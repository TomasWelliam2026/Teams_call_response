# Call Bridge shell

A thin Electron wrapper around the Call Bridge console (`server/public/`, served by your
Call Bridge server). It exists only to give the console real tray-icon behavior that a
plain installed web app (PWA) cannot do:

- The app lives only as a **system tray icon** (`Tray`), with no separate window
  shown on screen otherwise and no taskbar button (`skipTaskbar: true`).
- Clicking the tray icon **slides a popup up from the icon**, traveling a distance
  exactly equal to the popup's own height, so it visibly expands out of the icon you
  clicked. Clicking again, or clicking elsewhere, collapses it back to just the icon.

**One thing this can't fix:** whether a tray icon sits in the always-visible part of
the notification area or in the hidden overflow ("the icon panel") is a per-app setting
Windows keeps for the user — there is no supported API for an app to force itself into
the always-visible group. The icon normally appears there the first time it's added; if
Windows later hides it, the user has to re-pin it from **Settings → Personalization →
Taskbar → Other system tray icons**.

## Setup

```bash
cd operator-shell
npm install
npm start
```

The first time it runs, the popup shows a small setup screen asking for your Call Bridge
server's address instead of the console — nothing needs editing by hand. It's saved to
`config.json` in this app's own per-user data folder (not inside the install folder, so
entering it doesn't need write access there or a rebuild), and used from then on. Change
it later from the tray icon's right-click menu → **Change server address…**. Setting the
`CALL_BRIDGE_URL` environment variable overrides whatever is saved, which is mainly useful
for development.

## Packaging

```bash
npm run dist
```

Builds a portable `dist\Call Bridge <version>.exe` via [electron-builder](https://www.electron.build/)
— no installer, just run it. It's unsigned, so Windows SmartScreen will warn on first launch.
