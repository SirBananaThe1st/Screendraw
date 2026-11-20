// Checks GitHub Releases for a newer ScreenDraw and, where possible, installs it.
//
//   Single-file ScreenDraw.exe (Windows): downloads the new .exe from the
//     release, swaps it in place of the one you launched, and restarts.
//   AppImage (Linux): same, for the .AppImage.
//   Anything else (folder version, running from source): shows the update and
//     opens the release page.
//
// The repository is set in package.json ("screendraw.updateRepo"). It must be
// public. Tags may be written "v0.2.6" or "0.2.6"; pre-releases are ignored.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { net, shell } = require('electron');

const pkg = require('../package.json');

function parseVersion(v) {
  const m = /(\d+)\.(\d+)(?:\.(\d+))?/.exec(String(v || ''));
  return m ? [Number(m[1]), Number(m[2]), Number(m[3] || 0)] : null;
}
function newer(a, b) { // is a > b ?
  for (let i = 0; i < 3; i++) { if (a[i] !== b[i]) return a[i] > b[i]; }
  return false;
}

function createUpdater({ app, log, send }) {
  const repo = process.env.SCREENDRAW_UPDATE_REPO || pkg.screendraw?.updateRepo;
  const api = (process.env.SCREENDRAW_UPDATE_API || 'https://api.github.com').replace(/\/+$/, '');
  const current = app.getVersion();
  const launcher = process.env.SCREENDRAW_LAUNCHER;   // set by the single-file exe
  const appImage = process.env.APPIMAGE;              // set by AppImage runtime
  let status = { state: 'idle', current };
  let release = null;
  let busy = false;

  // Leftover from the previous update.
  if (launcher) { try { fs.unlinkSync(`${launcher}.old`); } catch { /* none */ } }

  const set = (s) => { status = { current, ...s }; send(status); };

  function installTarget() {
    if (launcher && fs.existsSync(launcher)) return { kind: 'exe', file: launcher, match: (n) => /\.exe$/i.test(n) };
    if (appImage && fs.existsSync(appImage)) return { kind: 'appimage', file: appImage, match: (n) => /\.appimage$/i.test(n) && !/(aarch64|arm64)/i.test(n) };
    return null;
  }

  async function check(manual) {
    if (!repo) { if (manual) set({ state: 'check-failed', message: 'No update repository is configured.' }); return status; }
    if (busy) return status;
    try {
      const res = await net.fetch(`${api}/repos/${repo}/releases/latest`, { headers: { Accept: 'application/vnd.github+json', 'User-Agent': `ScreenDraw/${current}` }, cache: 'no-store' });
      if (res.status === 404) throw new Error('no published releases found (is the repository public?)');
      if (!res.ok) throw new Error(`GitHub answered ${res.status}`);
      const r = await res.json();
      const latest = parseVersion(r.tag_name) || parseVersion(r.name);
      const mine = parseVersion(current);
      if (!latest || !mine || !newer(latest, mine)) {
        release = null;
        set({ state: 'none', manual: !!manual, latest: r.tag_name });
        return status;
      }
      const target = installTarget();
      const asset = target ? (r.assets || []).find((a) => target.match(a.name)) : null;
      release = { version: latest.join('.'), tag: r.tag_name, url: r.html_url, notes: String(r.body || '').slice(0, 1500), asset, target };
      log(`update available: ${current} -> ${release.version}${asset ? ` (${asset.name})` : ' (manual download)'}`);
      set({ state: 'available', version: release.version, url: release.url, notes: release.notes, method: asset ? 'auto' : 'manual', manual: !!manual });
    } catch (err) {
      log(`update check failed: ${err.message}`);
      set({ state: 'check-failed', message: err.message, manual: !!manual });
    }
    return status;
  }

  async function download() {
    if (!release?.asset || busy) return;
    busy = true;
    const { asset, target } = release;
    const tmp = `${target.file}.download`;
    try {
      set({ state: 'downloading', version: release.version, percent: 0 });
      const res = await net.fetch(asset.browser_download_url, { headers: { 'User-Agent': `ScreenDraw/${current}` } });
      if (!res.ok || !res.body) throw new Error(`download failed (${res.status})`);
      const total = Number(res.headers.get('content-length')) || asset.size || 0;
      const out = fs.createWriteStream(tmp);
      const hash = crypto.createHash('sha256');
      const reader = res.body.getReader();
      let got = 0, lastPct = -1;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        hash.update(value);
        if (!out.write(Buffer.from(value))) await new Promise((r) => out.once('drain', r));
        got += value.length;
        const pct = total ? Math.floor((got / total) * 100) : 0;
        if (pct !== lastPct) { lastPct = pct; set({ state: 'downloading', version: release.version, percent: pct }); }
      }
      await new Promise((resolve, reject) => out.end((err) => (err ? reject(err) : resolve())));
      if (asset.size && got !== asset.size) throw new Error('the download was incomplete');
      // GitHub publishes a SHA-256 for release files; check it when present.
      const want = /^sha256:([0-9a-f]{64})$/i.exec(asset.digest || '');
      if (want && want[1].toLowerCase() !== hash.digest('hex')) throw new Error('the download was corrupted (checksum mismatch)');
      if (process.platform !== 'win32') fs.chmodSync(tmp, 0o755);
      release.downloaded = tmp;
      set({ state: 'ready', version: release.version });
    } catch (err) {
      try { fs.unlinkSync(tmp); } catch { /* none */ }
      log(`update download failed: ${err.message}`);
      set({ state: 'error', message: err.message, url: release.url });
    } finally { busy = false; }
  }

  function install() {
    if (!release?.downloaded) return;
    const file = release.target.file;
    try {
      if (release.target.kind === 'exe') {
        // The launcher isn't running (it exits once the app starts), so it can be swapped.
        try { fs.unlinkSync(`${file}.old`); } catch { /* none */ }
        fs.renameSync(file, `${file}.old`);
        try { fs.renameSync(release.downloaded, file); }
        catch (err) { fs.renameSync(`${file}.old`, file); throw err; }
      } else {
        fs.renameSync(release.downloaded, file); // replacing a running AppImage is fine on Linux
      }
      log(`installed ${release.version}; restarting`);
      spawn(file, [], { detached: true, stdio: 'ignore', cwd: path.dirname(file) }).unref();
      setTimeout(() => app.quit(), 300);
    } catch (err) {
      log(`update install failed: ${err.message}`);
      set({ state: 'error', message: `couldn't replace ${path.basename(file)} (${err.code || err.message}). Download it from the release page instead.`, url: release.url });
    }
  }

  function openPage() { if (release?.url || status.url) shell.openExternal(release?.url || status.url); }

  return { check, download, install, openPage, get status() { return status; } };
}

module.exports = { createUpdater, parseVersion, newer };
