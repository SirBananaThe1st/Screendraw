// Screen/app capture plus the sharer's quality settings.
(() => {
  SD.RESOLUTIONS = {
    source: { label: 'Source (full)', w: 0, h: 0 },
    '1440': { label: '1440p', w: 2560, h: 1440 },
    '1080': { label: '1080p', w: 1920, h: 1080 },
    '720': { label: '720p', w: 1280, h: 720 },
    '480': { label: '480p', w: 854, h: 480 },
  };
  SD.FRAME_RATES = [15, 30, 60];

  SD.shareSettings = (serverDefaultMode) => ({
    mode: serverDefaultMode || 'p2p',
    res: '1080',
    fps: 30,
    optimize: 'detail', // 'detail' (text, UI) | 'motion' (video, games)
    audio: true, // browsers: share sound (the browser's picker decides what)
    // desktop app: which sound to share
    sound: { mode: 'system', apps: [], except: [], devices: [] },
    ...SD.store.get('share', {}),
  });

  /* --------------------------------------------------- chosen sound (app) */
  // The desktop app captures exactly the chosen apps / devices natively and
  // hands us PCM; we turn it into an audio track (mixing several sources).
  SD.startNativeAudio = async (spec) => {
    const res = await window.desktop.audioStart(spec);
    if (res?.useSystemLoopback) return null;
    const ctx = new AudioContext({ sampleRate: 48000, latencyHint: 'interactive' });
    await ctx.audioWorklet.addModule('js/pcm-worklet.js');
    const dest = ctx.createMediaStreamDestination();
    const nodes = new Map();
    let stopped = false;
    window.desktop.onAudioData((idx, rate, buf) => {
      if (stopped) return;
      let node = nodes.get(idx);
      if (!node) {
        node = new AudioWorkletNode(ctx, 'pcm-player', { numberOfInputs: 0, outputChannelCount: [2] });
        node.connect(dest);
        nodes.set(idx, node);
      }
      let bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
      if (bytes.byteOffset & 1) bytes = bytes.slice();
      const pcm = new Int16Array(bytes.buffer, bytes.byteOffset, bytes.byteLength >> 1);
      const n = pcm.length >> 1;
      let l = new Float32Array(n), r = new Float32Array(n);
      for (let i = 0; i < n; i++) { l[i] = pcm[2 * i] / 32768; r[i] = pcm[2 * i + 1] / 32768; }
      if (rate && rate !== ctx.sampleRate) { // simple linear resample
        const m = Math.round((n * ctx.sampleRate) / rate), l2 = new Float32Array(m), r2 = new Float32Array(m);
        for (let i = 0; i < m; i++) {
          const x = (i * rate) / ctx.sampleRate, i0 = Math.floor(x), i1 = Math.min(n - 1, i0 + 1), f = x - i0;
          l2[i] = l[i0] * (1 - f) + l[i1] * f; r2[i] = r[i0] * (1 - f) + r[i1] * f;
        }
        l = l2; r = r2;
      }
      node.port.postMessage({ l, r }, [l.buffer, r.buffer]);
    });
    window.desktop.onAudioStatus((msg) => SD.toast(`Sound: ${msg}`, 'bad'));
    return {
      track: dest.stream.getAudioTracks()[0],
      stop() { stopped = true; window.desktop.audioStop(); ctx.close().catch(() => {}); },
    };
  };

  // Target size for a frame of w×h under a resolution cap (keeps aspect, even numbers).
  SD.capSize = (w, h, resKey) => {
    const cap = SD.RESOLUTIONS[resKey] || SD.RESOLUTIONS.source;
    let s = 1;
    if (cap.w && cap.h) {
      const portrait = h > w;
      const [cw, ch] = portrait ? [cap.h, cap.w] : [cap.w, cap.h];
      s = Math.min(1, cw / w, ch / h);
    }
    const even = (v) => Math.max(2, Math.round((v * s) / 2) * 2);
    return { w: even(w), h: even(h) };
  };

  // Video bitrate (bits/s) that looks good for this size, frame rate and content.
  SD.targetBitrate = (w, h, fps, optimize) => {
    const base = optimize === 'motion' ? 6_000_000 : 4_000_000; // 1080p30
    const v = base * ((w * h) / (1920 * 1080)) * Math.pow(fps / 30, 0.75);
    return Math.round(SD.clamp(v, 400_000, 25_000_000));
  };

  // Desktop app: system audio capture is available on Windows.
  SD.canSystemAudio = () => (SD.isDesktop ? !!window.desktop.info?.systemAudio : true);

  /**
   * Starts capturing. In the desktop app `sourceId` comes from our own picker;
   * in a browser the browser shows its own picker.
   */
  SD.startCapture = async (settings, sourceId) => {
    const fps = Number(settings.fps) || 30;
    const cap = SD.RESOLUTIONS[settings.res] || SD.RESOLUTIONS.source;
    const video = { frameRate: { ideal: fps, max: fps } };
    if (cap.w) { video.width = { max: cap.w }; video.height = { max: cap.h }; }
    const wantAudio = !!settings.audio && SD.canSystemAudio();

    let stream;
    if (SD.isDesktop) {
      const sound = settings.sound || { mode: 'off' };
      // Windows "everything you hear" uses Chromium's own system-audio capture;
      // every other choice is captured natively and added as a separate track.
      const loopback = sound.mode === 'system' && !!window.desktop.info?.systemAudio;
      await window.desktop.selectSource(sourceId, loopback);
      stream = await navigator.mediaDevices.getDisplayMedia({ video, audio: loopback });
      if (sound.mode !== 'off' && !loopback) {
        try {
          const native = await SD.startNativeAudio({ ...sound, windowSourceId: sourceId });
          if (native) { stream.addTrack(native.track); stream.nativeAudio = native; }
        } catch (err) { SD.toast(`Couldn't share sound: ${err.message}`, 'bad'); }
      }
    } else {
      stream = await navigator.mediaDevices.getDisplayMedia({
        video: { ...video, cursor: 'always' },
        audio: wantAudio ? { suppressLocalAudioPlayback: false } : false,
        selfBrowserSurface: 'exclude',
        systemAudio: 'include',
        surfaceSwitching: 'include',
      });
    }
    const track = stream.getVideoTracks()[0];
    try { track.contentHint = settings.optimize === 'motion' ? 'motion' : 'detail'; } catch { /* unsupported */ }
    try { await track.applyConstraints(video); } catch { /* keep what we got */ }
    return stream;
  };

  SD.describeTrack = (stream) => {
    const t = stream.getVideoTracks()[0];
    const s = t?.getSettings?.() || {};
    let label = t?.label || 'Screen';
    if (/^(screen|window|web-contents-media-stream):/.test(label) || !label) label = 'Screen';
    return { width: s.width || 0, height: s.height || 0, label, surface: s.displaySurface || '' };
  };
})();
