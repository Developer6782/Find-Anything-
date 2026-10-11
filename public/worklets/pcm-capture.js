/**
 * Captures microphone Float32 samples and posts them to the main thread in
 * ~128 ms batches. Runs on the audio thread so the UI never glitches audio.
 */
class PcmCaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.batch = new Float32Array(2048);
    this.filled = 0;
  }

  process(inputs) {
    const channel = inputs[0] && inputs[0][0];
    if (!channel) return true;
    for (let i = 0; i < channel.length; i += 1) {
      this.batch[this.filled] = channel[i];
      this.filled += 1;
      if (this.filled === this.batch.length) {
        const copy = this.batch.slice(0);
        this.port.postMessage(copy, [copy.buffer]);
        this.filled = 0;
      }
    }
    return true;
  }
}

registerProcessor('pcm-capture', PcmCaptureProcessor);
