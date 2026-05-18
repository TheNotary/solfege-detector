# test-client

React + TypeScript rhythm-game UI for the solfege detector. Notes scroll across a staff; the player sings each syllable as it crosses the crosshair. The client captures microphone audio, runs client-side onset detection, and streams per-note audio to the backend via a two-frame WebSocket protocol (binary PCM + JSON `note_event`).

### Application Structure

The app uses React Router with four views:

| Route | View | Description |
|-------|------|-------------|
| `/` | MainMenu | Play Game, Calibrate Latency, Configurations |
| `/play` | GameView | Rhythm game with sliding notes, crosshair, pitch detection |
| `/calibrate` | CalibrateView | Audio + display latency calibration |
| `/config` | ConfigView | Speed, responsiveness, root note, drone, debug, feedback cancellation, click-mask toggle, and on-demand audio latency calibration (LatencyCalibrator) |

Press **Esc** during gameplay to return to the main menu. Game settings are persisted to localStorage.

### Starting the Server

```
pnpm i
pnpm run dev
```

In VSCode, the `.vscode/launch.json` settings allow you to click the play button to open chrome and tie into it's JS debugger into VS Code so you can debug break points from right within the editor.  The tab in VS Code labeled `DEBUG CONSOLE` will forward commands to the real inspector in chrome.  Science is great!

### Configuration

Confugrations are meant to be exist in `.env.local` which is consumed by `src/AppConfig.ts`.  Initially the app will expect a websocket server listening as well as an http endpoint at port 8000 for local development.

```
ws://localhost:8000/ws
http://localhost:8000
```

### Tests

- `pnpm test` — unit tests (vitest) under `src/**/*.test.ts`.
- `pnpm test:e2e` — headless integration tests (Playwright) under `e2e/**/*.spec.ts`. Boots a vite dev server on port 5174 and runs Chromium with `--use-fake-ui-for-media-stream --use-fake-device-for-media-stream` so `getUserMedia()` auto-grants a synthetic mic. Smoke-tests every top-level route and fails the build on any unexpected `console.error` or uncaught page error.
- `pnpm test:e2e:headed` — same, but with a visible browser window for debugging.

First-time setup: `pnpm exec playwright install chromium` (the browser binary is downloaded once into `~/.cache/ms-playwright`). On Linux the system also needs the Chromium runtime libraries — install with `sudo pnpm exec playwright install-deps chromium` if Playwright complains at launch.

### Build

Produce a build in the `dist/` directory that's suitable to be uploaded to a CDN for very economical serving.

```
pnpm run build
```

### Initial Development Notes

This template is based around the below vite getting started command plus installing axios and react-router-dom.  This project should probably be refreshed monthly or something to make sure it's using the right version and quantity of dependencies...

```
npm create vite@latest frontend -- --template react-ts
```
