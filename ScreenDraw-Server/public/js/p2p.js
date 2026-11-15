// Direct (peer-to-peer) sharing with WebRTC: the sharer sends a stream to each
// viewer. Signalling goes through the server connection.
(() => {
  // Prefer H.264 (usually hardware-encoded = higher FPS at high resolutions),
  // then VP8, VP9, AV1. Retransmission/FEC entries keep their place.
  function preferCodecs(transceiver) {
    if (!transceiver?.setCodecPreferences || !window.RTCRtpSender?.getCapabilities) return;
    const caps = RTCRtpSender.getCapabilities('video')?.codecs || [];
    const rank = (c) => {
      const t = c.mimeType.toLowerCase();
      if (t === 'video/h264') return /profile-level-id=42e0/.test(c.sdpFmtpLine || '') ? 0 : 1;
      if (t === 'video/vp8') return 2;
      if (t === 'video/vp9') return 3;
      if (t === 'video/av1') return 4;
      return 5;
    };
    try { transceiver.setCodecPreferences([...caps].sort((a, b) => rank(a) - rank(b))); } catch (err) { console.warn('codec preference', err); }
  }

  function encodingFor(settings, size, quality) {
    const fps = Number(settings.fps) || 30;
    const full = SD.targetBitrate(size.w || 1920, size.h || 1080, fps, settings.optimize);
    if (quality === 'low') {
      return { maxBitrate: Math.min(full, 900_000), maxFramerate: Math.min(fps, 24), scaleResolutionDownBy: Math.max(1, (size.h || 1080) / 480) };
    }
    return { maxBitrate: full, maxFramerate: fps, scaleResolutionDownBy: 1 };
  }

  async function applySender(pc, settings, size, quality) {
    for (const sender of pc.getSenders()) {
      if (sender.track?.kind !== 'video') continue;
      try {
        const p = sender.getParameters();
        if (!p.encodings || !p.encodings.length) p.encodings = [{}];
        Object.assign(p.encodings[0], encodingFor(settings, size, quality));
        p.degradationPreference = settings.optimize === 'motion' ? 'maintain-framerate' : 'balanced';
        await sender.setParameters(p);
      } catch (err) { console.warn('setParameters', err); }
    }
  }

  class P2PPresenter {
    constructor({ conn, stream, settings, iceServers, log }) {
      Object.assign(this, { conn, stream, settings, iceServers, log });
      this.viewers = new Map(); // id -> { pc, ice, quality }
      this.qualities = new Map(); // id -> 'auto' | 'high' | 'low' (may arrive before the connection)
      this.size = SD.describeTrack(stream);
      this.size = { w: this.size.width, h: this.size.height };
    }

    async addViewer(id, quality = this.qualities.get(id) || 'auto') {
      this.removeViewer(id);
      const pc = new SD.PeerConnection({ iceServers: this.iceServers });
      const v = { pc, ice: [], quality, restarted: false };
      this.viewers.set(id, v);
      for (const track of this.stream.getTracks()) pc.addTrack(track, this.stream);
      preferCodecs(pc.getTransceivers().find((t) => t.sender.track?.kind === 'video'));

      pc.onicecandidate = (e) => e.candidate && this.conn.send({ type: 'signal', to: id, kind: 'ice', payload: e.candidate });
      pc.onconnectionstatechange = async () => {
        if (pc.connectionState === 'failed' && !v.restarted) {
          v.restarted = true;
          this.log?.(`connection to a viewer failed; retrying`);
          try { await pc.setLocalDescription(await pc.createOffer({ iceRestart: true })); this.conn.send({ type: 'signal', to: id, kind: 'offer', payload: pc.localDescription, share: 'restart' }); } catch { /* give up */ }
        }
      };
      try {
        await pc.setLocalDescription(await pc.createOffer());
        await applySender(pc, this.settings, this.size, quality);
        this.conn.send({ type: 'signal', to: id, kind: 'offer', payload: pc.localDescription });
      } catch (err) {
        this.log?.(`could not start a connection: ${err.message}`);
      }
    }

    removeViewer(id) {
      const v = this.viewers.get(id);
      if (!v) return;
      v.pc.close();
      this.viewers.delete(id);
    }

    async onSignal(msg) {
      if (msg.kind === 'renegotiate') { this.addViewer(msg.from); return; } // viewer pressed Reload
      const v = this.viewers.get(msg.from);
      if (!v) return;
      try {
        if (msg.kind === 'answer') {
          await v.pc.setRemoteDescription(msg.payload);
          for (const c of v.ice.splice(0)) v.pc.addIceCandidate(c).catch(() => {});
        } else if (msg.kind === 'ice') {
          if (v.pc.remoteDescription) v.pc.addIceCandidate(msg.payload).catch(() => {});
          else v.ice.push(msg.payload);
        } else if (msg.kind === 'renegotiate') {
          this.addViewer(msg.from, v.quality);
        }
      } catch (err) { this.log?.(`signalling error: ${err.message}`); }
    }

    setViewerQuality(id, quality) {
      this.qualities.set(id, quality);
      const v = this.viewers.get(id);
      if (!v) return;
      v.quality = quality;
      applySender(v.pc, this.settings, this.size, quality);
    }

    updateSize(w, h) {
      this.size = { w, h };
      for (const v of this.viewers.values()) applySender(v.pc, this.settings, this.size, v.quality);
    }

    get viewerCount() { return [...this.viewers.values()].filter((v) => v.pc.connectionState === 'connected').length; }

    stop() { for (const id of [...this.viewers.keys()]) this.removeViewer(id); }
  }

  class P2PViewer {
    constructor({ conn, presenterId, iceServers, onStream, onState, log }) {
      Object.assign(this, { conn, presenterId, iceServers, onStream, onState, log });
      this.pc = null;
      this.ice = [];
    }

    async onSignal(msg) {
      if (msg.from !== this.presenterId) return;
      try {
        if (msg.kind === 'offer') await this._offer(msg);
        else if (msg.kind === 'ice') {
          if (this.pc?.remoteDescription) this.pc.addIceCandidate(msg.payload).catch(() => {});
          else this.ice.push(msg.payload);
        }
      } catch (err) {
        this.log?.(`could not accept the video: ${err.message}`);
        this.onState?.('failed', err.message);
      }
    }

    async _offer(msg) {
      const iceRestart = msg.share === 'restart' && this.pc && this.pc.signalingState !== 'closed';
      if (!iceRestart) {
        this.pc?.close();
        const pc = new SD.PeerConnection({ iceServers: this.iceServers });
        this.pc = pc;
        this.ice = [];
        let shown = null;
        pc.ontrack = (e) => {
          const stream = e.streams[0] || new MediaStream([e.track]);
          if (stream !== shown) { shown = stream; this.onStream(stream); }
        };
        pc.onicecandidate = (e) => e.candidate && this.conn.send({ type: 'signal', to: this.presenterId, kind: 'ice', payload: e.candidate });
        pc.onconnectionstatechange = () => {
          if (pc !== this.pc) return;
          if (pc.connectionState === 'connected') this.onState?.('connected');
          if (pc.connectionState === 'failed') this.onState?.('failed');
        };
      }
      await this.pc.setRemoteDescription(msg.payload);
      for (const c of this.ice.splice(0)) this.pc.addIceCandidate(c).catch(() => {});
      await this.pc.setLocalDescription(await this.pc.createAnswer());
      this.conn.send({ type: 'signal', to: this.presenterId, kind: 'answer', payload: this.pc.localDescription });
    }

    async stats() {
      if (!this.pc) return null;
      return readStats(this.pc, 'inbound');
    }

    close() { this.pc?.close(); this.pc = null; }
  }

  // One-line summary of a connection's video flow.
  async function readStats(pc, dir) {
    const stats = await pc.getStats();
    let rtp = null;
    stats.forEach((r) => { if (r.type === `${dir}-rtp` && (r.kind || r.mediaType) === 'video') rtp = r; });
    if (!rtp) return null;
    return {
      width: rtp.frameWidth, height: rtp.frameHeight, fps: rtp.framesPerSecond,
      bytes: dir === 'inbound' ? rtp.bytesReceived : rtp.bytesSent, timestamp: rtp.timestamp,
      limit: rtp.qualityLimitationReason, codec: stats.get(rtp.codecId)?.mimeType?.split('/')[1],
    };
  }

  SD.P2PPresenter = P2PPresenter;
  SD.P2PViewer = P2PViewer;
  SD.readStats = readStats;
})();
