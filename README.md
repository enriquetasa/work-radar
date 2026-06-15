# Work Radar (Electron)

A situational-awareness radar for the projects orbiting you — the things you must keep in mind, not a to-do list. Data lives in a real JSON file on disk, written atomically, with automatic daily backups.

## Run it

Requires [Node.js](https://nodejs.org) (18+).

```bash
cd work-radar
npm install      # downloads Electron (~150 MB, one time)
npm start
```

## Build a desktop app

```bash
npm run build:mac     # → dist/Work Radar-2.0.0.dmg
npm run build:win     # → dist/Work Radar Setup 2.0.0.exe
npm run build:linux   # → dist/Work Radar-2.0.0.AppImage
```

Install the artifact from `dist/` like any other app. On macOS the build is unsigned, so the first launch needs right-click → Open (or `System Settings → Privacy & Security → Open Anyway`). Signing requires an Apple Developer ID — add it to the `build.mac` block in `package.json` if you want notarization.

### Launch on login
- **macOS:** System Settings → General → Login Items → add Work Radar.
- **Windows:** the NSIS installer offers a Start-menu/desktop shortcut; drop it in `shell:startup` to auto-launch.

## Where your data lives

A single JSON file in the OS app-data directory:

- **macOS:** `~/Library/Application Support/work-radar/work-radar-data.json`
- **Windows:** `%APPDATA%\work-radar\work-radar-data.json`
- **Linux:** `~/.config/work-radar/work-radar-data.json`

Writes are atomic (temp file + rename), so a crash mid-save can't corrupt it. A dated snapshot is copied to `backups/` once per day on launch (last 30 kept). **Radar → Reveal Auto-Backups** opens that folder. **EXPORT** still writes a portable copy anywhere you choose — good for dropping into a synced folder.

Unlike the old single-file HTML version, this does **not** depend on browser storage or the file's path. Move the app, rename it, doesn't matter — the data directory is stable.

## Migrating from the browser version

The old `work-radar.html` stored data in browser `localStorage`, which the Electron app can't read. To bring it over: open the old file, hit **EXPORT** to get a JSON backup, then in the Electron app hit **IMPORT** and select it. Merge is non-destructive (matching IDs overwrite, new ones add).

## Keyboard

`Cmd/Ctrl+N` new · `Cmd/Ctrl+F` search · `Cmd/Ctrl+E` export · `Cmd/Ctrl+I` import
In-window: `N` `/` `E` (edit) `P` (ping) `A` (archive) `Esc`

## Staleness model

Anything you haven't **PINGED** in 14 days flags `NEEDS REVIEW` — amber halo on the radar, a count in the header, a dedicated REVIEW filter. PING resets the clock. Change the window in `renderer/app.js`: `const STALE_DAYS = 14;`

## Architecture

```
main.js          Main process — owns ALL disk IO, window, menu, daily backups.
preload.js       contextBridge: exposes a tiny window.radarAPI (load/save/export/import).
renderer/        UI. No Node access; talks to disk only through radarAPI over IPC.
  index.html     Markup + strict CSP (script-src 'self').
  app.css        Styles.
  app.js         State store, render, actions. Falls back to localStorage if run
                 outside Electron, so the same code works in a plain browser too.
```

Security defaults: `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`, CSP locked to self. The renderer never sees Node or the filesystem directly.
