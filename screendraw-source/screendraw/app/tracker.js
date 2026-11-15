// Follows the on-screen position of a shared application window, so the
// drawing overlay can sit exactly on top of it.
//  - Windows: a small persistent PowerShell helper asks the OS (DWM) for the
//    window's visible bounds.
//  - Linux (X11): xwininfo.
//  - macOS: not supported; drawings still show for viewers.
const { spawn, execFile } = require('child_process');
const { screen } = require('electron');

const PS_HELPER = `
$ErrorActionPreference = 'SilentlyContinue'
Add-Type @"
using System; using System.Runtime.InteropServices;
public static class SDW {
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; }
  [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("dwmapi.dll")] public static extern int DwmGetWindowAttribute(IntPtr h, int a, out RECT r, int s);
  [DllImport("user32.dll")] public static extern IntPtr SetThreadDpiAwarenessContext(IntPtr c);
}
"@
[void][SDW]::SetThreadDpiAwarenessContext([IntPtr](-4))
while ($true) {
  $line = [Console]::In.ReadLine()
  if ($line -eq $null) { break }
  $h = [IntPtr][Int64]$line
  if (-not [SDW]::IsWindow($h)) { [Console]::Out.WriteLine('gone'); [Console]::Out.Flush(); continue }
  $r = New-Object SDW+RECT
  if ([SDW]::DwmGetWindowAttribute($h, 9, [ref]$r, 16) -ne 0) { [void][SDW]::GetWindowRect($h, [ref]$r) }
  [Console]::Out.WriteLine(('{0} {1} {2} {3} {4} {5}' -f $r.L, $r.T, ($r.R - $r.L), ($r.B - $r.T), [int][SDW]::IsIconic($h), [int][SDW]::IsWindowVisible($h)))
  [Console]::Out.Flush()
}
`;

class WindowTracker {
  constructor(sourceId, onBounds, log) {
    this.id = (/^window:(\d+)/.exec(sourceId) || [])[1];
    this.onBounds = onBounds;
    this.log = log;
    this.last = '';
  }

  get supported() { return !!this.id && (process.platform === 'win32' || process.platform === 'linux'); }

  start() {
    if (!this.supported) { this.onBounds(null); return false; }
    if (process.platform === 'win32') this._startWindows();
    else this._startLinux();
    return true;
  }

  _emit(rect) {
    const key = rect ? `${rect.x},${rect.y},${rect.width},${rect.height}` : 'none';
    if (key === this.last) return;
    this.last = key;
    this.onBounds(rect);
  }

  _startWindows() {
    const encoded = Buffer.from(PS_HELPER, 'utf16le').toString('base64');
    this.proc = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded], { windowsHide: true });
    let buf = '';
    this.proc.stdout.on('data', (d) => {
      buf += d.toString();
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (!line) continue;
        if (line === 'gone') { this._emit(null); continue; }
        const [x, y, w, h, iconic, visible] = line.split(' ').map(Number);
        if (iconic || !visible || w <= 0 || h <= 0) { this._emit(null); continue; }
        // Physical pixels -> Electron's DIP coordinates (handles display scaling).
        const dip = screen.screenToDipRect(null, { x, y, width: w, height: h });
        this._emit(dip);
      }
    });
    this.proc.on('error', (err) => this.log?.(`window tracker failed: ${err.message}`));
    this.proc.on('exit', () => { this.proc = null; });
    this.timer = setInterval(() => { try { this.proc?.stdin.write(`${this.id}\n`); } catch { /* exited */ } }, 200);
  }

  _startLinux() {
    const poll = () => {
      execFile('xwininfo', ['-id', this.id], { timeout: 1000 }, (err, out) => {
        if (err) {
          if (err.code === 'ENOENT' && !this.warned) { this.warned = true; this.log?.('xwininfo is not installed; drawings won\'t follow the shared window on your screen'); }
          return this._emit(null);
        }
        const n = (label) => Number((new RegExp(`${label}:\\s+(-?\\d+)`).exec(out) || [])[1]);
        const viewable = /Map State:\s+IsViewable/.test(out);
        const rect = { x: n('Absolute upper-left X'), y: n('Absolute upper-left Y'), width: n('Width'), height: n('Height') };
        this._emit(viewable && rect.width > 0 ? rect : null);
      });
    };
    poll();
    this.timer = setInterval(poll, 250);
  }

  stop() {
    clearInterval(this.timer);
    try { this.proc?.stdin.end(); this.proc?.kill(); } catch { /* ignore */ }
    this.proc = null;
  }
}

module.exports = { WindowTracker };
