#!/usr/bin/env bash
# ScreenDraw launcher for macOS and Linux.
# Installs what it needs on first run, then starts the server and the sharer app.
set -euo pipefail
cd "$(dirname "$0")"

# ================= Settings =================
export PORT="${PORT:-8080}"          # forward this port (TCP) on your router if it isn't done automatically
export UPNP="${UPNP:-1}"             # 0 = don't ask the router to forward the port
OPEN_SHARER="${OPEN_SHARER:-1}"      # 0 = only run the server
# ============================================

ELECTRON_VERSION="33.4.11"           # runtime for the desktop sharer app

export SCREENDRAW_SERVER="http://localhost:$PORT"
NODE_DIR="$PWD/runtime/node"
ELECTRON_DIR="$PWD/runtime/electron"

echo
echo " ScreenDraw launcher"
echo " -------------------"

node_ok() { command -v node >/dev/null 2>&1 && node -e "process.exit(parseInt(process.versions.node) < 18 ? 1 : 0)"; }

get_node() {
  local os arch base file sum tmp
  case "$(uname -s)" in Darwin) os=darwin ;; Linux) os=linux ;; *) echo "Unsupported OS"; exit 1 ;; esac
  case "$(uname -m)" in x86_64|amd64) arch=x64 ;; arm64|aarch64) arch=arm64 ;; *) echo "Unsupported CPU: $(uname -m)"; exit 1 ;; esac
  base="https://nodejs.org/dist/latest-v24.x"
  echo " Node.js not found - downloading a private copy (one time only, about 30 MB)..."
  read -r sum file < <(curl -fsSL "$base/SHASUMS256.txt" | grep -E " node-v[0-9.]+-$os-$arch\.tar\.gz$" | head -1) || true
  [ -n "${file:-}" ] || return 1
  tmp="$(mktemp -d)"
  curl -fL --progress-bar "$base/$file" -o "$tmp/$file" || return 1
  if command -v sha256sum >/dev/null; then echo "$sum  $tmp/$file" | sha256sum -c --quiet - || return 1
  else echo "$sum  $tmp/$file" | shasum -a 256 -c --quiet - || return 1; fi
  tar -xzf "$tmp/$file" -C "$tmp" || return 1
  rm -rf "$NODE_DIR"; mkdir -p "$(dirname "$NODE_DIR")"
  mv "$tmp/${file%.tar.gz}" "$NODE_DIR" || return 1
  rm -rf "$tmp"
}

if [ -x "$NODE_DIR/bin/node" ]; then
  export PATH="$NODE_DIR/bin:$PATH"; echo " Using bundled Node.js"
elif node_ok; then
  echo " Using installed Node.js"
else
  get_node || { echo; echo " Could not download Node.js. Install it from https://nodejs.org and try again."; read -rp " Press Enter to close."; exit 1; }
  export PATH="$NODE_DIR/bin:$PATH"; echo " Using bundled Node.js"
fi

open_url() { if [ "$(uname -s)" = Darwin ]; then open "$1"; else xdg-open "$1"; fi >/dev/null 2>&1 || true; }

electron_bin() {
  if [ "$(uname -s)" = Darwin ]; then echo "$ELECTRON_DIR/Electron.app/Contents/MacOS/Electron"; else echo "$ELECTRON_DIR/electron"; fi
}

# Downloads Electron straight from its official GitHub releases (checksum-verified).
# npm isn't used because newer npm versions block Electron's own download step.
get_electron() {
  local os arch file base sum tmp
  case "$(uname -s)" in Darwin) os=darwin ;; Linux) os=linux ;; *) return 1 ;; esac
  case "$(uname -m)" in x86_64|amd64) arch=x64 ;; arm64|aarch64) arch=arm64 ;; *) return 1 ;; esac
  file="electron-v$ELECTRON_VERSION-$os-$arch.zip"
  base="https://github.com/electron/electron/releases/download/v$ELECTRON_VERSION"
  sum="$(curl -fsSL "$base/SHASUMS256.txt" | grep -E " \*?$file$" | cut -d' ' -f1)" || true
  [ -n "$sum" ] || { echo " ERROR: couldn't get the Electron download list."; return 1; }
  tmp="$(mktemp -d)"
  echo " Downloading $file (about 110 MB)..."
  curl -fL --progress-bar "$base/$file" -o "$tmp/$file" || return 1
  if command -v sha256sum >/dev/null; then echo "$sum  $tmp/$file" | sha256sum -c --quiet - || return 1
  else echo "$sum  $tmp/$file" | shasum -a 256 -c --quiet - || return 1; fi
  rm -rf "$ELECTRON_DIR"; mkdir -p "$ELECTRON_DIR"
  if [ "$os" = darwin ]; then ditto -x -k "$tmp/$file" "$ELECTRON_DIR" || return 1
  elif command -v unzip >/dev/null; then unzip -q "$tmp/$file" -d "$ELECTRON_DIR" || return 1
  elif command -v bsdtar >/dev/null; then bsdtar -xf "$tmp/$file" -C "$ELECTRON_DIR" || return 1
  else echo " ERROR: please install 'unzip' and run this again."; return 1; fi
  rm -rf "$tmp"
  [ -x "$(electron_bin)" ]
}

if [ "$OPEN_SHARER" != "0" ]; then
  if [ ! -x "$(electron_bin)" ]; then
    echo " Downloading the sharer app (one time only)..."
    get_electron || echo " The download failed - see the error above."
  fi
  if [ -x "$(electron_bin)" ]; then
    echo " Opening the ScreenDraw sharer app... (if it doesn't appear, see sharer-app.log)"
    extra=()
    # Many Linux distros restrict the sandbox Electron needs; the app only loads its own local files.
    [ "$(uname -s)" = Linux ] && extra=(--no-sandbox)
    "$(electron_bin)" "${extra[@]}" "$PWD" >>sharer-app.log 2>&1 &
  else
    echo
    echo " The sharer app couldn't be installed (run this again to retry), so sharing will open in"
    echo " your browser instead. Drawings will show over the preview rather than on your screen."
    (sleep 2; open_url "http://localhost:$PORT/share.html") &
  fi
fi

echo
exec node server.js
