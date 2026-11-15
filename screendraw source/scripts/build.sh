#!/usr/bin/env bash
# Builds the ScreenDraw desktop app from this folder, on Linux (or WSL):
#   dist/ScreenDraw-Windows-x64.zip      portable folder: unzip, run ScreenDraw.exe (fast start)
#   dist/ScreenDraw.exe                  single file for Windows (unpacks itself each launch)
#   dist/ScreenDraw-Linux-x86_64.AppImage  single file for Linux
#   dist/ScreenDraw-Server.zip           the server + launchers, for whoever hosts
# Everything is downloaded from official GitHub releases and checksum-verified
# where checksums are published.
set -euo pipefail
cd "$(dirname "$0")/.."
ROOT="$PWD"
ELECTRON_VERSION="${ELECTRON_VERSION:-33.4.11}"
SEVENZIP_TAG="25.01"; SEVENZIP_V="2501"
CACHE="${CACHE:-$ROOT/.build-cache}"
OUT="$ROOT/dist"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
mkdir -p "$CACHE" "$OUT"

fetch() { # url dest
  [ -s "$2" ] && return 0
  echo "  downloading $(basename "$2")"
  curl -fL --progress-bar -o "$2.part" "$1" && mv "$2.part" "$2"
}
electron_zip() { # platform-arch
  local file="electron-v$ELECTRON_VERSION-$1.zip" base="https://github.com/electron/electron/releases/download/v$ELECTRON_VERSION"
  fetch "$base/SHASUMS256.txt" "$CACHE/electron-$ELECTRON_VERSION-SHASUMS256.txt"
  fetch "$base/$file" "$CACHE/$file"
  local sum; sum="$(grep -E " \*?$file$" "$CACHE/electron-$ELECTRON_VERSION-SHASUMS256.txt" | cut -d' ' -f1)"
  echo "$sum  $CACHE/$file" | sha256sum -c --quiet - || { rm -f "$CACHE/$file"; echo "checksum mismatch for $file"; exit 1; }
  echo "$CACHE/$file"
}
copy_app() { # dest/resources/app  [windows|linux]
  mkdir -p "$1"
  cp package.json "$1/"
  cp -r app public "$1/"
  rm -rf "$1/app/native"                       # C++ source of the Windows audio helper
  [ "${2:-}" = windows ] || rm -rf "$1/app/bin" # the helper is Windows-only
}

echo "== ScreenDraw build (Electron $ELECTRON_VERSION)"

# Windows audio helper (per-app / per-device sound). Rebuilt when the llvm-mingw
# cross-compiler is available (set MINGW_BIN); otherwise the committed app/bin/sdaudio.exe is used.
if command -v "${MINGW_BIN:+$MINGW_BIN/}x86_64-w64-mingw32-clang++" >/dev/null 2>&1; then
  echo "-- compiling app/bin/sdaudio.exe"
  "${MINGW_BIN:+$MINGW_BIN/}x86_64-w64-mingw32-clang++" -std=c++17 -O2 -municode -static -s -o app/bin/sdaudio.exe app/native/sdaudio.cpp -lole32 -luuid -lksuser
fi
[ -f app/bin/sdaudio.exe ] || { echo "app/bin/sdaudio.exe is missing"; exit 1; }

# ---------------------------------------------------------------- Windows
echo "-- Windows (x64)"
WINZIP="$(electron_zip win32-x64 | tail -1)"
WIN="$WORK/ScreenDraw"
mkdir -p "$WIN" && unzip -q "$WINZIP" -d "$WIN"
mv "$WIN/electron.exe" "$WIN/ScreenDraw.exe"
rm -f "$WIN/resources/default_app.asar"
# Chromium's UI translations aren't needed (ScreenDraw's UI is English); keeps the zip under GitHub's 100 MB limit.
find "$WIN/locales" -name '*.pak' ! -name 'en-US.pak' ! -name 'en-GB.pak' -delete
copy_app "$WIN/resources/app" windows

