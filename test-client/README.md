# test-client

React + TypeScript rhythm-game UI for the solfege detector. Notes scroll across a staff; the player sings each syllable as it crosses the crosshair. The client captures microphone audio, runs client-side onset detection, and streams per-note audio to the backend via a two-frame WebSocket protocol (binary PCM + JSON `note_event`).

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
