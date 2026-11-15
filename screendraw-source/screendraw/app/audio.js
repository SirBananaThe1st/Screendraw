// Chooses what sound to share: one or more apps, everything except some apps,
// or one or more output devices (e.g. "Chat" / "Game"). Audio is delivered to
// the renderer as 16-bit stereo PCM chunks: send(index, sampleRate, Buffer).
//
//   Windows: app/bin/sdaudio.exe (WASAPI; per-app needs Windows 10 2004+)
//   Linux:   PipeWire (pw-dump + pw-link + parec/pw-record) — copies of the chosen
//            apps' / devices' sound are linked into a private, silent virtual
//            output that ScreenDraw records, so what you hear doesn't change.
//            Plain PulseAudio (no PipeWire): output devices only.
//   SCREENDRAW_FAKE_AUDIO=1: generated tones, for testing.
const { spawn, execFile } = require('child_process');
const fs = require('fs');
const path = require('path');

const MIX_SINK = 'screendraw_mix';

const run = (cmd, args, opts = {}) => new Promise((resolve) => {
  execFile(cmd, args, { timeout: 5000, maxBuffer: 64 * 1024 * 1024, windowsHide: true, ...opts }, (err, stdout, stderr) => resolve({ err, stdout: String(stdout || ''), stderr: String(stderr || '') }));
});
const has = async (cmd) => !(await run('sh', ['-c', `command -v ${cmd}`])).err;
const norm = (s) => String(s || '').toLowerCase().replace(/\.exe$/, '');

/* ------------------------------------------------------------- frame parser */
// 'S' idx u16 len(u32 LE) + PCM — used for the Windows helper.
function frameParser(onFrame) {
  let buf = Buffer.alloc(0);
  return (chunk) => {
    buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
    while (buf.length >= 8) {
      if (buf[0] !== 0x53) { buf = Buffer.alloc(0); return; } // out of sync: drop
      const len = buf.readUInt32LE(4);
      if (buf.length < 8 + len) return;
      onFrame(buf[1], buf.subarray(8, 8 + len));
      buf = buf.subarray(8 + len);
    }
  };
}

/* ============================================================== Windows */
class WindowsAudio {
  constructor(opts) { Object.assign(this, opts); this.helper = path.join(__dirname, 'bin', 'sdaudio.exe'); }

  async info() {
    const ok = fs.existsSync(this.helper);
    return { available: ok, backend: 'windows', system: true, reason: ok ? '' : 'audio helper missing' };
  }

  async list(windowSourceId) {
    const hwnd = (/^window:(\d+)/.exec(windowSourceId || '') || [])[1];
    const r = await run(this.helper, ['list', ...(hwnd ? [hwnd] : [])]);
    if (r.err) throw new Error(`audio helper failed: ${r.stderr || r.err.message}`);
    const data = JSON.parse(r.stdout);
    return { devices: data.devices || [], apps: data.apps || [], window: data.window, perApp: !!data.perApp, backend: 'windows' };
  }

  async start(spec) {
    if (spec.mode === 'system') return { useSystemLoopback: true };
    const list = await this.list(spec.windowSourceId);
    const specs = [];
    this.included = new Set();
    const include = (app) => { if (!this.included.has(app.pid)) { this.included.add(app.pid); specs.push(`include:${app.pid}`); } };
    const wanted = new Set((spec.apps || []).map(norm));
    const excluded = new Set((spec.except || []).map(norm));

    if (spec.mode === 'window' && list.window) include(list.window);
    else if (spec.mode === 'apps') list.apps.filter((a) => wanted.has(norm(a.name))).forEach(include);
    else if (spec.mode === 'except') {
      const ex = list.apps.filter((a) => excluded.has(norm(a.name)));
      // One app: Windows can capture "everything except this app" directly,
      // which also covers apps that start playing later.
      if (excluded.size === 1 && ex.length === 1) specs.push(`exclude:${ex[0].pid}`);
      else { this.rescanExcept = excluded; list.apps.filter((a) => !excluded.has(norm(a.name))).forEach(include); }
    } else if (spec.mode === 'devices') for (const id of spec.devices || []) specs.push(`device:${id}`);
    if (spec.mode === 'apps') this.rescanApps = wanted;

    this.proc = spawn(this.helper, ['capture', ...specs], { windowsHide: true });
    const rates = new Map();
    this.proc.stdout.on('data', frameParser((idx, pcm) => this.send(idx, rates.get(idx) || 48000, pcm)));
    let errBuf = '';
    this.proc.stderr.on('data', (d) => {
      errBuf += d;
      let i;
      while ((i = errBuf.indexOf('\n')) >= 0) {
        const line = errBuf.slice(0, i).trim(); errBuf = errBuf.slice(i + 1);
        const ready = /^READY (\d+) (\d+)/.exec(line);
        if (ready) rates.set(Number(ready[1]), Number(ready[2]));
        else if (line.startsWith('ERROR')) this.status(line.replace(/^ERROR \d+ /, ''));
        this.log(`audio helper: ${line}`);
      }
    });
    this.proc.on('exit', () => { this.proc = null; });

    // New apps that start playing sound later are added while sharing.
    if (this.rescanApps || this.rescanExcept) {
      this.timer = setInterval(async () => {
        try {
          const now = await this.list();
          for (const a of now.apps) {
            const match = this.rescanApps ? this.rescanApps.has(norm(a.name)) : !this.rescanExcept.has(norm(a.name));
            if (match && !this.included.has(a.pid) && this.proc) { this.included.add(a.pid); this.proc.stdin.write(`add include:${a.pid}\n`); }
          }
        } catch { /* try again next time */ }
      }, 3000);
    }
    return { ok: true, sources: specs.length };
  }

