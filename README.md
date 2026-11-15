# ScreenDraw

Share your screen (or a single app) with friends, and everyone draws on it together, live.

- **One app for everyone.** Join a room, watch, draw, and share your own screen. The ScreenDraw app runs on Windows and Linux. Friends can also just use a browser.
- **One sharer at a time.** Anyone can click **Share screen**. If someone is already sharing, their share stops and yours takes over.
- **Drawing:** any colour, pen sizes, **vanishing ink** that fades a few seconds after you draw, **image stickers** you can move and resize, undo, and clear.
- **Everyone's cursor**, labelled with their name, in a colour they choose.
- **Sound, your choice of what:** only the app you're sharing, everything except certain apps (such as Discord, to avoid echo), only chosen apps, or only chosen output devices such as "Game" (more than one is fine). This works in the Windows and Linux apps. Browsers share tab or system audio.
- **Quality:** the sharer picks max resolution, frame rate (up to 60) and "text" or "motion". Each viewer picks Auto, High or Data saver.
- **Direct (P2P) or through your server**, chosen per share. The default comes from `.env`.
- **The sharer sees drawings on their real screen** as a transparent, click-through layer, and can draw on it too (**Ctrl+Shift+D**).

## What's included

| File | Who needs it |
| --- | --- |
| `ScreenDraw.exe` | Windows users: a single file, just run it. It unpacks itself each launch, so it takes a few seconds to start. |
| `ScreenDraw-Windows-x64.zip` | The same Windows app as a folder. Unzip it and run `ScreenDraw.exe`; it starts instantly. |
| `ScreenDraw-Linux-x86_64.AppImage` | Linux users: `chmod +x` it, then run it. |
| `ScreenDraw-Server.zip` | **Only the host** (you): the server, run with `Start ScreenDraw Server.bat` (Windows) or `start-server.sh`. |

## Hosting the server (you)

1. Unzip `ScreenDraw-Server.zip` and double-click **`Start ScreenDraw Server.bat`**.
   - The first run downloads a private copy of Node.js if you don't have it, and creates `.env` from `.env.example`.
   - If Windows asks whether Node.js may use the network, click **Allow**.
2. The window shows your addresses:
   ```
   This computer:   http://localhost:8080
   Same Wi-Fi/LAN:  http://192.168.0.176:8080
   Friends online:  http://86.132.9.188:8080   <-- friends enter this as the server
   ```
   It also tries to forward the port on your router automatically (UPnP). If that fails, forward **TCP 8080** to your PC by hand.
3. Close the window to stop the server.

Settings are in **`.env`** (edit with Notepad, then restart the server):

| Setting | Default | What it does |
| --- | --- | --- |
| `PORT` | `8080` | Port to listen on and forward |
| `UPNP` | `1` | Try to forward the port automatically |
| `PUBLIC_URL` | (auto) | The address friends should use, e.g. a dynamic-DNS name. `example.com` becomes `http://example.com:PORT` |
| `SERVER_PASSWORD` | (none) | If set, everyone must enter it to join |
| `DEFAULT_MEDIA_MODE` | `p2p` | Default for new shares: `p2p` (direct) or `relay` (through the server) |
| `ALLOW_RELAY` | `1` | Allow "through server" shares at all |
| `STUN_URLS` | Google STUN | STUN servers for direct connections |
| `TURN_URLS`, `TURN_USERNAME`, `TURN_CREDENTIAL` | (none) | A TURN relay for friends on strict networks |
| `MAX_ROOMS`, `MAX_PER_ROOM` | `200`, `20` | Limits |
| `MAX_STICKER_KB` | `400` | Largest sticker image |
| `POLL_HOLD_MS`, `MEMBER_TIMEOUT_MS` | `25000`, `35000` | Fallback connection tuning |

Your `.env` stays on your PC. Friends never see it; they only need the address and, if you set one, the password.

## Joining (everyone)

- **App:** the first time it opens, enter the server address (e.g. `86.132.9.188:8080`). It's remembered, and **Change / forget** on the join screen lets you enter another. Then enter your name and a room code, or press **New room**, and **Join room**.
- **Browser:** open the server address (or an invite link from **Copy invite**), enter your name and room code, and join.

## Using a room

- **Share screen:** in the app, pick **Entire screen** or **Application window** from thumbnails. In a browser, the browser shows its own picker. Then choose:
  - **Send video:** **Direct (P2P)** or **Through server** (see below)
  - **Max resolution:** Source, 1440p, 1080p, 720p or 480p
  - **Frame rate:** 15, 30 or 60
  - **Optimise for:** **Text & detail** (stays sharp) or **Motion & video** (stays smooth)
  - **Sound** (app): choose one:
    - **Only the shared app:** the default when you share an app window. Only that app's sound, so voice chat stays out.
    - **Everything you hear**
    - **Everything except these apps…:** tick Discord, for example. Apps that start playing later are included.
    - **Only these apps…:** tick one or more.
    - **Only these output devices…:** tick one or more outputs, e.g. *SteelSeries Sonar – Gaming* but not *– Chat*.
    - **No sound**
  - **Share sound** (browser): also tick "Share audio" in the browser's picker.
- **Drawing tools:**
  - **Pen:** 10 colours plus a colour picker, and a size slider.
  - **✨ Vanish:** strokes fade after 1.5, 3, 6 or 10 seconds.
  - **🖼 Sticker:** pick an image, paste one with Ctrl+V, or drag it onto the screen. Use **✋ Move** to drag it, the corner handle to resize, and **Delete** to remove it.
  - **Undo**, **Clear mine**, and **Clear all** (sharer only).
