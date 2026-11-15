# ScreenDraw

Peer-to-peer screen sharing that your friends can draw on.

- **Friends** join in any modern browser. They draw on your shared screen with a mouse, pen or touch, and can change pen colour at any time (10 swatches plus a custom colour picker) and pen size.
- **You (the sharer)** see everyone's drawings on your real screen as a **transparent, click-through overlay**, so you can keep working underneath.
- Video and drawings go **directly between computers** over WebRTC. The small server in this folder only helps computers find each other and serves the page your friends open.

## Start it (one click)

| System | Double-click |
| --- | --- |
| Windows | **`Start ScreenDraw.bat`** |
| macOS | **`Start ScreenDraw.command`** (the first time, right-click → Open to get past Gatekeeper) |
| Linux | `./start.sh` |

The first run downloads what's needed, all inside this folder:

1. **Node.js**, if you don't already have v18 or newer. It goes into `runtime/node` and doesn't touch your system.
2. **The sharer app's runtime** (Electron, about 110 MB) into `runtime/electron`, straight from Electron's official GitHub releases and checksum-verified. npm isn't involved, because newer npm versions block Electron's own download step.

After that it starts straight away. Each launch:

- starts the server in the launcher window (**close that window to stop it**)
- asks your router to **forward the port automatically** (UPnP) and looks up your public IP address
- opens the ScreenDraw sharer app

On Windows, if a firewall prompt asks whether Node.js may accept connections, click **Allow**.

Then in the app: pick a screen → **Start sharing** → **Copy viewer link** → send it to your friends. The room code stays the same each time you share, so friends can keep using the same link. Click **New code** to stop old links working. (Only your computer can share in your room: it holds a private key for it.) The link uses your public address (e.g. `http://203.0.113.7:8080/viewer.html?room=k7m2qp`). The green or yellow box under it tells you whether port forwarding is set up.

If the sharer app can't be installed, the launcher opens the browser version of the sharer in Chrome or Edge (or your default browser if neither is installed); run the launcher again to retry the download. It works the same, but drawings only appear over a preview in the browser, not on top of your desktop.

### Settings

Change these at the top of `Start ScreenDraw.bat` (or `start.sh`):

| Setting | Default | Meaning |
| --- | --- | --- |
| `PORT` | `8080` | The port the server listens on and the one to forward on your router |
| `UPNP` | `1` | `0` turns off automatic port forwarding |
| `OPEN_SHARER` | `1` | `0` runs only the server |

You can also set `PUBLIC_URL` (for example `set "PUBLIC_URL=http://myname.ddns.net:8080"`) to use a dynamic-DNS name in the links instead of your IP address. Your home IP can change from time to time; a free dynamic-DNS name follows it.

## Port forwarding

Most home routers accept the automatic (UPnP) request. If the app says it couldn't forward the port, set it up by hand once:

1. Find your computer's local IP. The launcher window prints it next to "Same Wi-Fi/LAN", e.g. `192.168.1.20`.
2. Open your router's admin page, usually `http://192.168.1.1` or `http://192.168.0.1` (the address is often on a sticker on the router).
3. Find **Port Forwarding** (sometimes under *NAT*, *Virtual Server* or *Advanced*), and add a rule:
   - External port **8080** → internal IP **your computer's IP** → internal port **8080**, protocol **TCP**.
4. Save. To stop your computer's local IP from changing, also give it a *DHCP reservation* on the same router.

Alternatively, turn on **UPnP** in the router settings and let ScreenDraw do it automatically.

## If friends can't connect

**The page doesn't load for them**

- Check that the server window is still open and the port is forwarded (see above).
- Check the firewall: on Windows, go to *Windows Security → Firewall → Allow an app*, and make sure Node.js is allowed on the network type you're on.
- Test from *outside* your network, e.g. from your phone on mobile data. Many routers can't open your own public address from inside your home (no "hairpin NAT"), so it may fail for you even when it works for friends.
- **"Behind another network" warning:** some internet providers (many mobile and fibre providers) share one public IP across lots of customers (carrier-grade NAT). Port forwarding on your router can't work then. You can:
  - ask your provider for a public IPv4 address (often free or cheap), or
  - use a tunnel instead of port forwarding, e.g. `cloudflared tunnel --url http://localhost:8080` or Tailscale Funnel. Set the URL it gives you as `PUBLIC_URL`, and set `UPNP=0`.

