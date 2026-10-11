import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { DETECTION, LIVE, LIVE_MODEL_CANDIDATES } from '../lib/config';
import type { BBox, TargetProfile, VerifyResult } from '../lib/contracts';
import { geminiApi } from '../lib/gemini/client';
import { GeminiClientError } from '../lib/gemini/transport';
import { getKey } from '../lib/security/keyVault';
import { buildAnchors, type AnchorTemplate } from '../lib/vision/matcher';
import {
  cropBoxFromDataUrl,
  fileToDataUrl,
  FrameGrabber,
  type CapturedJpeg,
  imageToGray,
  loadImage,
} from '../lib/vision/frames';
import type { GrayImage } from '../lib/vision/imageOps';
import { VisionEngine, type EngineEvent, type EngineSnapshot, type Observation, type TrackerState } from '../lib/vision/engine';
import { AudioPlayer, Speaker } from '../lib/audio/player';
import { LiveSession, parseStatusLine, type LiveStatus } from '../lib/audio/liveSession';
import { startMic, type MicHandle } from '../lib/audio/mic';
import { PushToTalk, speechRecognitionSupported } from '../lib/audio/speechFallback';
import { uid } from '../lib/format';
import { useCamera } from './useCamera';
import type { SettingsApi } from './useSettings';

/* ─────────────────────────────── types ─────────────────────────────────── */

export type SessionStatus =
  | 'setup'
  | 'analysing'
  | 'ready'
  | 'starting'
  | 'searching'
  | 'paused'
  | 'ended'
  | 'error';

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant' | 'guidance' | 'system';
  text: string;
  at: number;
  model?: string;
  tone?: 'neutral' | 'good' | 'warn' | 'error';
}

export interface Toast {
  id: string;
  tone: 'error' | 'warn' | 'info' | 'success';
  title: string;
  message: string;
  hint?: string;
}

export interface ReferenceState {
  dataUrl: string | null;
  fileName: string | null;
  status: 'empty' | 'loading' | 'analysing' | 'ready' | 'error';
  profile: TargetProfile | null;
  warnings: string[];
  error: string | null;
  analysedAt: number | null;
  model: string | null;
  latencyMs: number | null;
}

export interface VoiceState {
  liveStatus: LiveStatus;
  liveModel: string | null;
  liveDetail: string | null;
  fallbackActive: boolean;
  fallbackReason: string | null;
  micStreaming: boolean;
  pttListening: boolean;
  modelSpeaking: boolean;
  userLevel: number;
  liveFramesSent: number;
}

export interface SessionStats {
  startedAt: number | null;
  durationMs: number;
  locks: number;
  losses: number;
  modelCalls: number;
  observations: number;
}

/* ─────────────────────────────── hook ──────────────────────────────────── */

const INITIAL_SNAPSHOT: EngineSnapshot = {
  state: 'idle',
  box: null,
  rawBox: null,
  confidence: 0,
  source: 'none',
  lastSeenAt: null,
  lastReason: '',
  modelSeesTarget: null,
  stats: {
    modelCalls: 0,
    modelErrors: 0,
    verifyCalls: 0,
    localScore: 0,
    modelConfidence: 0,
    lastLatencyMs: 0,
    avgLatencyMs: 0,
    verifyVerdicts: 0,
    verifyRejections: 0,
  },
};

