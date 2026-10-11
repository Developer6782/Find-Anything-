/** Central place for tunables, storage keys and model lists. */

export const APP_NAME = 'Find Anything';

export const STORAGE = {
  /** Non-secret preferences (model choice, voice style, encrypted key blob). */
  prefs: 'fa.prefs.v1',
  keyMeta: 'fa.key.meta.v1',
  keySecret: 'fa.key.secret.v1',
  sessionKey: 'fa.key.session.v1',
} as const;

/**
 * Curated text/vision models. Pro / brand-new flagship models were reported to
 * fail on the free tier, so the product deliberately defaults to Flash-class
 * models. Users can still type any model id they verified in "Test capabilities".
 */
export const TEXT_MODELS: { id: string; label: string; note: string; tier: 'recommended' | 'cheap' | 'experimental' }[] = [
  { id: 'gemini-flash-latest', label: 'Gemini Flash (latest)', note: 'Best default — fast, multimodal', tier: 'recommended' },
  { id: 'gemini-2.5-flash', label: 'Gemini 2.5 Flash', note: 'Stable multimodal workhorse', tier: 'recommended' },
  { id: 'gemini-2.5-flash-lite', label: 'Gemini 2.5 Flash-Lite', note: 'Cheapest, highest free quota', tier: 'cheap' },
  { id: 'gemini-flash-lite-latest', label: 'Gemini Flash-Lite (latest)', note: 'Cheapest alias', tier: 'cheap' },
];

export const DEFAULT_TEXT_MODEL = TEXT_MODELS[0].id;
export const DEFAULT_LIVE_MODEL = 'gemini-2.5-flash-live';

/**
 * Live API (voice + streaming video) candidate ids, tried in order when the user
 * enables voice. Each is verified by an actual handshake — nothing is assumed.
 */
export const LIVE_MODEL_CANDIDATES = [
  'gemini-2.5-flash-live',
  'gemini-2.5-flash-native-audio-latest',
  'gemini-live-2.5-flash-preview',
  'gemini-2.0-flash-live-001',
];

export const DETECTION = {
  /** Local tracker cadence (cheap, per-frame). */
  localFps: 10,
  /** How many model localisations per second (cost-controlled). */
  detectFps: 1.2,
  /** Minimum model confidence to adopt a box. */
  acquireConfidence: 0.55,
  /** Confidence below which a claimed presence is treated as "possible". */
  lowConfidence: 0.45,
  /** No signal for this long → "temporarily lost" (dimmed box). */
  occludedAfterMs: 900,
  /** No signal for this long → "lost" (box hidden, agent re-guides). */
  lostAfterMs: 3500,
  /** Frames are downscaled to this width before being sent to the model. */
  frameWidth: 640,
  /** Separate, harsher downscale for the local matcher. */
  matcherWidth: 192,
  /** Re-verify a locked target at most this often. */
  verifyEveryMs: 7000,
  /** Confidence decay half-life while the target is unseen. */
  decayHalfLifeMs: 2600,
} as const;

export const LIVE = {
  /** Frames are pushed into the Live session at most this often. */
  frameIntervalMs: 1200,
  frameWidth: 512,
  /** Keep frames out of the conversation while the user/model is talking. */
  avoidWhileSpeakingMs: 900,
  maxSessionMinutes: 30,
} as const;

export const CONSENT_COPY = {
  storageOptions:
    'Your API key stays in this browser. By default it is encrypted with a passphrase you choose (AES-GCM via WebCrypto) before being written to localStorage.',
};
