# Changelog

Version numbers follow the GitHub releases. The 0.2.x entries below were development builds leading up to V1.0.0.

## 1.4.0 — 2026-11-20

### Added
- **Clear one person's drawings.** The person sharing can clear the drawings and stickers of one person instead of everyone's:
  - The **Clear** button at the bottom of the tool rail now lists everyone who has something on the screen, with how many drawings and stickers each has. Pointing at a name fades everyone else's, so you can see what will go. **Everyone's drawings and stickers** is still at the bottom.
  - Or click someone's avatar in the top bar.
  - Works for people who have already left the room too; they're marked "(left)".

### Fixed
- The red ring on the sharer's avatar now updates as soon as someone starts or stops sharing.

## 1.3.1 — 2026-11-20

### Fixed
- Opening ScreenDraw a second time now brings the existing window forward instead of starting another full copy of the app (and another set of background processes).

## 1.3.0 — 2026-11-20

### Added
- **Sticker layers.** Select a sticker with the Move tool, then use the new Arrange button in the tool rail or right-click it:
  - **Bring to front**, **Bring forward**, **Send backward**, **Send to back** (also Ctrl+Shift+], Ctrl+], Ctrl+[ and Ctrl+Shift+[).
  - **In front of drawings:** by default stickers sit behind the pen strokes; turn this on to put a sticker over them.
  - The order is shared with everyone in the room, including people who join later and the drawings on the sharer's real screen.
- New stickers no longer land exactly on top of each other.

### Fixed
- **Ghost copies of stickers and cursors** when the sharer uses the Windows app: ScreenDraw now re-applies "keep out of the screen capture" to its own window and to the drawing overlay whenever they're shown, restored, moved or resized. Windows could drop that setting after a window was hidden and shown again, which put ScreenDraw's own stickers back into the shared video.
- The selection frame around a sticker is now drawn on top, so it stays visible for stickers in front of the drawings.

### Changed
- Clearer tip when the sharer's system or browser can't keep ScreenDraw out of a whole-screen share.

## 1.2.0 — 2026-11-19

### Changed
- **New interface.** Graphite controls over a black stage, the IBM Plex Sans typeface, and square-edged controls instead of rounded boxes.
- **Full-screen sharing.** The shared screen fills the window. During a share the top bar and the new tool rail on the left fold away after two seconds; move the pointer to the top or left edge, select the controls button in the bottom-right corner or press **H** to bring them back. A pin in the top bar keeps them visible.
- **All emoji replaced with line icons** (Lucide) in the room, dialogs, the update bar and the draw-on-screen toolbar.
- **Tool rail:** colour and size moved into small pop-outs; the active tool is marked in your pen colour.
- **People** show as avatars with initials; the person sharing has a red ring, and you have a white one (select it to change your name or cursor colour).
- Sound, volume and quality controls only show for viewers. The connection indicator is a dot unless something is wrong.
- Toasts appear at the bottom centre, and the update bar at the top.
- New app and window icon.

### Fixed
- Icon buttons could miss a click when their icon changed under the pointer.

## 1.1.0 — 2026-11-19

### Added
- **Update checks** against the GitHub releases (`SirBananaThe1st/Screendraw`), shortly after start and every 6 hours, with a "Check for updates" link on the join screen.
  - **Single-file `ScreenDraw.exe` and Linux AppImage:** *Update* downloads the new file, checks it against GitHub's SHA-256, swaps it in and restarts. The previous exe is kept as `ScreenDraw.exe.old` until the next start.
  - **Folder version:** *Download* opens the release page.
  - *Skip this version* hides a release until a newer one comes out.
- The server window mentions when a newer release is available.

### Security / privacy
- The server's public `/info` no longer reveals your home-network IP addresses or port-forwarding details. They still show in your server window.
- Added `.gitignore` for `.env`, logs, downloaded runtimes and build output.
- Example addresses in the README and on the join screen use reserved documentation addresses.

## 0.2.5 — 2026-11-19

### Added
- **Animated GIF stickers.** GIFs added by file picker or drag-and-drop stay animated for everyone, including on the sharer's on-screen overlay. A GIF over the size limit is added as a still image, with a message saying so.
- New `.env` settings: `MAX_GIF_KB` (largest GIF, default 2048 KB) and `MAX_ROOM_STICKERS_MB` (total sticker space per room, default 24 MB, so joining a room stays quick).

### Fixed
- **Ghost trails and doubled cursors/stickers** when sharing the whole screen. ScreenDraw's own window (your preview with everyone's cursors and stickers) was being captured and sent back to viewers. While you share, the app now keeps its own window out of the capture, as it already did for the overlay (Windows 10 2004+ and macOS).
- **Hide my preview** now also hides the drawings, stickers and cursors in your own view.
- On Linux, and when sharing the whole screen from a browser, where ScreenDraw can't hide itself from the capture, a one-time tip suggests "Hide my preview" or minimising ScreenDraw.