# Single-file exe: 7-Zip archive + the official 7-Zip self-extractor (7zSD.sfx)
fetch "https://github.com/ip7z/7zip/releases/download/$SEVENZIP_TAG/7z$SEVENZIP_V-linux-x64.tar.xz" "$CACHE/7z-linux.tar.xz"
fetch "https://github.com/ip7z/7zip/releases/download/$SEVENZIP_TAG/lzma$SEVENZIP_V.7z" "$CACHE/lzma-sdk.7z"
mkdir -p "$WORK/7z" && tar -xJf "$CACHE/7z-linux.tar.xz" -C "$WORK/7z"
"$WORK/7z/7zz" e -y -o"$WORK" "$CACHE/lzma-sdk.7z" bin/7zSD.sfx >/dev/null
# Portable zip: standard Deflate (opens natively in Windows), maximum effort.
( cd "$WORK" && rm -f "$OUT/ScreenDraw-Windows-x64.zip" && "$WORK/7z/7zz" a -tzip -mx=9 -mm=Deflate -mfb=258 -mpass=15 -mmt=on "$OUT/ScreenDraw-Windows-x64.zip" ScreenDraw >/dev/null )
( cd "$WIN" && "$WORK/7z/7zz" a -t7z -mx=7 -mmt=on "$WORK/app.7z" . >/dev/null )
printf ';!@Install@!UTF-8!\nTitle="ScreenDraw"\nProgress="yes"\nRunProgram="ScreenDraw.exe"\n;!@InstallEnd@!\n' > "$WORK/sfx.txt"
cat "$WORK/7zSD.sfx" "$WORK/sfx.txt" "$WORK/app.7z" > "$OUT/ScreenDraw.exe"

# ------------------------------------------------------------------ Linux
echo "-- Linux (x86_64 AppImage)"
LINZIP="$(electron_zip linux-x64 | tail -1)"
APPDIR="$WORK/ScreenDraw.AppDir"
mkdir -p "$APPDIR/usr/lib/screendraw"
unzip -q "$LINZIP" -d "$APPDIR/usr/lib/screendraw"
mv "$APPDIR/usr/lib/screendraw/electron" "$APPDIR/usr/lib/screendraw/screendraw"
rm -f "$APPDIR/usr/lib/screendraw/resources/default_app.asar"
copy_app "$APPDIR/usr/lib/screendraw/resources/app" linux
cp app/icon.png "$APPDIR/screendraw.png"
cat > "$APPDIR/screendraw.desktop" <<'EOF'
[Desktop Entry]
Type=Application
Name=ScreenDraw
Comment=Share your screen and draw on it together
Exec=screendraw
Icon=screendraw
Categories=Network;Graphics;
EOF
cat > "$APPDIR/AppRun" <<'EOF'
#!/bin/sh
HERE="$(dirname "$(readlink -f "$0")")"
# Chromium's setuid sandbox can't work from inside an AppImage.
exec "$HERE/usr/lib/screendraw/screendraw" --no-sandbox "$@"
EOF
chmod +x "$APPDIR/AppRun"
fetch "https://github.com/AppImage/appimagetool/releases/download/continuous/appimagetool-x86_64.AppImage" "$CACHE/appimagetool.AppImage"
fetch "https://github.com/AppImage/type2-runtime/releases/download/continuous/runtime-x86_64" "$CACHE/runtime-x86_64"
chmod +x "$CACHE/appimagetool.AppImage"
ARCH=x86_64 "$CACHE/appimagetool.AppImage" --appimage-extract-and-run --no-appstream --runtime-file "$CACHE/runtime-x86_64" \
  "$APPDIR" "$OUT/ScreenDraw-Linux-x86_64.AppImage" >/dev/null 2>"$WORK/appimagetool.log" || { cat "$WORK/appimagetool.log"; exit 1; }

# ----------------------------------------------------------------- Server
echo "-- Server package"
SRV="$WORK/ScreenDraw-Server"
mkdir -p "$SRV/scripts"
cp -r server public "$SRV/"
cp .env.example "Start ScreenDraw Server.bat" start-server.sh scripts/get-node.ps1 "$SRV/" 2>/dev/null || true
mv "$SRV/get-node.ps1" "$SRV/scripts/"
cp README.md "$SRV/" 2>/dev/null || true
chmod +x "$SRV/start-server.sh"
( cd "$WORK" && rm -f "$OUT/ScreenDraw-Server.zip" && zip -qr -9 "$OUT/ScreenDraw-Server.zip" ScreenDraw-Server )

echo "== Done:"
ls -la "$OUT"
