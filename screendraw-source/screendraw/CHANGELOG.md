# Changelog

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
