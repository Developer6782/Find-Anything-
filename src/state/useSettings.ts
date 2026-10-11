import { useCallback, useEffect, useMemo, useState } from 'react';
import { DEFAULT_LIVE_MODEL, DEFAULT_TEXT_MODEL, STORAGE, TEXT_MODELS } from '../lib/config';
import { geminiApi } from '../lib/gemini/client';
import {
  type KeyMeta,
  type StorageMode,
  WrongPassphraseError,
  clearStoredKey,
  getKey,
  loadKey,
  readMeta,
  saveKey,
  storedKeyExists,
} from '../lib/security/keyVault';

export type VoiceStyle = 'calm' | 'energetic' | 'minimal';

export interface Preferences {
  textModel: string;
  liveModel: string;
  voiceEnabled: boolean;
  voiceStyle: VoiceStyle;
  storageMode: StorageMode;
  verifyEnabled: boolean;
  speakCues: boolean;
  detectFps: number;
}

const DEFAULT_PREFS: Preferences = {
  textModel: DEFAULT_TEXT_MODEL,
  liveModel: DEFAULT_LIVE_MODEL,
  voiceEnabled: true,
  voiceStyle: 'calm',
  storageMode: 'session',
  verifyEnabled: true,
  speakCues: true,
  detectFps: 1.2,
};

function readPrefs(): Preferences {
  try {
    const raw = localStorage.getItem(STORAGE.prefs);
    if (!raw) return DEFAULT_PREFS;
    const parsed = JSON.parse(raw) as Partial<Preferences>;
    return { ...DEFAULT_PREFS, ...parsed };
  } catch {
    return DEFAULT_PREFS;
  }
}

export type KeyStatus = 'none' | 'locked' | 'unlocked';

export interface SettingsApi {
  prefs: Preferences;
  models: typeof TEXT_MODELS;
  keyStatus: KeyStatus;
  keyMeta: KeyMeta | null;
  keyHint: string | null;
  keyError: string | null;
  serverKeyAvailable: boolean;
  update: (patch: Partial<Preferences>) => void;
  /** Stores the key in memory + persists per the chosen mode. */
  connectKey: (apiKey: string, mode: StorageMode, passphrase?: string) => Promise<void>;
  /** Restores a passphrase-protected key from storage. */
  unlock: (passphrase: string) => Promise<boolean>;
  forgetKey: () => void;
  useServerKey: () => Promise<void>;
  hasKey: boolean;
}

/**
 * Non-secret preferences + API key lifecycle. The raw key never enters React
 * state — only `hasKey` does — so it cannot leak through props or devtools.
 */
export function useSettings(): SettingsApi {
  const [prefs, setPrefs] = useState<Preferences>(() => readPrefs());
  const [keyStatus, setKeyStatus] = useState<KeyStatus>('none');
  const [keyMeta, setKeyMeta] = useState<KeyMeta | null>(() => readMeta());
  const [keyError, setKeyError] = useState<string | null>(null);
  const [serverKeyAvailable, setServerKeyAvailable] = useState(false);
  const [hasKey, setHasKey] = useState(false);

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE.prefs, JSON.stringify(prefs));
    } catch {
      /* private mode: preferences simply do not persist */
    }
  }, [prefs]);

  // Detect what is restorable on load (never decrypt automatically).
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const meta = readMeta();
      if (!meta) return;
      if (meta.mode === 'session') {
        const { key } = await loadKey();
        if (cancelled) return;
        if (key) {
          setHasKey(true);
          setKeyStatus('unlocked');
        }
      } else if (meta.mode === 'passphrase' && storedKeyExists()) {
        setKeyStatus('locked');
      }
    })();
    void fetch('/api/health')
      .then((r) => r.json())
      .then((h) => {
        if (!cancelled) setServerKeyAvailable(Boolean(h?.serverKeyAvailable));
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  const update = useCallback((patch: Partial<Preferences>) => {
    setPrefs((prev) => ({ ...prev, ...patch }));
  }, []);

  const connectKey = useCallback(
    async (apiKey: string, mode: StorageMode, passphrase?: string) => {
      setKeyError(null);
      const meta = await saveKey(apiKey, { mode, passphrase, model: prefs.textModel });
      setKeyMeta(meta);
      setHasKey(true);
      setKeyStatus('unlocked');
      setPrefs((prev) => ({ ...prev, storageMode: mode }));
    },
    [prefs.textModel],
  );

  const unlock = useCallback(async (passphrase: string) => {
    try {
      const { key } = await loadKey(passphrase);
      if (!key) {
        setKeyError('No stored key was found.');
        return false;
      }
      setKeyMeta(readMeta());
      setHasKey(true);
      setKeyStatus('unlocked');
      setKeyError(null);
      return true;
    } catch (err) {
      setKeyError(err instanceof WrongPassphraseError ? 'Wrong passphrase — try again.' : (err as Error).message);
      return false;
    }
  }, []);

  const forgetKey = useCallback(() => {
    clearStoredKey();
    setHasKey(false);
    setKeyStatus('none');
    setKeyMeta(null);
    setKeyError(null);
  }, []);

  const useServerKey = useCallback(async () => {
    try {
      const { apiKey } = await geminiApi.serverKey();
      await connectKey(apiKey, 'memory');
    } catch (err) {
      setKeyError((err as Error).message);
    }
  }, [connectKey]);

  const keyHint = useMemo(() => {
    const meta = keyMeta;
    if (meta?.hint) return meta.hint;
    return null;
  }, [keyMeta]);

  useEffect(() => {
    if (getKey()) setHasKey(true);
  }, [keyStatus]);

  return {
    prefs,
    models: TEXT_MODELS,
    keyStatus,
    keyMeta,
    keyHint,
    keyError,
    serverKeyAvailable,
    update,
    connectKey,
    unlock,
    forgetKey,
    useServerKey,
    hasKey,
  };
}