**The viewer says "Nobody is sharing in room …"**

The link is out of date. Every time you press Start sharing you get a new room code, so send the new link.

**Follow a connection in the server window**

Both the sharer and each viewer report every step to the server window. Viewers also see their latest step on screen. A working connection looks like this:

```
Viewer x8fc joined room k7m2qp
  sharer: viewer x8fc joined; preparing the video connection
  sharer: offer sent to viewer x8fc
  viewer x8fc: offer received from sharer
  viewer x8fc: video track received (video)
  viewer x8fc: answer sent to sharer
  viewer x8fc: network path connected
  sharer: viewer x8fc: connection connected
```

The last line before it stops shows where it went wrong. Lines like "could not…" or "rejected" include the actual error message.

Once connected, both sides report the video flow every so often:

```
  sharer: viewer x8fc: video out: 1920x1080 @ 24 fps, 1800 kbps, held back by: none, route srflx->srflx
  viewer x8fc: video in: 1920x1080 @ 24 fps, 1750 kbps, 512 frames shown, 0.1% packets lost, route srflx->host
```

- **`0 fps` on "video out"** means the sharer isn't producing frames. If you shared a single window, it may be minimised; share the whole screen instead.
- **"held back by: bandwidth"** means your upload speed (or your friend's download speed) is the limit.
- **Frames going out but "video in" stays at 0 fps or shows a lot of packet loss** means the network between you is dropping the video. A TURN server usually fixes that.

**The desktop app doesn't open or doesn't work**

Look at `sharer-app.log` in the ScreenDraw folder. The app writes its errors there, and serious ones also pop up in a dialog. If the launcher said the app couldn't be installed, scroll up in the launcher window to see the error. Running the launcher again retries the download.

**The page loads, but the screen never appears** ("Connection failed" / "Still connecting…")

The page loaded, but the direct peer-to-peer connection couldn't be made through one of the networks. This is rare on home networks and more common on strict work, school or mobile networks. Add a TURN relay server to `ICE_SERVERS` at the top of `public/rtc.js`. Free tiers are available from several providers, or you can self-host coturn.

## Viewer controls

| Action | How |
| --- | --- |
| Draw | Click/tap and drag on the screen |
| Change colour | Click a swatch, use the colour picker, or press `1`–`0` |
| Pen size | Slider, or `[` / `]` |
| Undo your last stroke | **Undo** or `Ctrl/Cmd+Z` |
| Remove your strokes | **Clear mine** |
| Fullscreen | ⛶ button or `F` |

The sharer can **Clear all drawings** and switch the overlay on or off. Viewers can only undo or clear their own strokes.

## Things to know

- **Who can join:** anyone with the link or room code. Room codes are random and change every time you start sharing.
- **Encryption:** video and drawings are always encrypted (WebRTC). The page and handshake use plain `http://`; use a tunnel or a reverse proxy with HTTPS if you need that too.
- **How many friends:** you send a separate video stream to each viewer, so roughly 5–8 at once works well, depending on your upload speed. The server allows up to 20 per room.
- **Linux:** on Linux, the overlay can't be hidden from the capture, so viewers also see the drawings in the video. Turn off "Show drawings on my screen" if that bothers you.
- **Clean-up:** the router port mapping is removed when you close the server window. If the window is force-killed, it expires on its own within 2 hours on most routers.

## How the overlay works

`electron/main.js` opens a frameless window that covers the chosen display and is transparent, click-through (`setIgnoreMouseEvents`), always on top, and excluded from the screen capture (`setContentProtection`), so viewers don't see every stroke twice. Strokes are stored in 0–1 coordinates relative to the shared frame, so they line up on every screen whatever its size.

## Project layout

```
Start ScreenDraw.bat     Windows one-click launcher
Start ScreenDraw.command macOS one-click launcher
start.sh                 macOS/Linux launcher
scripts/get-node.ps1     downloads a private Node.js for Windows (checksum-verified)
scripts/get-electron.ps1 downloads the desktop app runtime for Windows (checksum-verified)
server.js                signalling + static files + /info, zero dependencies
upnp.js                  automatic router port forwarding (UPnP IGD), zero dependencies
public/                  viewer page, browser sharer, shared WebRTC/drawing code
electron/                desktop sharer app and transparent overlay
```