  stop() {
    clearInterval(this.timer); this.timer = null;
    this.rescanApps = this.rescanExcept = null;
    try { this.proc?.stdin.end(); } catch { /* ignore */ }
    const p = this.proc;
    setTimeout(() => { try { p?.kill(); } catch { /* ignore */ } }, 1500);
    this.proc = null;
  }
}

/* ================================================================ Linux */
class LinuxAudio {
  constructor(opts) { Object.assign(this, opts); }

  async tools() {
    if (!this._tools) {
      const [pwDump, pwLink, parec, pwRecord, pactl, pwCli] = await Promise.all(['pw-dump', 'pw-link', 'parec', 'pw-record', 'pactl', 'pw-cli'].map(has));
      this._tools = { pwDump, pwLink, parec, pwRecord, pactl, pwCli, pipewire: pwDump && pwLink && (parec || pwRecord) && (pactl || pwCli) };
    }
    return this._tools;
  }

  async info() {
    const t = await this.tools();
    if (t.pipewire) return { available: true, backend: 'pipewire', system: true };
    if (t.pactl && t.parec) return { available: true, backend: 'pulseaudio', system: false, reason: 'Only output devices can be shared on PulseAudio. Per-app sound needs PipeWire.' };
    return { available: false, backend: 'none', reason: 'Sharing sound from the app on Linux needs PipeWire (pw-dump, pw-link) or PulseAudio tools (pactl, parec).' };
  }

