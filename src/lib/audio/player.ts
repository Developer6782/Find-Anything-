import { base64ToFloat32 } from './pcm';

/**
 * Streams PCM16 @24 kHz audio chunks returned by the Live API with sample-accurate
 * scheduling, so sentences do not stutter between chunks.
 */
export class AudioPlayer {
  private ctx: AudioContext | null = null;
  private nextStart = 0;
  private active = new Set<AudioBufferSourceNode>();
  private speaking = false;
  private speakTimer: number | null = null;
  onSpeakingChange?: (speaking: boolean) => void;

  private ensure(): AudioContext {
    if (!this.ctx || this.ctx.state === 'closed') {
      const Ctx: typeof AudioContext =
        window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      this.ctx = new Ctx({ sampleRate: 24000 });
      this.nextStart = 0;
    }
    if (this.ctx.state === 'suspended') void this.ctx.resume();
    return this.ctx;
  }

  get isSpeaking(): boolean {
    return this.speaking;
  }

  /** Enqueue one base64 PCM16 @24 kHz chunk from the Live API. */
  enqueue(base64Pcm16: string): void {
    const ctx = this.ensure();
    const samples = base64ToFloat32(base64Pcm16);
    if (!samples.length) return;
    const buffer = ctx.createBuffer(1, samples.length, 24000);
    buffer.getChannelData(0).set(samples);

    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.connect(ctx.destination);
    const startAt = Math.max(ctx.currentTime + 0.03, this.nextStart);
    source.start(startAt);
    this.nextStart = startAt + buffer.duration;

    this.active.add(source);
    this.setSpeaking(true);
    source.onended = () => {
      this.active.delete(source);
      if (!this.active.size) this.setSpeaking(false);
    };
  }

  private setSpeaking(value: boolean): void {
    if (this.speaking === value) return;
    this.speaking = value;
    this.onSpeakingChange?.(value);
    if (this.speakTimer !== null) {
      window.clearTimeout(this.speakTimer);
      this.speakTimer = null;
    }
  }

  /** Stops playback (e.g. the model was interrupted by the user). */
  stop(): void {
    for (const source of this.active) {
      try {
        source.stop();
      } catch {
        /* ignore */
      }
    }
    this.active.clear();
    this.nextStart = 0;
    this.setSpeaking(false);
  }

  async close(): Promise<void> {
    this.stop();
    if (this.ctx && this.ctx.state !== 'closed') await this.ctx.close().catch(() => undefined);
    this.ctx = null;
  }
}

/**
 * Browser TTS used by the push-to-talk fallback (when the Live API is not
 * available for the key). Prefers an Indian/US English voice when present.
 */
export class Speaker {
  private speaking = false;
  onSpeakingChange?: (speaking: boolean) => void;

  static supported(): boolean {
    return typeof window !== 'undefined' && 'speechSynthesis' in window;
  }

  get isSpeaking(): boolean {
    return this.speaking;
  }

  private pickVoice(): SpeechSynthesisVoice | null {
    const voices = window.speechSynthesis.getVoices();
    if (!voices.length) return null;
    const preferred = [
      (v: SpeechSynthesisVoice) => /en-IN/i.test(v.lang),
      (v: SpeechSynthesisVoice) => /en-GB/i.test(v.lang),
      (v: SpeechSynthesisVoice) => /en-US/i.test(v.lang),
      (v: SpeechSynthesisVoice) => /^en/i.test(v.lang),
    ];
    for (const test of preferred) {
      const match = voices.find(test);
      if (match) return match;
    }
    return voices[0] ?? null;
  }

  speak(text: string, options: { rate?: number; pitch?: number } = {}): void {
    if (!Speaker.supported() || !text.trim()) return;
    const synth = window.speechSynthesis;
    synth.cancel();
    const utterance = new SpeechSynthesisUtterance(text.trim().slice(0, 600));
    const voice = this.pickVoice();
    if (voice) utterance.voice = voice;
    utterance.rate = options.rate ?? 1.02;
    utterance.pitch = options.pitch ?? 1;
    utterance.onstart = () => {
      this.speaking = true;
      this.onSpeakingChange?.(true);
    };
    utterance.onend = utterance.onerror = () => {
      this.speaking = false;
      this.onSpeakingChange?.(false);
    };
    synth.speak(utterance);
  }

  cancel(): void {
    if (!Speaker.supported()) return;
    window.speechSynthesis.cancel();
    this.speaking = false;
    this.onSpeakingChange?.(false);
  }
}
