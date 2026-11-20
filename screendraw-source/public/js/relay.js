// "Through the server" sharing: the sharer encodes video/audio once with
// WebCodecs and uploads it over the WebSocket; the server passes the packets
// to every viewer, who decode them. Two video layers: 0 = full quality,
// 1 = low quality (only encoded while someone is watching it).
//
// Packet: 16-byte header + encoded data.
// [0] kind (1 video, 2 audio) [1] layer [2] flags (1 = keyframe) [3] 0
// [4..11] float64 timestamp (µs) [12..15] uint32 duration (µs)
(() => {
  const KEYFRAME_INTERVAL_US = 10_000_000;
  const UPLOAD_HIGH_WATER = 4 * 1024 * 1024;

  SD.relaySupported = {
    send: () => 'VideoEncoder' in window && 'VideoFrame' in window,
    receive: () => 'VideoDecoder' in window,
    sendAudio: () => 'AudioEncoder' in window && 'MediaStreamTrackProcessor' in window,
    receiveAudio: () => 'AudioDecoder' in window,
  };

  const VIDEO_CODECS = ['avc1.640034', 'avc1.4d0034', 'avc1.42e034', 'vp8', 'vp09.00.40.08'];

  async function pickEncoder(width, height, fps, bitrate, optimize) {
    for (const codec of VIDEO_CODECS) {
      for (const hardwareAcceleration of ['prefer-hardware', 'no-preference']) {
        const config = {
          codec, width, height, bitrate, framerate: fps, hardwareAcceleration,
          latencyMode: 'realtime', bitrateMode: 'variable',
          ...(codec.startsWith('avc1') ? { avc: { format: 'annexb' } } : {}),
        };
        try {
          const r = await VideoEncoder.isConfigSupported(config);
          if (r.supported) {
            try { if (optimize) { const withHint = { ...config, contentHint: optimize === 'motion' ? 'motion' : 'detail' }; if ((await VideoEncoder.isConfigSupported(withHint)).supported) return withHint; } } catch { /* no hint support */ }
            return config;
          }
        } catch { /* try next */ }
      }
    }
    throw new Error('This browser can\'t encode video for the server relay. Use direct (P2P) mode.');
  }

  function packet(kind, layer, key, timestamp, duration, byteLength, copy) {
    const buf = new ArrayBuffer(16 + byteLength);
    const dv = new DataView(buf);
    dv.setUint8(0, kind); dv.setUint8(1, layer); dv.setUint8(2, key ? 1 : 0);
    dv.setFloat64(4, timestamp); dv.setUint32(12, Math.max(0, Math.min(0xffffffff, Math.round(duration || 0))));
    copy(new Uint8Array(buf, 16));
    return buf;
  }

  /* ================================================================ sharer */

  class RelayPresenter {
    constructor({ conn, stream, settings, log }) {
      Object.assign(this, { conn, stream, settings, log });
      this.layers = [0, 1].map((idx) => ({ idx, active: false, encoder: null, config: null, size: null, lastTs: -1e12, lastKeyTs: -1e12, forceKey: true, canvas: null, sentConfig: '', frames: 0, bytes: 0 }));
      this.stopped = false;
    }

    start() {
      const vt = this.stream.getVideoTracks()[0];
      if (vt) this._pumpVideo(vt);
      const at = this.stream.getAudioTracks()[0];
      if (at) {
        if (SD.relaySupported.sendAudio()) this._pumpAudio(at);
        else this.log?.('audio can\'t be sent through the server from this browser');
      }
    }

    setLayers(list) {
      for (const L of this.layers) {
        const want = list.includes(L.idx);
        if (want && !L.active) { L.active = true; L.forceKey = true; }
        if (!want && L.active) { L.active = false; this._closeEncoder(L); }
      }
    }

    requestKey(layer) { const L = this.layers[layer]; if (L) L.forceKey = true; }

    _target(L, fw, fh) {
      if (L.idx === 0) return { ...SD.capSize(fw, fh, this.settings.res), fps: Number(this.settings.fps) || 30, optimize: this.settings.optimize };
      const s = Math.min(1, 540 / Math.min(fw, fh));
      const even = (v) => Math.max(2, Math.round((v * s) / 2) * 2);
      return { w: even(fw), h: even(fh), fps: Math.min(24, Number(this.settings.fps) || 30), optimize: this.settings.optimize, low: true };
    }

    async _ensureEncoder(L, fw, fh) {
      const t = this._target(L, fw, fh);
      const key = `${t.w}x${t.h}@${t.fps}`;
      if (L.encoder && L.size === key) return L.encoder.state === 'configured';
      if (L.configuring) return false;
      L.configuring = true;
      try {
        this._closeEncoder(L);
        const bitrate = t.low ? 900_000 : SD.targetBitrate(t.w, t.h, t.fps, t.optimize);
        const config = await pickEncoder(t.w, t.h, t.fps, bitrate, t.optimize);
        L.encoder = new VideoEncoder({
          output: (chunk, meta) => this._onChunk(L, chunk, meta),
          error: (err) => { this.log?.(`video encoder error: ${err.message}`); this._closeEncoder(L); },
        });
        L.encoder.configure(config);
        L.config = config; L.size = key; L.t = t; L.forceKey = true;
        if (t.w !== fw || t.h !== fh) {
          L.canvas = new OffscreenCanvas(t.w, t.h);
          L.ctx = L.canvas.getContext('2d', { alpha: false });
        } else { L.canvas = null; L.ctx = null; }
        if (L.idx === 0) this.log?.(`server relay encoding ${t.w}x${t.h} @ ${t.fps} fps, ${(bitrate / 1e6).toFixed(1)} Mbps, ${config.codec} (${config.hardwareAcceleration})`);
        return true;
      } catch (err) {
        this.log?.(err.message);
        this.error = err;
        return false;
      } finally { L.configuring = false; }
    }

    _closeEncoder(L) {
      try { if (L.encoder && L.encoder.state !== 'closed') L.encoder.close(); } catch { /* ignore */ }
      L.encoder = null; L.size = null; L.sentConfig = '';
    }

    _onChunk(L, chunk, meta) {
      if (meta?.decoderConfig) {
        const dc = meta.decoderConfig;
        let description;
        if (dc.description) {
          const bytes = dc.description instanceof ArrayBuffer ? new Uint8Array(dc.description) : new Uint8Array(dc.description.buffer, dc.description.byteOffset, dc.description.byteLength);
          description = btoa(String.fromCharCode(...bytes));
        }
        const cfg = { type: 'relay-config', kind: 'video', layer: L.idx, codec: dc.codec || L.config.codec, width: dc.codedWidth || L.t.w, height: dc.codedHeight || L.t.h, description };
        const sig = JSON.stringify(cfg);
        if (sig !== L.sentConfig) { L.sentConfig = sig; this.conn.send(cfg); }
      }
      const buf = packet(1, L.idx, chunk.type === 'key', chunk.timestamp, chunk.duration, chunk.byteLength, (dst) => chunk.copyTo(dst));
      this.conn.sendBinary(buf);
      L.frames++; L.bytes += chunk.byteLength;
    }

    async _encodeFrame(frame) {
      const ts = frame.timestamp;
      const fw = frame.displayWidth, fh = frame.displayHeight;
      for (const L of this.layers) {
        if (!L.active) continue;
        if (!(await this._ensureEncoder(L, fw, fh))) continue;
        const minGap = 1e6 / L.t.fps - 4000;
        if (ts - L.lastTs < minGap) continue;
        if (this.conn.bufferedAmount > UPLOAD_HIGH_WATER) { L.forceKey = true; continue; } // upload is backed up: drop
        if (L.encoder.encodeQueueSize > 2) continue; // encoder is behind: drop
        let input = frame;
        if (L.ctx) {
          L.ctx.drawImage(frame, 0, 0, L.canvas.width, L.canvas.height);
          input = new VideoFrame(L.canvas, { timestamp: ts });
        }
        const key = L.forceKey || ts - L.lastKeyTs > KEYFRAME_INTERVAL_US;
        try {
          L.encoder.encode(input, { keyFrame: key });
          if (key) { L.forceKey = false; L.lastKeyTs = ts; }
          L.lastTs = ts;
        } catch (err) { this.log?.(`encode failed: ${err.message}`); }
        if (input !== frame) input.close();
      }
      frame.close();
    }

    async _pumpVideo(track) {
      if ('MediaStreamTrackProcessor' in window) {
        const reader = new MediaStreamTrackProcessor({ track }).readable.getReader();
        this.videoReader = reader;
        while (!this.stopped) {
          const { value, done } = await reader.read().catch(() => ({ done: true }));
          if (done) break;
          if (this.layers.some((L) => L.active)) await this._encodeFrame(value);
          else value.close();
        }
        return;
      }
      // Fallback (e.g. Firefox): pull frames from a hidden <video>.
      const video = document.createElement('video');
      video.muted = true; video.playsInline = true; video.srcObject = new MediaStream([track]);
      await video.play().catch(() => {});
      this.fallbackVideo = video;
      const tick = async () => {
        if (this.stopped) return;
        if (video.videoWidth && this.layers.some((L) => L.active)) {
          try { await this._encodeFrame(new VideoFrame(video, { timestamp: Math.round(performance.now() * 1000) })); } catch { /* not ready */ }
        }
        if (video.requestVideoFrameCallback) video.requestVideoFrameCallback(tick);
        else setTimeout(tick, 1000 / (Number(this.settings.fps) || 30));
      };
      tick();
    }

    async _pumpAudio(track) {
      const reader = new MediaStreamTrackProcessor({ track }).readable.getReader();
      this.audioReader = reader;
      let encoder = null;
      while (!this.stopped) {
        const { value, done } = await reader.read().catch(() => ({ done: true }));
        if (done) break;
        if (!this.layers.some((L) => L.active)) { value.close(); continue; }
        if (!encoder) {
          encoder = new AudioEncoder({
            output: (chunk) => this.conn.sendBinary(packet(2, 0, true, chunk.timestamp, chunk.duration, chunk.byteLength, (dst) => chunk.copyTo(dst))),
            error: (err) => this.log?.(`audio encoder error: ${err.message}`),
          });
          const cfg = { codec: 'opus', sampleRate: value.sampleRate, numberOfChannels: Math.min(2, value.numberOfChannels), bitrate: 128_000 };
          try {
            encoder.configure(cfg);
            this.conn.send({ type: 'relay-config', kind: 'audio', layer: 0, codec: 'opus', sampleRate: cfg.sampleRate, channels: cfg.numberOfChannels });
            this.audioEncoder = encoder;
          } catch (err) { this.log?.(`audio can't be encoded: ${err.message}`); value.close(); break; }
        }
        if (encoder.encodeQueueSize < 20) encoder.encode(value);
        value.close();
      }
    }

    stats() {
      const L = this.layers[0];
      const out = { frames: L.frames, bytes: L.bytes, size: L.t ? `${L.t.w}x${L.t.h}` : '', codec: L.config?.codec, lowActive: this.layers[1].active };
      return out;
    }

    stop() {
      this.stopped = true;
      this.videoReader?.cancel().catch(() => {});
      this.audioReader?.cancel().catch(() => {});
      for (const L of this.layers) this._closeEncoder(L);
      try { this.audioEncoder?.close(); } catch { /* ignore */ }
      if (this.fallbackVideo) this.fallbackVideo.srcObject = null;
    }
  }

  /* ================================================================ viewer */

  class RelayViewer {
    constructor({ conn, canvas, onSize, onFirstFrame, log }) {
      Object.assign(this, { conn, canvas, onSize, onFirstFrame, log });
      this.ctx = canvas.getContext('2d', { alpha: false });
      this.decoder = null; this.videoConfig = null; this.waitingKey = true;
      this.pending = null; this.drawScheduled = false;
      this.frameW = 0; this.frameH = 0;
      this.audioCtx = null; this.audioDecoder = null; this.audioConfig = null; this.nextTime = 0; this.volume = 1; this.soundOn = false;
      this.frames = 0; this.bytes = 0; this.closed = false; this.gotFrame = false;
    }

    async onConfig(cfg) {
      if (cfg.kind === 'audio') { this.audioConfig = cfg; this._setupAudioDecoder(); return; }
      this.videoConfig = cfg;
      const config = { codec: cfg.codec, optimizeForLatency: true, hardwareAcceleration: 'no-preference' };
      if (cfg.description) config.description = Uint8Array.from(atob(cfg.description), (c) => c.charCodeAt(0));
      if (cfg.width) { config.codedWidth = cfg.width; config.codedHeight = cfg.height; }
      try {
        const r = await VideoDecoder.isConfigSupported(config);
        if (!r.supported) throw new Error(`this browser can't play ${cfg.codec} video`);
      } catch (err) {
        this.log?.(err.message);
        this.error = `This browser can't play the shared video (${cfg.codec}). Try Chrome, Edge or the ScreenDraw app.`;
        return;
      }
      this._newDecoder(config);
    }

    _newDecoder(config) {
      try { if (this.decoder && this.decoder.state !== 'closed') this.decoder.close(); } catch { /* ignore */ }
      this.decoderConfig = config;
      this.decoder = new VideoDecoder({
        output: (frame) => this._onFrame(frame),
        error: (err) => {
          this.log?.(`video decode error: ${err.message}`);
          if (!this.closed) { this._newDecoder(this.decoderConfig); this.conn.send({ type: 'keyframe-request' }); }
        },
      });
      this.decoder.configure(config);
      this.waitingKey = true;
    }

    onBinary(buf) {
      if (this.closed || buf.byteLength < 16) return;
      const dv = new DataView(buf);
      const kind = dv.getUint8(0), key = (dv.getUint8(2) & 1) === 1;
      const timestamp = dv.getFloat64(4), duration = dv.getUint32(12);
      const data = new Uint8Array(buf, 16);
      this.bytes += buf.byteLength;
      if (kind === 2) return this._onAudio(timestamp, duration, data);
      const d = this.decoder;
      if (!d || d.state !== 'configured') return;
      if (this.waitingKey && !key) return;
      if (d.decodeQueueSize > 8) { // falling behind: skip to the next keyframe
        this.waitingKey = true;
        this.conn.send({ type: 'keyframe-request' });
        return;
      }
      this.waitingKey = false;
      try { d.decode(new EncodedVideoChunk({ type: key ? 'key' : 'delta', timestamp, duration: duration || undefined, data })); }
      catch (err) { this.waitingKey = true; this.conn.send({ type: 'keyframe-request' }); }
    }

    _onFrame(frame) {
      this.frames++;
      if (this.pending) this.pending.close();
      this.pending = frame;
      if (frame.displayWidth !== this.frameW || frame.displayHeight !== this.frameH) {
        this.frameW = frame.displayWidth; this.frameH = frame.displayHeight;
        this.onSize?.(this.frameW, this.frameH);
      }
      if (!this.gotFrame) { this.gotFrame = true; this.onFirstFrame?.(); }
      if (!this.drawScheduled) { this.drawScheduled = true; requestAnimationFrame(() => this._draw()); }
    }

    _draw() {
      this.drawScheduled = false;
      const f = this.pending;
      if (!f) return;
      this.pending = null;
      // Keep the newest frame: resizing a canvas wipes it, and a still screen
      // may not send another frame for a long time.
      if (this.last) this.last.close();
      this.last = f;
      this.redraw();
    }

    // Draw the latest frame again (called after the canvas is resized).
    redraw() {
      const c = this.canvas;
      if (this.last && c._css) this.ctx.drawImage(this.last, 0, 0, c.width, c.height);
    }

    /* ---------------------------------------------------------- audio */
    _setupAudioDecoder() {
      if (!SD.relaySupported.receiveAudio() || !this.audioConfig) return;
      try { if (this.audioDecoder && this.audioDecoder.state !== 'closed') this.audioDecoder.close(); } catch { /* ignore */ }
      const cfg = this.audioConfig;
      const decoder = new AudioDecoder({ output: (d) => this._play(d), error: (err) => this.log?.(`audio decode error: ${err.message}`) });
      this.audioDecoder = decoder;
      // Opus always runs at 48 kHz internally; some browsers only accept that.
      const candidates = [48000, cfg.sampleRate].filter((v, i, a) => v && a.indexOf(v) === i)
        .map((sampleRate) => ({ codec: cfg.codec, sampleRate, numberOfChannels: cfg.channels || 2 }));
      (async () => {
        for (const c of candidates) {
          try { if ((await AudioDecoder.isConfigSupported(c)).supported) { if (this.audioDecoder === decoder) decoder.configure(c); return; } } catch { /* next */ }
        }
        this.log?.('this browser can\'t play the shared sound');
        this.audioDecoder = null;
      })();
    }

    _onAudio(timestamp, duration, data) {
      if (!this.soundOn || !this.audioDecoder || this.audioDecoder.state !== 'configured') return;
      if (this.audioDecoder.decodeQueueSize > 50) return;
      try { this.audioDecoder.decode(new EncodedAudioChunk({ type: 'key', timestamp, duration: duration || undefined, data })); } catch { /* skip */ }
    }

    _play(data) {
      const ctx = this.audioCtx;
      if (!ctx || !this.soundOn) { data.close(); return; }
      const n = data.numberOfFrames, ch = data.numberOfChannels;
      const buffer = ctx.createBuffer(ch, n, data.sampleRate);
      for (let c = 0; c < ch; c++) {
        const arr = new Float32Array(n);
        data.copyTo(arr, { planeIndex: c, format: 'f32-planar' });
        buffer.copyToChannel(arr, c);
      }
      data.close();
      const now = ctx.currentTime;
      if (this.nextTime < now + 0.02 || this.nextTime > now + 0.6) this.nextTime = now + 0.08; // (re)start jitter buffer
      const src = ctx.createBufferSource();
      src.buffer = buffer;
      src.connect(this.gain);
      src.start(this.nextTime);
      this.nextTime += buffer.duration;
    }

    // Must be called from a click (browsers only allow sound after user action).
    setSound(on, volume = this.volume) {
      this.volume = volume;
      this.soundOn = on;
      if (on && !this.audioCtx) {
        this.audioCtx = new AudioContext({ latencyHint: 'interactive' });
        this.gain = this.audioCtx.createGain();
        this.gain.connect(this.audioCtx.destination);
      }
      if (this.audioCtx) { this.gain.gain.value = volume; if (on) this.audioCtx.resume(); }
      if (on && !this.audioDecoder) this._setupAudioDecoder();
    }

    stats() { return { frames: this.frames, bytes: this.bytes, size: this.frameW ? `${this.frameW}x${this.frameH}` : '', codec: this.videoConfig?.codec }; }

    close() {
      this.closed = true;
      for (const d of [this.decoder, this.audioDecoder]) { try { if (d && d.state !== 'closed') d.close(); } catch { /* ignore */ } }
      this.pending?.close(); this.pending = null;
      this.last?.close(); this.last = null;
      this.audioCtx?.close().catch(() => {});
    }
  }

  SD.RelayPresenter = RelayPresenter;
  SD.RelayViewer = RelayViewer;
})();
