# ScreenDraw

Peer-to-peer screen sharing that viewers can draw on.

- **Viewers** join in any modern browser. They draw on the shared screen with a mouse, pen or touch, and can change pen colour at any time (10 swatches plus a custom colour picker) and pen size.
- **The sharer** runs a small desktop app. Everyone's drawings appear on the sharer's real screen as a **transparent, click-through overlay**, so you can keep working underneath.
- Video and drawings go **directly between peers** over WebRTC. The tiny Node server only passes the connection handshake and serves the viewer page.

```
 Viewer (browser) ──┐   WebRTC: video ▶ / drawings ◀▶       ┌── Desktop sharer (Electron)
 Viewer (browser) ──┼──────────────────────────────────────┤     + transparent overlay
 Viewer (browser) ──┘                                       └──
            \______________ signalling only (server.js) ______________/
```

## Quick start

Requires Node.js 18+.

```bash
npm install          # installs Electron (only needed for the desktop sharer)
npm run server       # starts the signalling server on port 8080
npm run sharer       # in another terminal: opens the desktop sharer app
```

1. In the sharer app, set **Signalling server** to an address viewers can reach. The server prints your network address when it starts (e.g. `http://192.168.1.20:8080`).
2. Pick a screen and click **Start sharing**.
3. Click **Copy viewer link** and send it to people. They can also open the server address and type in the room code.

There's also a browser-only sharer at `/share.html` (no install needed). It works the same way, but a browser can't draw over your desktop, so drawings only show on top of the preview inside the page.

## Viewer controls

| Action | How |
| --- | --- |
| Draw | Click/tap and drag on the screen |
| Change colour | Click a swatch, use the colour picker, or press `1`–`0` |
| Pen size | Slider, or `[` / `]` |
| Undo your last stroke | **Undo** or `Ctrl/Cmd+Z` |
| Remove your strokes | **Clear mine** |
| Fullscreen | ⛶ button or `F` |

The sharer can **Clear all drawings** and turn the overlay on or off. Viewers can only undo or clear their own strokes: the sharer checks every incoming message, so nobody can erase someone else's work.

Your pen colour and size are saved in your browser.

## How the overlay works

`electron/main.js` opens a frameless window that covers the chosen display and is:

- transparent (`transparent: true`, transparent background)
- click-through (`setIgnoreMouseEvents(true)`), so your mouse and keyboard reach the apps underneath
- always on top at `screen-saver` level, on all workspaces
- **excluded from the screen capture** (`setContentProtection(true)`). Without this, viewers would see each stroke twice: their own line, plus a slightly delayed copy in the video.

Strokes are stored in normalised 0–1 coordinates relative to the shared frame, so they line up exactly on the sharer's display and on every viewer's window, whatever their size.

## Platform notes

- **Windows 10 (2004+) / 11, macOS:** fully supported. On macOS, allow *Screen Recording* for the app (or for your terminal in development) under System Settings → Privacy & Security.
- **Linux:** sharing and the overlay work on X11 with a compositor. Two limitations: `setContentProtection` isn't supported, so viewers will see the overlay in the capture as well (turn off **Show drawings on my screen** if that bothers you); and on Wayland, transparent always-on-top windows depend on your compositor.

## Going beyond your local network

- **Server:** deploy `server.js` anywhere that runs Node (it has no dependencies) and put it behind HTTPS. Viewers only need the URL.
- **NAT traversal:** the app uses Google's public STUN servers, which handle most home networks. For strict corporate or mobile networks, add a TURN server (e.g. coturn, or a hosted one) to `ICE_SERVERS` at the top of `public/rtc.js`.
- **Scale:** the sharer sends a separate video stream to each viewer (a mesh). That works well for roughly 5–8 viewers, depending on upload bandwidth. For larger audiences you'd put an SFU (e.g. LiveKit, mediasoup) in the middle.
- **Privacy:** anyone with the room code can join. Room codes are random, but if that matters, add a password or a "let in" prompt to the sharer.

## Project layout

```
server.js            signalling (Server-Sent Events + POST) and static files, zero dependencies
public/rtc.js        shared code: signalling client, board, pen input, sharer hub, viewer
public/tools.js      colour/size toolbar
public/viewer.html   viewer page
public/share.html    browser-only sharer
electron/main.js     desktop app: display capture + transparent overlay window
electron/control.*   sharer control window
electron/overlay.*   overlay renderer
```