  // Our own process tree (so ScreenDraw never captures itself).
  ownPids() {
    const pids = new Set([process.pid]);
    try {
      const parents = new Map();
      for (const d of fs.readdirSync('/proc')) {
        if (!/^\d+$/.test(d)) continue;
        try { const stat = fs.readFileSync(`/proc/${d}/stat`, 'utf8'); parents.set(Number(d), Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[1])); } catch { /* gone */ }
      }
      let grew = true;
      while (grew) { grew = false; for (const [pid, ppid] of parents) if (pids.has(ppid) && !pids.has(pid)) { pids.add(pid); grew = true; } }
    } catch { /* ignore */ }
    return pids;
  }

  async graph() {
    const r = await run('pw-dump', []);
    if (r.err) throw new Error('pw-dump failed');
    const objs = JSON.parse(r.stdout);
    const nodes = [], ports = [], links = new Set();
    let defaultSink = null;
    for (const o of objs) {
      const props = o.info?.props || {};
      if (o.type === 'PipeWire:Interface:Node') nodes.push({ id: o.id, props, state: o.info?.state });
      else if (o.type === 'PipeWire:Interface:Port') ports.push({ id: o.id, node: props['node.id'], dir: o.info?.direction, channel: props['audio.channel'], monitor: props['port.monitor'] === true || props['port.monitor'] === 'true' });
      else if (o.type === 'PipeWire:Interface:Link') links.add(`${o.info?.['output-port-id']}>${o.info?.['input-port-id']}`);
      else if (o.type === 'PipeWire:Interface:Metadata' && (o.props?.['metadata.name'] || props['metadata.name']) === 'default') {
        for (const m of o.metadata || []) if (m.key === 'default.audio.sink') defaultSink = m.value?.name || null;
      }
    }
    return { nodes, ports, links, defaultSink };
  }

  appStreams(g) {
    const own = this.ownPids();
    return g.nodes.filter((n) => n.props['media.class'] === 'Stream/Output/Audio' && !own.has(Number(n.props['application.process.id'])))
      .map((n) => ({ node: n.id, pid: Number(n.props['application.process.id']) || 0, name: n.props['application.name'] || n.props['application.process.binary'] || n.props['node.name'] || 'App', binary: n.props['application.process.binary'] || '', playing: n.state === 'running' }));
  }

  async list(windowSourceId) {
    const t = await this.tools();
    if (t.pipewire) {
      const g = await this.graph();
      const devices = g.nodes.filter((n) => n.props['media.class'] === 'Audio/Sink' && n.props['node.name'] !== MIX_SINK)
        .map((n) => ({ id: n.props['node.name'], name: n.props['node.description'] || n.props['node.nick'] || n.props['node.name'], default: n.props['node.name'] === g.defaultSink }));
      const byName = new Map();
      for (const s of this.appStreams(g)) {
        const key = norm(s.name);
        const e = byName.get(key) || { pid: s.pid, name: s.name, playing: false };
        e.playing = e.playing || s.playing;
        byName.set(key, e);
      }
      return { devices, apps: [...byName.values()], window: await this.windowApp(windowSourceId, [...byName.values()]), perApp: true, backend: 'pipewire' };
    }
    if (t.pactl) {
      const r = await run('pactl', ['-f', 'json', 'list', 'sinks']);
      const def = (await run('pactl', ['get-default-sink'])).stdout.trim();
      let sinks = [];
      try { sinks = JSON.parse(r.stdout); } catch { /* old pactl */ }
      return { devices: sinks.map((s) => ({ id: s.name, name: s.description || s.name, default: s.name === def })), apps: [], window: null, perApp: false, backend: 'pulseaudio' };
    }
    return { devices: [], apps: [], window: null, perApp: false, backend: 'none' };
  }

  // Which app owns a shared X11 window: _NET_WM_PID via xprop, else match the title.
  async windowApp(sourceId, apps) {
    const xid = (/^window:(\d+)/.exec(sourceId || '') || [])[1];
    if (!xid) return null;
    const r = await run('xprop', ['-id', xid, '_NET_WM_PID']);
    const pid = Number((/= (\d+)/.exec(r.stdout) || [])[1]);
    if (pid) { const a = apps.find((x) => x.pid === pid); if (a) return a; }
    const title = norm(this.windowTitles?.get(sourceId) || '');
    return apps.find((a) => title && title.includes(norm(a.name))) || null;
  }

  async start(spec) {
    const t = await this.tools();
    this.stopped = false;
    if (!t.pipewire) {
      if (spec.mode !== 'devices') throw new Error('Per-app sound on Linux needs PipeWire. You can still share an output device.');
      if (!t.parec) throw new Error('parec (PulseAudio tools) is needed to share sound.');
      this.procs = (spec.devices || []).map((id, idx) => this._parec(`${id}.monitor`, idx));
      return { ok: true };
    }

    await this._createMixSink(t);
    const capture = t.parec
      ? this._parec(`${MIX_SINK}.monitor`, 0)
      : this._pipe(spawn('pw-record', ['-P', '{ stream.capture.sink=true }', '--target', MIX_SINK, '--format', 's16', '--rate', '48000', '--channels', '2', '-']), 0);
    this.procs = [capture];

    const appSet = new Set((spec.apps || []).map(norm));
    const exceptSet = new Set((spec.except || []).map(norm));
    const devSet = new Set(spec.devices || []);
    let windowApp = null;
    if (spec.mode === 'window') windowApp = (await this.list(spec.windowSourceId)).window;

    const relink = async () => {
      if (this.stopped) return;
      try {
        const g = await this.graph();
        const mix = g.nodes.find((n) => n.props['node.name'] === MIX_SINK);
        if (!mix) return;
        const inputs = g.ports.filter((p) => p.node === mix.id && p.dir === 'input');
        const inFor = (ch) => inputs.find((p) => p.channel === ch);
        const sources = [];
        if (spec.mode === 'devices') {
          for (const n of g.nodes) if (n.props['media.class'] === 'Audio/Sink' && devSet.has(n.props['node.name'])) sources.push({ node: n.id, monitor: true });
        } else {
          for (const s of this.appStreams(g)) {
            const n = norm(s.name), b = norm(s.binary);
            const take = spec.mode === 'apps' ? appSet.has(n) || appSet.has(b)
              : spec.mode === 'window' ? !!windowApp && (s.pid === windowApp.pid || n === norm(windowApp.name))
                : !(exceptSet.has(n) || exceptSet.has(b)); // 'system' / 'except'
            if (take) sources.push({ node: s.node, monitor: false });
          }
        }
        const map = { FL: ['FL'], FR: ['FR'], MONO: ['FL', 'FR'], FC: ['FL', 'FR'], RL: ['FL'], RR: ['FR'], SL: ['FL'], SR: ['FR'] };
        for (const src of sources) {
          for (const p of g.ports.filter((x) => x.node === src.node && x.dir === 'output' && (src.monitor ? x.monitor : !x.monitor))) {
            for (const ch of map[p.channel] || []) {
              const target = inFor(ch);
              if (target && !g.links.has(`${p.id}>${target.id}`)) await run('pw-link', [String(p.id), String(target.id)]);
            }
          }
        }
      } catch (err) { this.log(`audio relink: ${err.message}`); }
    };
    await relink();
    this.timer = setInterval(relink, 1500); // apps open new streams when they start playing
    return { ok: true };
  }

  async _createMixSink(t) {
    if (t.pactl) {
      const r = await run('pactl', ['load-module', 'module-null-sink', `sink_name=${MIX_SINK}`, 'sink_properties=device.description=ScreenDraw-capture']);
      if (!r.err) { this.moduleId = r.stdout.trim(); await new Promise((res) => setTimeout(res, 300)); return; }
    }
    // No pactl: a null sink that lives as long as this pw-cli process.
    this.pwCli = spawn('pw-cli', [], { stdio: ['pipe', 'ignore', 'ignore'] });
    this.pwCli.stdin.write(`create-node adapter { factory.name=support.null-audio-sink node.name=${MIX_SINK} node.description=ScreenDraw-capture media.class=Audio/Sink audio.position=[ FL FR ] object.linger=false }\n`);
    await new Promise((res) => setTimeout(res, 500));
  }

  _parec(device, idx) {
    return this._pipe(spawn('parec', ['--raw', '--format=s16le', '--rate=48000', '--channels=2', '--latency-msec=20', `--device=${device}`, '--client-name=ScreenDraw']), idx);
  }

  _pipe(proc, idx) {
    proc.stdout.on('data', (d) => this.send(idx, 48000, d));
    proc.stderr.on('data', (d) => this.log(`audio capture: ${String(d).trim()}`));
    proc.on('error', (err) => this.status(`couldn't capture sound: ${err.message}`));
    return proc;
  }

  stop() {
    this.stopped = true;
    clearInterval(this.timer); this.timer = null;
    for (const p of this.procs || []) { try { p.kill(); } catch { /* ignore */ } }
    this.procs = [];
    if (this.moduleId) { run('pactl', ['unload-module', this.moduleId]); this.moduleId = null; }
    try { this.pwCli?.stdin.end(); this.pwCli?.kill(); } catch { /* ignore */ }
    this.pwCli = null;
  }
}

