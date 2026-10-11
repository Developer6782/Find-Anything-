import { pcm16Base64, resample } from './pcm';

export type MicErrorCode = 'INSECURE_CONTEXT' | 'UNSUPPORTED' | 'PERMISSION_DENIED' | 'NO_DEVICE' | 'IN_USE' | 'UNKNOWN';

export class MicError extends Error {
  code: MicErrorCode;
  hint: string;

  constructor(code: MicErrorCode, message: string, hint: string) {
    super(message);
    this.name = 'MicError';
    this.code = code;
    this.hint = hint;
  }
}

function mapMicError(err: unknown): MicError {
  const name = (err as DOMException)?.name ?? '';
  if (name === 'NotAllowedError' || name === 'SecurityError') {
    return new MicError(
      'PERMISSION_DENIED',
      'Microphone access was blocked.',
      'Allow the microphone in the address-bar permissions, then retry voice.',
    );
  }
  if (name === 'NotFoundError') {
    return new MicError('NO_DEVICE', 'No microphone found.', 'Connect a mic or use the text input instead.');
  }
  if (name === 'NotReadableError' || name === 'AbortError') {
    return new MicError('IN_USE', 'The microphone is busy.', 'Close other apps using the mic and retry.');
  }
  return new MicError('UNKNOWN', (err as Error)?.message || 'Microphone error', 'Retry, or type instead.');
}

export interface MicHandle {
  /** Sends 16 kHz mono PCM16 as base64 — ready for the Live API. */
  onChunk?: (base64Pcm16: string) => void;
  /** RMS level 0..1 for the voice visualiser. */
  getLevel: () => number;
  stop: () => void;
  stream: MediaStream;
}

/**
 * Captures microphone audio, downsamples to 16 kHz mono PCM16 and streams it in
 * ~128 ms chunks. Uses an AudioWorklet; falls back to a ScriptProcessor where
 * worklets are unavailable (older Safari).
 */
export async function startMic(options: { targetRate?: number } = {}): Promise<MicHandle> {
  if (typeof window !== 'undefined' && !window.isSecureContext) {
    throw new MicError('INSECURE_CONTEXT', 'Microphone requires HTTPS.', 'Open the app over HTTPS or localhost.');
  }
  if (!navigator.mediaDevices?.getUserMedia) {
    throw new MicError('UNSUPPORTED', 'getUserMedia is unavailable.', 'Use Chrome, Edge or Safari 16+.');
  }

  let stream: MediaStream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
      video: false,
    });
  } catch (err) {
    throw mapMicError(err);
  }

  const targetRate = options.targetRate ?? 16000;
  const AudioCtx: typeof AudioContext =
    window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
  const ctx = new AudioCtx({ sampleRate: targetRate });
  const source = ctx.createMediaStreamSource(stream);
  const analyser = ctx.createAnalyser();
  analyser.fftSize = 512;
  source.connect(analyser);
  const levelBuffer = new Float32Array(analyser.fftSize);

  const handle: MicHandle = {
    stream,
    getLevel: () => {
      analyser.getFloatTimeDomainData(levelBuffer);
      let sum = 0;
      for (let i = 0; i < levelBuffer.length; i += 1) sum += levelBuffer[i] * levelBuffer[i];
      const rms = Math.sqrt(sum / levelBuffer.length);
      return Math.max(0, Math.min(1, rms * 4));
    },
    stop: () => {
      try {
        source.disconnect();
      } catch {
        /* ignore */
      }
      for (const track of stream.getTracks()) track.stop();
      void ctx.close().catch(() => undefined);
    },
  };

  const emit = (chunk: Float32Array) => {
    if (!handle.onChunk) return;
    const resampled = ctx.sampleRate === targetRate ? chunk : resample(chunk, ctx.sampleRate, targetRate);
    handle.onChunk(pcm16Base64(resampled));
  };

  const workletSupported = 'audioWorklet' in ctx;
  if (workletSupported) {
    try {
      await ctx.audioWorklet.addModule('/worklets/pcm-capture.js');
      const node = new AudioWorkletNode(ctx, 'pcm-capture');
      node.port.onmessage = (event) => emit(event.data as Float32Array);
      source.connect(node);
      // Keep the graph alive without monitoring the mic back to the speakers.
      const silent = ctx.createGain();
      silent.gain.value = 0;
      node.connect(silent).connect(ctx.destination);
      return handle;
    } catch {
      /* fall through to ScriptProcessor */
    }
  }

  const processor = (ctx as unknown as { createScriptProcessor: (b: number, i: number, o: number) => ScriptProcessorNode }).createScriptProcessor(2048, 1, 1);
  processor.onaudioprocess = (event) => emit(new Float32Array(event.inputBuffer.getChannelData(0)));
  source.connect(processor);
  const silent = ctx.createGain();
  silent.gain.value = 0;
  processor.connect(silent).connect(ctx.destination);
  return handle;
}
