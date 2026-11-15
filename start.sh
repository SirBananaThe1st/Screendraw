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

export SCREENDRAW_SERVER="http://localhost:$PORT"
NODE_DIR="$PWD/runtime/node"

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

if [ "$OPEN_SHARER" != "0" ]; then
  if [ ! -d node_modules/electron/dist ]; then
    echo " Installing the sharer app (one time only, about 100 MB)..."
    npm install --no-audit --no-fund --loglevel=error || true
  fi
  if [ -d node_modules/electron/dist ]; then
    ./node_modules/.bin/electron . >/dev/null 2>&1 &
  else
    echo
    echo " The sharer app couldn't be installed, so sharing will open in your browser instead."
    echo " Drawings will show over the preview rather than on your screen."
    (sleep 2; open_url "http://localhost:$PORT/share.html") &
  fi
fi

echo
exec node server.js
