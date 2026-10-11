import { liveSocketUrl } from '../gemini/transport';

/**
 * Gemini Live API session (voice + streamed video) over the app's own
 * websocket proxy. Nothing here assumes a capability: the session is connected
 * by actually probing candidate Live models until one completes its setup, and
 * any failure is surfaced verbatim so the UI can fall back honestly instead of
 * pretending the feature works.
 */

export type LiveStatus = 'idle' | 'connecting' | 'ready' | 'reconnecting' | 'closed' | 'error';

export interface LiveModelError {
  code: string;
  message: string;
  hint?: string;
}

export interface LiveSessionCallbacks {
  onStatus: (status: LiveStatus, detail?: string) => void;
  /** Text output (including the per-frame JSON status lines). */
  onModelText: (text: string, turnComplete: boolean) => void;
  /** Base64 PCM16 @24 kHz audio from the model. */
  onModelAudio: (base64: string) => void;
  /** What the model heard from the user (input audio transcription). */
  onInputTranscript: (text: string) => void;
  onInterrupted: () => void;
  onError: (error: LiveModelError) => void;
}

export interface ConnectOptions {
  apiKey: string;
  modelCandidates: string[];
  systemInstruction: string;
  voiceName?: string;
}

const SETUP_TIMEOUT_MS = 20_000;

export class LiveSession {
  private ws: WebSocket | null = null;
  private callbacks: LiveSessionCallbacks;
  private status: LiveStatus = 'idle';
  private activeModel: string | null = null;
  private shouldSendAudio = false;

  constructor(callbacks: LiveSessionCallbacks) {
    this.callbacks = callbacks;
  }

  get model(): string | null {
    return this.activeModel;
  }

  get statusNow(): LiveStatus {
    return this.status;
  }

  private setStatus(status: LiveStatus, detail?: string): void {
    this.status = status;
    this.callbacks.onStatus(status, detail);
  }

  /**
   * Probes candidate models in order and resolves with the first one whose
   * `setupComplete` arrives. Rejects with the last error if none work.
   */
  async connect(options: ConnectOptions): Promise<string> {
    this.setStatus('connecting');
    let lastError: LiveModelError = { code: 'UNKNOWN', message: 'No Live model could be started.' };

    for (const model of options.modelCandidates) {
      try {
        await this.attempt(model, options);
        this.activeModel = model;
        this.setStatus('ready', model);
        return model;
      } catch (err) {
        lastError = err as LiveModelError;
        // Invalid key / quota will not improve by trying another model.
        if (lastError.code === 'INVALID_KEY' || lastError.code === 'NO_KEY' || lastError.code === 'PERMISSION_DENIED') break;
      }
    }
    this.setStatus('error', lastError.message);
    this.callbacks.onError(lastError);
    throw lastError;
  }

  private attempt(model: string, options: ConnectOptions): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      let settled = false;
      let socket: WebSocket;
      try {
        socket = new WebSocket(liveSocketUrl());
      } catch (err) {
        reject({ code: 'NETWORK', message: (err as Error).message } satisfies LiveModelError);
        return;
      }
      this.ws = socket;

      const timer = window.setTimeout(() => {
        if (settled) return;
        settled = true;
        try {
          socket.close();
        } catch {
          /* ignore */
        }
        reject({ code: 'TIMEOUT', message: `"${model}" did not finish the Live handshake in time.` } satisfies LiveModelError);
      }, SETUP_TIMEOUT_MS);

      const finish = (fn: () => void) => {
        if (settled) return;
        settled = true;
        window.clearTimeout(timer);
        fn();
      };

