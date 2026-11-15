#!/usr/bin/env bash
# ScreenDraw server launcher for Linux and macOS.
set -euo pipefail
cd "$(dirname "$0")"
echo
echo " ScreenDraw server"
echo " -----------------"
if [ ! -f .env ] && [ -f .env.example ]; then cp .env.example .env; echo " Created .env with default settings - edit it to change the port, password etc."; fi

NODE_DIR="$PWD/runtime/node"
node_ok() { command -v node >/dev/null 2>&1 && node -e "process.exit(parseInt(process.versions.node) < 18 ? 1 : 0)"; }
get_node() {
  local os arch base file sum tmp
  case "$(uname -s)" in Darwin) os=darwin ;; Linux) os=linux ;; *) return 1 ;; esac
  case "$(uname -m)" in x86_64|amd64) arch=x64 ;; arm64|aarch64) arch=arm64 ;; *) return 1 ;; esac
  base="https://nodejs.org/dist/latest-v24.x"
  echo " Node.js not found - downloading a private copy (one time only, about 30 MB)..."
  read -r sum file < <(curl -fsSL "$base/SHASUMS256.txt" | grep -E " node-v[0-9.]+-$os-$arch\.tar\.gz$" | head -1) || true
  [ -n "${file:-}" ] || return 1
  tmp="$(mktemp -d)"
  curl -fL --progress-bar "$base/$file" -o "$tmp/$file" || return 1
  if command -v sha256sum >/dev/null; then echo "$sum  $tmp/$file" | sha256sum -c --quiet - || return 1
  else echo "$sum  $tmp/$file" | shasum -a 256 -c --quiet - || return 1; fi
  tar -xzf "$tmp/$file" -C "$tmp" || return 1
  rm -rf "$NODE_DIR"; mkdir -p "$(dirname "$NODE_DIR")"; mv "$tmp/${file%.tar.gz}" "$NODE_DIR"; rm -rf "$tmp"
}
if [ -x "$NODE_DIR/bin/node" ]; then export PATH="$NODE_DIR/bin:$PATH"
elif ! node_ok; then
  get_node || { echo " Could not download Node.js. Install it from https://nodejs.org and try again."; read -rp " Press Enter to close."; exit 1; }
  export PATH="$NODE_DIR/bin:$PATH"
fi
echo
exec node server/server.js