/* ================================================== generated tones (tests) */
class FakeAudio {
  constructor(opts) { Object.assign(this, opts); }
  async info() { return { available: true, backend: 'fake', system: false }; }
  async list() {
    return {
      devices: [{ id: 'dev-game', name: 'Game (test)', default: true }, { id: 'dev-chat', name: 'Chat (test)', default: false }],
      apps: [{ pid: 101, name: 'Spotify', playing: true }, { pid: 102, name: 'Discord', playing: true }, { pid: 103, name: 'Game', playing: false }],
      window: { pid: 103, name: 'Game' }, perApp: true, backend: 'fake',
    };
  }
  async start(spec) {
    const all = await this.list();
    let picks;
    if (spec.mode === 'devices') picks = spec.devices || [];
    else if (spec.mode === 'apps') picks = spec.apps || [];
    else if (spec.mode === 'window') picks = ['Game'];
    else picks = all.apps.map((a) => a.name).filter((n) => !(spec.except || []).map(norm).includes(norm(n)));
    this.picked = picks;
    let t = 0;
    this.timer = setInterval(() => {
      picks.forEach((_, idx) => {
        const n = 480, buf = Buffer.alloc(n * 4), f = 330 * (idx + 1);
        for (let i = 0; i < n; i++) { const v = Math.round(Math.sin((2 * Math.PI * f * (t + i)) / 48000) * 8000); buf.writeInt16LE(v, i * 4); buf.writeInt16LE(v, i * 4 + 2); }
        this.send(idx, 48000, buf);
      });
      t += 480;
    }, 10);
    this.log(`fake audio: ${picks.join(', ') || '(nothing)'}`);
    return { ok: true };
  }
  stop() { clearInterval(this.timer); }
}

function createAudioSources(opts) {
  if (process.env.SCREENDRAW_FAKE_AUDIO === '1') return new FakeAudio(opts);
  if (process.platform === 'win32') return new WindowsAudio(opts);
  if (process.platform === 'linux') return new LinuxAudio(opts);
  return { info: async () => ({ available: false, reason: 'Sound sharing from the app isn\'t supported on this system.' }), list: async () => ({ devices: [], apps: [], perApp: false }), start: async () => { throw new Error('unsupported'); }, stop() {} };
}

module.exports = { createAudioSources, frameParser };