      const sendSetup = (includeVoice: boolean) => {
        const setup: Record<string, unknown> = {
          model: `models/${model}`,
          generationConfig: {
            responseModalities: ['AUDIO'],
            ...(includeVoice && options.voiceName
              ? { speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: options.voiceName } } } }
              : {}),
          },
          systemInstruction: { parts: [{ text: options.systemInstruction }] },
          inputAudioTranscription: {},
          outputAudioTranscription: {},
        };
        // Real-time input: audio is pushed as 16 kHz PCM, video as JPEG frames.
        (setup as { realtimeInputConfig?: unknown }).realtimeInputConfig = {
          automaticActivityDetection: { disabled: false },
        };
        socket.send(JSON.stringify({ setup }));
      };

      socket.onopen = () => {
        socket.send(JSON.stringify({ auth: { apiKey: options.apiKey, model } }));
        sendSetup(true);
      };

      socket.onmessage = async (event) => {
        const raw = typeof event.data === 'string' ? event.data : await (event.data as Blob).text();
        let payload: any;
        try {
          payload = JSON.parse(raw);
        } catch {
          return;
        }

        if (payload.__error) {
          const err = payload.__error as LiveModelError;
          // Voice config is the usual culprit for INVALID_ARGUMENT — retry once without it.
          if (!settled && /voice|speech/i.test(err.message) && options.voiceName) {
            sendSetup(false);
            return;
          }
          reject(err);
          try {
            socket.close();
          } catch {
            /* ignore */
          }
          return;
        }
        if (payload.__closed) {
          const detail = String(payload.__closed.reason ?? '');
          if (!settled) {
            // Classify honestly: a bad key must not be retried against every
            // candidate model, and "unsupported for this key" must be visible.
            const invalidKey = /api key not valid|api_key_invalid|api key expired|key expired/i.test(detail);
            const unsupported = /not found|not supported|unsupported|INVALID_ARGUMENT|permission/i.test(detail);
            const code = invalidKey ? 'INVALID_KEY' : unsupported ? 'MODEL_UNSUPPORTED' : 'UPSTREAM';
            const message = invalidKey
              ? 'Gemini rejected your API key for the Live voice session.'
              : detail || `"${model}" closed the Live session.`;
            const hint = invalidKey
              ? 'Fix the key in Settings — push-to-talk and typed chat still work.'
              : unsupported
                ? 'This key cannot use that Live model; push-to-talk mode is active instead.'
                : undefined;
            reject({ code, message, hint } satisfies LiveModelError);
          } else {
            this.setStatus('closed', detail);
          }
          return;
        }
        if (payload.error) {
          const message = payload.error.message ?? 'Live API error';
          if (!settled) {
            reject({ code: 'UPSTREAM', message } satisfies LiveModelError);
          } else {
            this.callbacks.onError({ code: 'UPSTREAM', message });
          }
          return;
        }
        if (payload.setupComplete) {
          finish(() => resolve());
          return;
        }
        if (payload.goAway) {
          this.setStatus('reconnecting', 'Server asked the session to reconnect.');
          return;
        }

        const content = payload.serverContent;
        if (!content) return;

        if (content.interrupted) this.callbacks.onInterrupted();

        const parts = content.modelTurn?.parts ?? [];
        let text = '';
        for (const part of parts) {
          if (part.inlineData?.data) this.callbacks.onModelAudio(part.inlineData.data);
          if (typeof part.text === 'string') text += part.text;
        }
        if (text.trim() || content.turnComplete) {
          this.callbacks.onModelText(text.trim(), Boolean(content.turnComplete));
        }
        const inputTranscript = content.inputTranscription?.text;
        if (typeof inputTranscript === 'string' && inputTranscript.trim()) {
          this.callbacks.onInputTranscript(inputTranscript.trim());
        }
      };

      socket.onerror = () => {
        reject({ code: 'NETWORK', message: 'The Live socket failed to connect.' } satisfies LiveModelError);
      };

      socket.onclose = (event) => {
        if (!settled) {
          const code = event.code === 1008 || event.code === 1000 ? 'MODEL_UNSUPPORTED' : 'NETWORK';
          reject({
            code,
            message: event.reason || `Live socket closed while starting "${model}" (code ${event.code}).`,
          } satisfies LiveModelError);
          return;
        }
        if (this.status !== 'closed') this.setStatus('closed', event.reason || undefined);
      };
    });
  }

  /** Streams microphone audio (base64 PCM16 @16 kHz) to the model. */
  sendAudio(base64Pcm16: string): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN || !this.shouldSendAudio) return;
    if (!base64Pcm16) return;
    this.ws.send(
      JSON.stringify({
        realtimeInput: { mediaChunks: [{ mimeType: 'audio/pcm;rate=16000', data: base64Pcm16 }] },
      }),
    );
  }

  setAudioEnabled(enabled: boolean): void {
    this.shouldSendAudio = enabled;
  }

  /** Streams one downscaled camera frame for the model's visual understanding. */
  sendVideoFrame(base64Jpeg: string): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    this.ws.send(
      JSON.stringify({
        realtimeInput: { mediaChunks: [{ mimeType: 'image/jpeg', data: base64Jpeg }] },
      }),
    );
  }

  /** Text turn (typed message or system-side nudge). */
  sendText(text: string): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    this.ws.send(
      JSON.stringify({
        clientContent: { turns: [{ role: 'user', parts: [{ text }] }], turnComplete: true },
      }),
    );
  }

  close(): void {
    this.shouldSendAudio = false;
    try {
      this.ws?.close();
    } catch {
      /* ignore */
    }
    this.ws = null;
    this.setStatus('closed');
  }
}

/**
 * Extracts the per-frame JSON status object the live model is instructed to
 * emit (`{"visible":…,"confidence":…,"reason":…,"guide":…}`).
 */
export function parseStatusLine(text: string): {
  visible?: boolean;
  confidence?: number;
  reason?: string;
  guide?: string;
  box?: { x: number; y: number; width: number; height: number } | null;
  cleaned: string;
} | null {
  if (!text) return null;
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try {
    const parsed = JSON.parse(match[0]);
    if (typeof parsed !== 'object' || parsed === null) return null;
    return {
      visible: typeof parsed.visible === 'boolean' ? parsed.visible : undefined,
      confidence: Number.isFinite(Number(parsed.confidence)) ? Number(parsed.confidence) : undefined,
      reason: typeof parsed.reason === 'string' ? parsed.reason : undefined,
      guide: typeof parsed.guide === 'string' ? parsed.guide : undefined,
      box: parsed.guessBox ?? parsed.bbox ?? null,
      cleaned: text.replace(match[0], '').trim(),
    };
  } catch {
    return null;
  }
}
