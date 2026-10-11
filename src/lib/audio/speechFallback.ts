/**
 * Push-to-talk voice fallback.
 *
 * Used when the Gemini Live API is not available for the user's key/tier (the
 * app probes for real and falls back here — it never fakes a live session).
 * Speech-to-text runs in the browser, the reply comes from Gemini's normal
 * multimodal endpoints (with the current camera frame attached), and the answer
 * is spoken with browser TTS.
 */

type RecognitionLike = {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  maxAlternatives: number;
  start: () => void;
  stop: () => void;
  abort: () => void;
  onresult: ((event: any) => void) | null;
  onerror: ((event: any) => void) | null;
  onend: (() => void) | null;
};

export interface PushToTalkCallbacks {
  onPartial: (text: string) => void;
  onFinal: (text: string) => void;
  onError: (message: string) => void;
  onListeningChange: (listening: boolean) => void;
}

export function speechRecognitionSupported(): boolean {
  if (typeof window === 'undefined') return false;
  const w = window as any;
  return Boolean(w.SpeechRecognition || w.webkitSpeechRecognition);
}

export class PushToTalk {
  private recognition: RecognitionLike | null = null;
  private listening = false;

  constructor(private callbacks: PushToTalkCallbacks) {}

  start(): boolean {
    if (!speechRecognitionSupported()) {
      this.callbacks.onError('This browser has no speech recognition. Type your question instead.');
      return false;
    }
    if (this.listening) return true;
    const w = window as any;
    const Ctor = w.SpeechRecognition || w.webkitSpeechRecognition;
    const recognition: RecognitionLike = new Ctor();
    recognition.lang = navigator.language?.startsWith('hi') ? 'hi-IN' : 'en-IN';
    recognition.continuous = false;
    recognition.interimResults = true;
    recognition.maxAlternatives = 1;

    let finalText = '';
    recognition.onresult = (event: any) => {
      let partial = '';
      for (let i = event.resultIndex; i < event.results.length; i += 1) {
        const result = event.results[i];
        if (result.isFinal) finalText += result[0].transcript;
        else partial += result[0].transcript;
      }
      if (partial) this.callbacks.onPartial(partial);
    };
    recognition.onerror = (event: any) => {
      const code = event?.error ?? 'unknown';
      if (code === 'no-speech') return;
      this.callbacks.onError(
        code === 'not-allowed'
          ? 'Microphone permission is needed for voice input.'
          : `Speech recognition failed (${code}).`,
      );
    };
    recognition.onend = () => {
      this.listening = false;
      this.callbacks.onListeningChange(false);
      const text = finalText.trim();
      if (text) this.callbacks.onFinal(text);
      this.recognition = null;
    };

    try {
      recognition.start();
      this.recognition = recognition;
      this.listening = true;
      this.callbacks.onListeningChange(true);
      return true;
    } catch (err) {
      this.callbacks.onError((err as Error)?.message || 'Could not start speech recognition.');
      return false;
    }
  }

  stop(): void {
    try {
      this.recognition?.stop();
    } catch {
      /* ignore */
    }
  }

  abort(): void {
    try {
      this.recognition?.abort();
    } catch {
      /* ignore */
    }
    this.listening = false;
    this.callbacks.onListeningChange(false);
  }

  get isListening(): boolean {
    return this.listening;
  }
}
