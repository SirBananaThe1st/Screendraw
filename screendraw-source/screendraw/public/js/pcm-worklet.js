// Plays stereo PCM pushed from the main thread, with a small jitter buffer.
class PcmPlayer extends AudioWorkletProcessor {
  constructor() {
    super();
    this.size = sampleRate * 2; // 2 s ring
    this.l = new Float32Array(this.size); this.r = new Float32Array(this.size);
    this.read = 0; this.write = 0; this.count = 0; this.playing = false;
    this.target = Math.round(sampleRate * 0.06); // start once 60 ms is buffered
    this.max = Math.round(sampleRate * 0.3);     // keep latency under 300 ms
    this.port.onmessage = (e) => {
      const { l, r } = e.data;
      for (let i = 0; i < l.length; i++) {
        this.l[this.write] = l[i]; this.r[this.write] = r[i];
        this.write = (this.write + 1) % this.size;
      }
      this.count = Math.min(this.size, this.count + l.length);
      if (this.count > this.max) { const drop = this.count - this.target; this.read = (this.read + drop) % this.size; this.count -= drop; }
    };
  }
  process(_inputs, outputs) {
    const out = outputs[0];
    const n = out[0].length;
    if (!this.playing && this.count >= this.target) this.playing = true;
    if (!this.playing || this.count < n) { this.playing = this.playing && this.count > 0; return true; } // silence while (re)buffering
    for (let i = 0; i < n; i++) {
      out[0][i] = this.l[this.read];
      if (out[1]) out[1][i] = this.r[this.read];
      this.read = (this.read + 1) % this.size;
    }
    this.count -= n;
    return true;
  }
}
registerProcessor('pcm-player', PcmPlayer);