export function useSearchSession(settings: SettingsApi) {
  const camera = useCamera();
  const [status, setStatus] = useState<SessionStatus>('setup');
  const [reference, setReference] = useState<ReferenceState>({
    dataUrl: null,
    fileName: null,
    status: 'empty',
    profile: null,
    warnings: [],
    error: null,
    analysedAt: null,
    model: null,
    latencyMs: null,
  });
  const [snapshot, setSnapshot] = useState<EngineSnapshot>(INITIAL_SNAPSHOT);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [observations, setObservations] = useState<Observation[]>([]);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [stats, setStats] = useState<SessionStats>({
    startedAt: null,
    durationMs: 0,
    locks: 0,
    losses: 0,
    modelCalls: 0,
    observations: 0,
  });
  const [voice, setVoice] = useState<VoiceState>({
    liveStatus: 'idle',
    liveModel: null,
    liveDetail: null,
    fallbackActive: false,
    fallbackReason: null,
    micStreaming: false,
    pttListening: false,
    modelSpeaking: false,
    userLevel: 0,
    liveFramesSent: 0,
  });

  const engineRef = useRef<VisionEngine | null>(null);
  const liveRef = useRef<LiveSession | null>(null);
  const micRef = useRef<MicHandle | null>(null);
  const playerRef = useRef<AudioPlayer | null>(null);
  const speakerRef = useRef<Speaker | null>(null);
  const pttRef = useRef<PushToTalk | null>(null);
  const grabberRef = useRef(new FrameGrabber());
  const referenceImageRef = useRef<HTMLImageElement | null>(null);
  const referenceGrayRef = useRef<GrayImage | null>(null);
  const referencePayloadRef = useRef<{ data: string; mimeType: string } | null>(null);
  const instructionRef = useRef<{ instruction: string; scenePrompt: string } | null>(null);
  const anchorsRef = useRef<AnchorTemplate[]>([]);
  const liveTimerRef = useRef<number | null>(null);
  const levelTimerRef = useRef<number | null>(null);
  const lastSpeechAtRef = useRef(0);
  const statusRef = useRef<SessionStatus>('setup');
  const lastUserLineRef = useRef<{ text: string; at: number } | null>(null);

  statusRef.current = status;

  const pushToast = useCallback((toast: Omit<Toast, 'id'>) => {
    setToasts((prev) => [...prev.slice(-3), { ...toast, id: uid('toast') }]);
  }, []);

  const dismissToast = useCallback((id: string) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const pushMessage = useCallback((message: Omit<ChatMessage, 'id' | 'at'> & { at?: number }) => {
    setMessages((prev) => [...prev.slice(-80), { ...message, id: uid('msg'), at: message.at ?? Date.now() }]);
  }, []);

  const pushObservation = useCallback((observation: Observation) => {
    setObservations((prev) => [observation, ...prev].slice(0, 40));
    setStats((s) => ({ ...s, observations: s.observations + 1 }));
  }, []);

  /* ── reference handling ── */

  const buildAnchorTemplates = useCallback((profile: TargetProfile | null) => {
    const gray = referenceGrayRef.current;
    if (!gray) return [];
    const box =
      profile?.targetBBox && profile.targetBBox.width > 0.05
        ? profile.targetBBox
        : { x: 0.15, y: 0.15, width: 0.7, height: 0.7 };
    const anchors = buildAnchors(gray, box);
    anchorsRef.current = anchors;
    return anchors;
  }, []);

  const analyseWithKey = useCallback(
    async (apiKey: string) => {
      const payload = referencePayloadRef.current;
      if (!payload) {
        pushToast({
          tone: 'warn',
          title: 'No reference photo',
          message: 'Upload a photo of the object first.',
        });
        return null;
      }
      setReference((prev) => ({ ...prev, status: 'analysing', error: null }));
      try {
        const result = await geminiApi.analyze(apiKey, settings.prefs.textModel, payload);
        const anchors = buildAnchorTemplates(result.profile);
        if (!anchors.length) {
          pushToast({
            tone: 'warn',
            title: 'Weak reference photo',
            message: 'Could not extract a matching template from that photo.',
            hint: 'Use a closer, sharper photo of a single object with some texture.',
          });
        }
        setReference((prev) => ({
          ...prev,
          status: 'ready',
          profile: result.profile,
          warnings: result.warnings,
          error: null,
          analysedAt: Date.now(),
          model: result.model,
          latencyMs: result.latencyMs,
        }));
        instructionRef.current = null; // rebuilt for the new target
        engineRef.current?.setProfile(result.profile, anchors);
        pushMessage({
          role: 'system',
          text: `Target locked in: ${result.profile.name}. ${result.profile.sceneGuidance}`,
          tone: 'good',
        });
        return result.profile;
      } catch (err) {
        const error = err as GeminiClientError;
        setReference((prev) => ({ ...prev, status: 'error', error: error.message }));
        pushToast({
          tone: 'error',
          title: error.code === 'INVALID_KEY' ? 'Invalid API key' : 'Analysis failed',
          message: error.message,
          hint: error.hint,
        });
        return null;
      }
    },
    [buildAnchorTemplates, pushMessage, pushToast, settings.prefs.textModel],
  );

  const setReferenceFile = useCallback(
    async (file: File) => {
      const key = getKey();
      setReference((prev) => ({ ...prev, status: 'loading', fileName: file.name, error: null, warnings: [] }));
      try {
        if (!file.type.startsWith('image/')) throw new Error('That file is not an image.');
        if (file.size > 6 * 1024 * 1024) throw new Error('Image is larger than 6 MB. Use a smaller photo.');
        const dataUrl = await fileToDataUrl(file);
        const image = await loadImage(dataUrl);
        referenceImageRef.current = image;
        const comma = dataUrl.indexOf(',');
        referencePayloadRef.current = {
          data: dataUrl.slice(comma + 1),
          mimeType: dataUrl.slice(5, dataUrl.indexOf(';')),
        };
        referenceGrayRef.current = await imageToGray(image, 512);
        setReference((prev) => ({
          ...prev,
          dataUrl,
          status: key ? 'analysing' : 'loading',
          profile: null,
          analysedAt: null,
        }));
        if (key) await analyseWithKey(key);
        else {
          setReference((prev) => ({ ...prev, status: 'loading' }));
          pushToast({
            tone: 'info',
            title: 'Add your Gemini API key',
            message: 'The photo is ready — connect a key so the agent can analyse it.',
          });
        }
      } catch (err) {
        setReference((prev) => ({ ...prev, status: 'error', error: (err as Error).message }));
        pushToast({ tone: 'error', title: 'Could not use that image', message: (err as Error).message });
      }
    },
    [analyseWithKey, pushToast],
  );

  const clearReference = useCallback(() => {
    referenceImageRef.current = null;
    referenceGrayRef.current = null;
    referencePayloadRef.current = null;
    anchorsRef.current = [];
    instructionRef.current = null;
    engineRef.current?.setProfile(null, []);
    setReference({
      dataUrl: null,
      fileName: null,
      status: 'empty',
      profile: null,
      warnings: [],
      error: null,
      analysedAt: null,
      model: null,
      latencyMs: null,
    });
  }, []);

  const reanalyse = useCallback(async () => {
    const key = getKey();
    if (!key) {
      pushToast({ tone: 'warn', title: 'No API key', message: 'Connect your Gemini API key first.' });
      return;
    }
    await analyseWithKey(key);
  }, [analyseWithKey, pushToast]);

  /* ── engine events → conversation ── */

  const speak = useCallback(
    (text: string, kind: 'guidance' | 'assistant' = 'guidance') => {
      if (!settings.prefs.speakCues || !text) return;
      if (liveRef.current?.statusNow === 'ready') return; // the live model is the voice
      const speaker = speakerRef.current;
      if (!speaker) return;
      if (micRef.current) return; // user is talking
      speaker.speak(text);
      lastSpeechAtRef.current = Date.now();
      pushMessage({ role: kind, text, tone: 'neutral' });
    },
    [pushMessage, settings.prefs.speakCues],
  );

  const handleEngineEvent = useCallback(
    (event: EngineEvent) => {
      setStats((s) => ({
        ...s,
        locks: event.type === 'acquired' || event.type === 'reacquired' ? s.locks + 1 : s.locks,
        losses: event.type === 'lost' ? s.losses + 1 : s.losses,
      }));
      if (event.type === 'lost' || event.type === 'occluded' || event.type === 'acquired' || event.type === 'reacquired') {
        pushObservation({
          id: uid('obs'),
          at: Date.now(),
          kind: 'local',
          tone: event.type === 'acquired' || event.type === 'reacquired' ? 'good' : 'warn',
          text: event.message,
        });
      }
      if (event.speak) speak(event.speak);
    },
    [pushObservation, speak],
  );

  const engineDetect = useCallback(
    async (frame: CapturedJpeg, profile: TargetProfile | null) => {
      const key = getKey();
      if (!key) throw new GeminiClientError('No API key connected.', 'NO_KEY');
      const history = observationsRef.current
        .filter((o) => o.kind === 'model' || o.kind === 'verify')
        .slice(0, 5)
        .map((o) => o.text);
      return geminiApi.detect(key, settings.prefs.textModel, frame, profile, history);
    },
    [settings.prefs.textModel],
  );

  const observationsRef = useRef<Observation[]>([]);
  observationsRef.current = observations;

  const engineVerify = useCallback(
    async (frame: CapturedJpeg, box: BBox, profile: TargetProfile | null): Promise<VerifyResult> => {
      const key = getKey();
      const payload = referencePayloadRef.current;
      if (!key || !payload) throw new GeminiClientError('Verification needs a key and a reference photo.', 'NO_KEY');
      const dataUrl = `data:${frame.mimeType};base64,${frame.base64}`;
      const crop = await cropBoxFromDataUrl(dataUrl, box, 0.1, 320, 0.7);
      if (!crop) throw new Error('Could not cut the candidate crop.');
      return geminiApi.verify(key, settings.prefs.textModel, payload, crop, profile);
    },
    [settings.prefs.textModel],
  );

  const ensureEngine = useCallback((): VisionEngine => {
    if (engineRef.current) return engineRef.current;
    const engine = new VisionEngine({
      detect: engineDetect,
      verify: engineVerify,
      onSnapshot: (next) => {
        setSnapshot(next);
        setStats((s) => ({ ...s, modelCalls: next.stats.modelCalls }));
      },
      onObservation: pushObservation,
      onEvent: handleEngineEvent,
      settings: () => ({
        detectFps: settings.prefs.detectFps,
        acquireConfidence: DETECTION.acquireConfidence,
        verifyEnabled: settings.prefs.verifyEnabled,
      }),
    });
    engineRef.current = engine;
    return engine;
  }, [engineDetect, engineVerify, handleEngineEvent, pushObservation, settings.prefs.detectFps, settings.prefs.verifyEnabled]);

  /* ── voice agent ── */

  const stopLiveFrames = useCallback(() => {
    if (liveTimerRef.current !== null) {
      window.clearInterval(liveTimerRef.current);
      liveTimerRef.current = null;
    }
  }, []);

  const startLiveFrames = useCallback(() => {
    stopLiveFrames();
    liveTimerRef.current = window.setInterval(() => {
      const live = liveRef.current;
      const video = camera.videoRef.current;
      if (!live || live.statusNow !== 'ready' || !video || statusRef.current !== 'searching') return;
      if (playerRef.current?.isSpeaking) return;
      if (Date.now() - lastSpeechAtRef.current < LIVE.avoidWhileSpeakingMs) return;
      const frame = grabberRef.current.captureJpeg(video, LIVE.frameWidth, 0.6);
      if (!frame) return;
      live.sendVideoFrame(frame.base64);
      setVoice((v) => ({ ...v, liveFramesSent: v.liveFramesSent + 1 }));
    }, LIVE.frameIntervalMs);
  }, [camera.videoRef, stopLiveFrames]);

  const stopMic = useCallback(() => {
    micRef.current?.stop();
    micRef.current = null;
    if (levelTimerRef.current !== null) {
      window.clearInterval(levelTimerRef.current);
      levelTimerRef.current = null;
    }
    liveRef.current?.setAudioEnabled(false);
    setVoice((v) => ({ ...v, micStreaming: false, userLevel: 0 }));
  }, []);

  const startMicStreaming = useCallback(async () => {
    if (micRef.current) return true;
    try {
      const mic = await startMic();
      mic.onChunk = (chunk) => liveRef.current?.sendAudio(chunk);
      micRef.current = mic;
      liveRef.current?.setAudioEnabled(true);
      levelTimerRef.current = window.setInterval(() => {
        const level = micRef.current?.getLevel() ?? 0;
        setVoice((v) => ({ ...v, userLevel: level }));
      }, 120);
      setVoice((v) => ({ ...v, micStreaming: true }));
      return true;
    } catch (err) {
      const micError = err as { message: string; hint?: string; code?: string };
      pushToast({
        tone: 'warn',
        title: 'Microphone unavailable',
        message: micError.message,
        hint: micError.hint,
      });
      return false;
    }
  }, [pushToast]);

  const setupFallbackVoice = useCallback(
    (reason: string) => {
      pttRef.current?.abort();
      pttRef.current = new PushToTalk({
        onPartial: () => undefined,
        onFinal: (text) => {
          void askRef.current(text);
        },
        onError: (message) => pushToast({ tone: 'warn', title: 'Voice input', message }),
        onListeningChange: (listening) => setVoice((v) => ({ ...v, pttListening: listening })),
      });
      setVoice((v) => ({ ...v, fallbackActive: true, fallbackReason: reason }));
      pushMessage({
        role: 'system',
        tone: 'warn',
        text: `Live voice unavailable — ${reason} Using push-to-talk + typed input instead.`,
      });
    },
    [pushMessage, pushToast],
  );

  const connectAgent = useCallback(async () => {
    const key = getKey();
    if (!key) return;

    const instruction =
      instructionRef.current ??
      (await geminiApi
        .liveInstruction(reference.profile, settings.prefs.voiceStyle)
        .then((res) => {
          instructionRef.current = res;
          return res;
        })
        .catch(() => null));

    const session = new LiveSession({
      onStatus: (liveStatus, detail) => {
        setVoice((v) => ({ ...v, liveStatus, liveModel: liveRef.current?.model ?? v.liveModel, liveDetail: detail ?? v.liveDetail }));
      },
      onModelAudio: (base64) => {
        playerRef.current?.enqueue(base64);
      },
      onModelText: (text, turnComplete) => {
        const parsed = parseStatusLine(text);
        if (parsed) {
          if (typeof parsed.visible === 'boolean') {
            engineRef.current?.pushExternal({
              source: 'gemini-live',
              visible: parsed.visible,
              confidence: parsed.confidence ?? (parsed.visible ? 0.6 : 0.2),
              reason: parsed.reason,
              box: null,
            });
          }
          const spoken = [parsed.cleaned, parsed.guide].filter(Boolean).join(' ').trim();
          if (spoken) pushMessage({ role: 'assistant', text: spoken });
          return;
        }
        if (text.trim()) pushMessage({ role: 'assistant', text: text.trim(), tone: turnComplete ? 'neutral' : undefined });
      },
      onInputTranscript: (text) => {
        const last = lastUserLineRef.current;
        if (last && last.text === text && Date.now() - last.at < 4000) return;
        lastUserLineRef.current = { text, at: Date.now() };
        pushMessage({ role: 'user', text });
      },
      onInterrupted: () => {
        playerRef.current?.stop();
      },
      onError: (error) => {
        pushToast({ tone: 'warn', title: 'Voice agent', message: error.message, hint: error.hint });
        setupFallbackVoice(error.message);
      },
    });

    liveRef.current = session;
    const candidates = [settings.prefs.liveModel, ...LIVE_MODEL_CANDIDATES].filter(
      (m, i, arr) => m && arr.indexOf(m) === i,
    );

    try {
      const model = await session.connect({
        apiKey: key,
        modelCandidates: candidates,
        systemInstruction: instruction?.instruction ?? '',
        voiceName: 'Aoede',
      });
      setVoice((v) => ({ ...v, liveStatus: 'ready', liveModel: model, fallbackActive: false, fallbackReason: null }));
      pushMessage({ role: 'system', tone: 'good', text: `Voice agent online — ${model}` });
      startLiveFrames();
      if (settings.prefs.voiceEnabled) {
        const micOk = await startMicStreaming();
        if (!micOk) {
          pushToast({
            tone: 'info',
            title: 'Voice is text-only',
            message: 'The agent can speak, but your mic is off — type messages instead.',
          });
        }
      }
      session.sendText(
        `Session started. Say one short line greeting the user and tell them to start scanning for ${reference.profile?.name ?? 'the object'}. Keep it under 12 words.`,
      );
    } catch (err) {
      const error = err as { code?: string; message?: string; hint?: string };
      const reason = error?.message || 'The Gemini Live API rejected the session.';
      setupFallbackVoice(reason);
      pushToast({
        tone: 'info',
        title: 'Live voice not available',
        message: reason,
        hint: error?.hint ?? 'Push-to-talk voice and typed chat still work with the frames your camera sends.',
      });
    }
  }, [
    pushMessage,
    pushToast,
    reference.profile,
    settings.prefs.liveModel,
    settings.prefs.voiceEnabled,
    settings.prefs.voiceStyle,
    setupFallbackVoice,
    startLiveFrames,
    startMicStreaming,
  ]);

  /* ── session lifecycle ── */

  const sessionStatsTimer = useRef<number | null>(null);

  const startSession = useCallback(async () => {
    const key = getKey();
    if (!key) {
      pushToast({
        tone: 'error',
        title: 'API key required',
        message: 'Connect your Gemini API key to start a search.',
        hint: 'Settings → Gemini API key.',
      });
      setStatus('error');
      return;
    }
    if (!referencePayloadRef.current) {
      pushToast({ tone: 'warn', title: 'Reference photo required', message: 'Upload the object photo first.' });
      return;
    }
    if (!reference.profile) {
      await analyseWithKey(key);
    }

    setStatus('starting');
    const media = camera.stream ?? (await camera.start({ facing: 'environment' }));
    if (!media) {
      setStatus('error');
      setReference((prev) => ({ ...prev }));
      return;
    }

    const video = camera.videoRef.current;
    if (video) {
      await new Promise<void>((resolve) => {
        if (video.readyState >= 2 && video.videoWidth) return resolve();
        const done = () => resolve();
        video.addEventListener('loadeddata', done, { once: true });
        window.setTimeout(done, 4000);
      });
    }

    const engine = ensureEngine();
    engine.setProfile(reference.profile, anchorsRef.current);
    engine.reacquire();
    if (video) engine.start(video);
    statusRef.current = 'searching';
    setStatus('searching');
    setStats({ startedAt: Date.now(), durationMs: 0, locks: 0, losses: 0, modelCalls: 0, observations: 0 });
    pushMessage({
      role: 'system',
      tone: 'good',
      text: `Search started for ${reference.profile?.name ?? 'the target'}. ${
        reference.profile?.sceneGuidance ?? 'Move the camera slowly around the room.'
      }`,
    });

    if (sessionStatsTimer.current === null) {
      sessionStatsTimer.current = window.setInterval(() => {
        setStats((s) => (s.startedAt ? { ...s, durationMs: Date.now() - s.startedAt } : s));
      }, 1000);
    }

    if (settings.prefs.voiceEnabled) {
      void connectAgent();
    }
  }, [analyseWithKey, camera, connectAgent, ensureEngine, pushMessage, pushToast, reference.profile, settings.prefs.voiceEnabled]);

  const pauseSession = useCallback(() => {
    engineRef.current?.pause();
    liveRef.current?.setAudioEnabled(false);
    if (levelTimerRef.current !== null) {
      window.clearInterval(levelTimerRef.current);
      levelTimerRef.current = null;
    }
    micRef.current?.stop();
    micRef.current = null;
    setVoice((v) => ({ ...v, micStreaming: false, userLevel: 0 }));
    pttRef.current?.abort();
    playerRef.current?.stop();
    statusRef.current = 'paused';
    setStatus('paused');
    pushMessage({ role: 'system', text: 'Session paused. Camera stays on so you can resume instantly.' });
  }, [pushMessage]);

  const resumeSession = useCallback(() => {
    engineRef.current?.resume();
    engineRef.current?.reacquire();
    statusRef.current = 'searching';
    setStatus('searching');
    if (liveRef.current?.statusNow === 'ready' && settings.prefs.voiceEnabled) void startMicStreaming();
    pushMessage({ role: 'system', text: 'Search resumed — sweeping again.' });
  }, [pushMessage, settings.prefs.voiceEnabled, startMicStreaming]);

  const endSession = useCallback(() => {
    setStatus('ended');
    statusRef.current = 'ended';
    engineRef.current?.stop();
    stopLiveFrames();
    stopMic();
    playerRef.current?.stop();
    speakerRef.current?.cancel();
    pttRef.current?.abort();
    liveRef.current?.close();
    liveRef.current = null;
    camera.stop();
    if (sessionStatsTimer.current !== null) {
      window.clearInterval(sessionStatsTimer.current);
      sessionStatsTimer.current = null;
    }
    pushMessage({
      role: 'system',
      text: 'Session ended. Camera, microphone and the model session were released.',
    });
  }, [camera, pushMessage, stopLiveFrames, stopMic]);

  const restartSession = useCallback(() => {
    setStatus('setup');
    statusRef.current = 'setup';
    pushMessage({ role: 'system', text: 'Ready for a new search.' });
  }, [pushMessage]);

  const toggleMic = useCallback(async () => {
    if (liveRef.current?.statusNow === 'ready') {
      if (micRef.current) {
        stopMic();
        pushMessage({ role: 'system', text: 'Microphone muted.' });
      } else {
        await startMicStreaming();
      }
      return;
    }
    const ptt = pttRef.current;
    if (!ptt) {
      pushToast({
        tone: 'warn',
        title: 'Voice input unavailable',
        message: speechRecognitionSupported()
          ? 'Voice input is not ready yet.'
          : 'This browser has no speech recognition — type your message instead.',
      });
      return;
    }
    if (ptt.isListening) {
      ptt.stop();
    } else {
      ptt.start();
    }
  }, [pushMessage, pushToast, startMicStreaming, stopMic]);

  const ask = useCallback(
    async (text: string) => {
      const trimmed = text.trim();
      if (!trimmed) return;
      pushMessage({ role: 'user', text: trimmed });
      const live = liveRef.current;
      if (live?.statusNow === 'ready') {
        live.sendText(trimmed);
        return;
      }
      const key = getKey();
      if (!key) {
        pushToast({ tone: 'error', title: 'API key required', message: 'Connect your Gemini API key first.' });
        return;
      }
      const frame = camera.videoRef.current
        ? grabberRef.current.captureJpeg(camera.videoRef.current, 512, 0.6)
        : null;
      try {
        const instruction = instructionRef.current?.instruction ?? '';
        const history = messages
          .filter((m) => m.role === 'user' || m.role === 'assistant')
          .slice(-8)
          .map((m) => ({ role: m.role === 'user' ? ('user' as const) : ('model' as const), text: m.text }));
        const reply = await geminiApi.chat(key, settings.prefs.textModel, [...history, { role: 'user', text: trimmed }], {
          image: settings.prefs.voiceEnabled ? frame : null,
          system: instruction,
        });
        pushMessage({ role: 'assistant', text: reply.text, model: reply.model });
        if (settings.prefs.speakCues) {
          speakerRef.current?.speak(reply.text);
          lastSpeechAtRef.current = Date.now();
        }
      } catch (err) {
        const error = err as GeminiClientError;
        pushToast({ tone: 'error', title: 'Agent error', message: error.message, hint: error.hint });
      }
    },
    [camera.videoRef, messages, pushMessage, pushToast, settings.prefs.speakCues, settings.prefs.textModel, settings.prefs.voiceEnabled],
  );

  const askRef = useRef(ask);
  askRef.current = ask;

  const reacquire = useCallback(() => {
    engineRef.current?.reacquire();
    const hint = reference.profile?.sceneGuidance ?? 'Pan slowly across the room.';
    pushMessage({ role: 'guidance', text: hint });
    speak(hint);
  }, [pushMessage, reference.profile, speak]);

  /* ── effects: speaker/player setup, teardown ── */

  useEffect(() => {
    if (!playerRef.current) {
      const player = new AudioPlayer();
      player.onSpeakingChange = (speaking) => {
        setVoice((v) => ({ ...v, modelSpeaking: speaking }));
        if (!speaking) lastSpeechAtRef.current = Date.now();
      };
      playerRef.current = player;
    }
    if (!speakerRef.current) {
      const speaker = new Speaker();
      speaker.onSpeakingChange = (speaking) => {
        setVoice((v) => ({ ...v, modelSpeaking: speaking }));
        if (!speaking) lastSpeechAtRef.current = Date.now();
      };
      speakerRef.current = speaker;
    }
  }, []);

  useEffect(
    () => () => {
      engineRef.current?.stop();
      stopLiveFrames();
      stopMic();
      liveRef.current?.close();
      liveRef.current = null;
      void playerRef.current?.close();
      speakerRef.current?.cancel();
      pttRef.current?.abort();
      if (sessionStatsTimer.current !== null) window.clearInterval(sessionStatsTimer.current);
    },
    [stopLiveFrames, stopMic],
  );

  /* ── dev-only QA bridge ────────────────────────────────────────────────
   * Lets the browser test-suite inject a "model says the target is here"
   * observation, so box alignment can be verified on real viewports without
   * burning API quota. Never present in a production build.
   * ──────────────────────────────────────────────────────────────────────── */
  useEffect(() => {
    if (!import.meta.env.DEV) return;
    const bridge = {
      pushDetection: (box: BBox, confidence = 0.9, reason = 'qa bridge') =>
        engineRef.current?.pushExternal({ source: 'gemini-live', visible: true, confidence, reason, box }),
      markAbsent: (confidence = 0.1) =>
        engineRef.current?.pushExternal({ source: 'gemini-live', visible: false, confidence, reason: 'qa absent' }),
      state: () => ({
        state: statusRef.current,
        engine: engineRef.current?.snapshot() ?? null,
        video: camera.videoRef.current
          ? { width: camera.videoRef.current.videoWidth, height: camera.videoRef.current.videoHeight }
          : null,
      }),
      reacquire: () => engineRef.current?.reacquire(),
    };
    (window as unknown as { __fa_debug?: typeof bridge }).__fa_debug = bridge;
    return () => {
      delete (window as unknown as { __fa_debug?: typeof bridge }).__fa_debug;
    };
  }, [camera.videoRef]);

  const trackerState: TrackerState = snapshot.state;
  const statusLabel = useMemo(() => {
    switch (status) {
      case 'searching':
        return trackerState === 'locked' ? 'Object found' : trackerState === 'occluded' ? 'Temporarily lost' : 'Searching';
      case 'paused':
        return 'Paused';
      case 'ended':
        return 'Ended';
      case 'analysing':
        return 'Analysing reference';
      default:
        return 'Ready';
    }
  }, [status, trackerState]);

  return {
    camera,
    status,
    statusLabel,
    reference,
    snapshot,
    messages,
    observations,
    toasts,
    voice,
    stats,
    actions: {
      setReferenceFile,
      clearReference,
      reanalyse,
      startSession,
      pauseSession,
      resumeSession,
      endSession,
      restartSession,
      toggleMic,
      ask,
      reacquire,
      dismissToast,
      pushToast,
    },
  };
}

export type SearchSessionApi = ReturnType<typeof useSearchSession>;