- **Shortcuts:** `1`–`0` colours · `[` `]` size · `P` pen · `V` move · `E` vanish · `Ctrl+Z` undo · `F` fullscreen.
- **Cursors:** everyone's pointer shows on the shared screen with their name. Click your own name at the top to change it.
- **🔇/🔊 and volume:** turn on the sharer's sound (browsers need a click first).
- **📶 Quality:** **Auto** (drops to low quality if your connection struggles, and goes back up later), **High** or **Data saver**.
- **ⓘ:** shows live stats: route, resolution, fps, bitrate and codec.
- **While you share from the app:**
  - Drawings appear on your real screen, on top of the shared app or screen, and are hidden from the capture, so viewers don't see them twice.
  - **Draw on my screen** (or **Ctrl+Shift+D**) lets you draw directly; press **Esc** or **Done** to go back to click-through.
  - **Show drawings on my screen** hides or shows the layer.
  - **Hide my preview** stops showing your own share inside ScreenDraw to save CPU/GPU. Viewers aren't affected. (It works in browsers too.)

### Direct (P2P) or through the server?

| | Direct (P2P) | Through server |
| --- | --- | --- |
| Path | Sharer → each viewer | Sharer → your server → every viewer |
| Sharer's upload | One copy **per viewer** | **One copy** total |
| Your server's upload | None | One copy per viewer |
| Works on strict networks | Sometimes needs TURN | Yes (plain WebSocket on your port) |
| Latency | Lowest | Slightly higher |
| Viewer quality choice | Sharer lowers it for that viewer | A low-quality copy (≤540p) that the sharer encodes only while someone is watching it |

"Through server" uses **WebCodecs** (H.264 with hardware encoding where available). Sharing that way works from the app, Chrome and Edge, and Firefox's support is more limited. Watching works in the app, Chrome, Edge, Firefox 130+ and recent Safari. If a viewer's network blocks WebSockets, ScreenDraw falls back to a slower connection that still carries drawings and direct video, but not relayed video. They'll see a message saying so.

## If something doesn't work

The server window logs each join, share and failure, including messages from browsers ("video showing…", errors). The app also keeps a log: `%APPDATA%\ScreenDraw\screendraw.log` on Windows, `~/.config/ScreenDraw/screendraw.log` on Linux.

- **Friends can't reach the server:** check the port forward and your firewall, and test from outside your home (e.g. a phone on mobile data). If the server says you're behind carrier-grade NAT, port forwarding can't work. Use a tunnel instead (e.g. `cloudflared tunnel --url http://localhost:8080`) and set `PUBLIC_URL` to the address it gives you.
- **"WebRTC is switched off":** that browser has WebRTC disabled (common in Firefox privacy setups: `about:config` → `media.peerconnection.enabled` = true). Use the app, Chrome or Edge, or have the sharer use **Through server**.
- **Video never arrives in Direct mode:** a strict network is blocking peer-to-peer. Switch to **Through server**, or add a TURN server in `.env`.
- **Choppy at high resolution:** pick 1080p/30 or **Motion & video**, or use **Through server** if you have several viewers (it saves your upload).

## Platform notes

- **Windows:** the exe isn't code-signed, so SmartScreen may say "Windows protected your PC". Click **More info → Run anyway**. The file icon is the standard Electron (folder version) or 7-Zip (single exe) one; ScreenDraw's own icon shows while it runs.
- **Overlay on a shared app window:** follows the window on Windows, and on Linux/X11 when `xwininfo` is installed (package `x11-utils`). Elsewhere, viewers still see the drawings.
- **Choosing sound in the app:**
  - **Windows:** per-app options ("only the shared app", "except", "only these apps") need **Windows 10 version 2004 or later**. Output-device sharing works on any Windows 10/11. A small helper, `sdaudio.exe`, does the capture.
  - **Linux:** needs **PipeWire** (the default on current Ubuntu, Fedora, Mint, Arch, etc.) with `pw-dump`, `pw-link` and `pactl` or `parec` (packages `pipewire-bin`/`pipewire-utils` and `pulseaudio-utils`). ScreenDraw creates a temporary silent output called *ScreenDraw-capture* and connects copies of the chosen apps' or devices' sound to it, so what you hear doesn't change. It's removed when you stop sharing. On plain PulseAudio, only output devices can be shared.
  - **Other systems** (macOS): sound can't be shared from the app.
- **Linux:** the overlay can't be hidden from the capture, so viewers also see it in the video. Turn off "Show drawings on my screen" if it bothers you. If the AppImage won't start, try `./ScreenDraw-Linux-x86_64.AppImage --appimage-extract-and-run`.
- **macOS:** not built. The browser version works.

## Building from source

`scripts/build.sh` (Linux or WSL, needs `curl`, `unzip`, `zip`) downloads Electron, 7-Zip and appimagetool from their official GitHub releases, verifies checksums where they're published, and writes everything to `dist/`. For development: `npm run server`, then `npx electron .` (or any Electron binary pointed at this folder).

```
server/   server.js (rooms, signalling, relay), ws.js (WebSocket), env.js (.env), upnp.js
public/   web client, also bundled in the app: index/room pages, js/ (transport, board, input, capture, p2p, relay, room)
app/      desktop app: main.js, preload.js, overlay, tracker.js (follows shared windows), audio.js (sound choice)
app/native/sdaudio.cpp   Windows audio helper source (WASAPI); built to app/bin/sdaudio.exe with llvm-mingw
```