### Changed
- Stickers are now shown as images under the drawing layer instead of being painted onto it, so ink still draws on top of them.

## 0.2.4 — 2026-11-15

### Added
- **⟳ Reload button** (or press **R**) next to the stats button whenever someone is sharing. It rebuilds the video connection without leaving the room, which fixes a frozen, black or stuck picture. For the sharer, it refreshes their own preview and sends viewers a fresh full frame.

### Fixed
- **Black screen after resizing the window** (or going fullscreen) while watching a share sent through the server. The latest frame is now kept and redrawn at the new size, so a still screen no longer disappears until it changes.

## 0.2.3 — 2026-11-15

### Fixed
- **"Could not start video source" when sharing an app window.** Capture now starts with a simple request and applies resolution/frame-rate limits afterwards. If Windows still refuses, it retries in simpler ways and then shows the likely reason. Failures are logged to the server window.
- **"This program might not have installed correctly — 7z Setup SFX" prompt** when closing the single-file exe. The 7-Zip installer stub is replaced by a ScreenDraw launcher with its own name, icon and manifest.

### Changed
- `ScreenDraw.exe` unpacks only on first launch, into `%LOCALAPPDATA%\ScreenDraw\app`, so later launches start instantly. Old versions are cleaned up automatically. The exe is now 69 MB (was 79 MB).

## 0.2.2 — 2026-11-15

### Added
- **Choose what sound to share** (desktop app, Windows and Linux):
  - Only the shared app: the default for window shares.
  - Everything you hear.
  - Everything except chosen apps, e.g. Discord, to stop echo.
  - Only chosen apps.
  - Only chosen output devices, e.g. "Game" but not "Chat". You can pick more than one.
- **Cursor colour:** click your name in the top bar to change your name or colour.
- **Hide my preview:** the sharer can stop showing their own share to save CPU/GPU. Viewers are unaffected.

### Technical
- Windows: new audio helper `sdaudio.exe` (WASAPI per-process and per-device loopback). Per-app options need Windows 10 version 2004+.
- Linux: sound routing through PipeWire (`pw-dump`, `pw-link`, `parec`) via a temporary silent "ScreenDraw-capture" output, which doesn't change what you hear. Plain PulseAudio: output devices only.

## 0.2.1 — 2026-11-15

### Changed
- Windows folder zip trimmed to 96.6 MB, under GitHub's 100 MB file limit. Unused Chromium language packs were removed (English kept) and the zip uses stronger standard compression.
- Bare `.exe` downloads were being blocked, so the exe is also provided inside a zip.

## 0.2.0 — 2026-11-15

A rewrite covering the 13 requested features.

### Added
1. **Audio** in shares (system audio in the Windows app; tab or system audio from Chrome or Edge).
2. **Quality controls:** the sharer picks max resolution and frame rate. Each viewer picks Auto, High or Data saver.
3. **Better performance at high resolutions:** up to 60 fps, H.264 preferred (hardware encoding), "Text & detail" or "Motion & video" modes, and higher bitrates.
4. **Vanishing ink** that fades after 1.5–10 seconds.
5. **Image stickers:** add by file, paste or drag-and-drop, then move, resize and delete.
6. **Desktop app** (`ScreenDraw.exe`) that asks for the server address on first launch and remembers it, with a forget option. The server runs separately from `Start ScreenDraw Server.bat`.
7. **Send video through the server** (relay) as an alternative to direct P2P, chosen per share. The default is set in `.env`.
8. **Share a single app window** as well as the full screen. The drawing overlay follows the window on Windows and Linux/X11.
9. **Native Linux build** (AppImage).
10. **Everyone's cursor with their name** shown on the shared screen.
11. **Anyone can share:** clicking Share screen takes over from the current sharer.
12. **Sharer can draw on their own screen** (Ctrl+Shift+D).
13. **`.env` settings file:** port, UPnP, public URL, password, default video route, TURN, limits.

### Also new
- Optional server password.
- Fallback connection for networks that block WebSockets.
- Live stats panel.
- Auto quality drop when a viewer's connection struggles.
- Server-side protection so people can only edit or clear their own drawings.
