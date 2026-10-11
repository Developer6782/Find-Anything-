import { useEffect, useState } from 'react';
import {
  BadgeCheck,
  CheckCircle2,
  Eye,
  EyeOff,
  KeyRound,
  Loader2,
  Lock,
  ShieldCheck,
  Trash2,
  Wifi,
  WifiOff,
} from 'lucide-react';
import { type SettingsApi, type VoiceStyle } from '../../state/useSettings';
import { Button, Field, inputClass, Modal, Pill, cx } from '../ui/primitives';
import { DEFAULT_LIVE_MODEL, LIVE_MODEL_CANDIDATES, TEXT_MODELS } from '../../lib/config';
import { geminiApi } from '../../lib/gemini/client';
import { getKey } from '../../lib/security/keyVault';
import type { StorageMode } from '../../lib/security/keyVault';

export interface SettingsModalProps {
  open: boolean;
  onClose: () => void;
  settings: SettingsApi;
  /** Reference image (if any) used by the capability self-test. */
  capabilityImage?: { data: string; mimeType: string } | null;
}

const MODE_COPY: Record<StorageMode, { title: string; body: string }> = {
  session: {
    title: 'This tab only (recommended)',
    body: 'Kept in sessionStorage as plain text; cleared when the tab closes. Nothing is written to disk.',
  },
  passphrase: {
    title: 'Encrypted on this device',
    body: 'AES-GCM encrypted with a passphrase you choose (PBKDF2, 210k iterations) before touching localStorage.',
  },
  memory: {
    title: 'Never stored',
    body: 'Lives only in this page’s memory — you re-enter it after every reload. Most private.',
  },
};

export function SettingsModal({ open, onClose, settings, capabilityImage }: SettingsModalProps) {
  const [apiKey, setApiKey] = useState('');
  const [passphrase, setPassphrase] = useState('');
  const [mode, setMode] = useState<StorageMode>(settings.prefs.storageMode);
  const [showKey, setShowKey] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<{ ok: boolean; message: string; models?: string[] } | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setError(null);
      setApiKey('');
      setPassphrase('');
      setTestResult(null);
      setMode(settings.prefs.storageMode);
    }
  }, [open, settings.prefs.storageMode]);

  const connect = async () => {
    setBusy('connect');
    setError(null);
    try {
      await settings.connectKey(apiKey, mode, passphrase);
      setApiKey('');
      setPassphrase('');
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const runKeyTest = async () => {
    const key = getKey();
    if (!key) {
      setError('Connect a key first.');
      return;
    }
    setBusy('test');
    setTestResult(null);
    try {
      const result = await geminiApi.models(key);
      const available = result.recommended.length
        ? result.recommended
        : TEXT_MODELS.map((m) => m.id).filter((id) => result.models.some((m) => m.id === id));
      setTestResult({
        ok: available.length > 0,
        message: `${result.models.length} models visible to this key. ${available.length ? `Working candidates: ${available.join(', ')}` : 'None of the curated models are available.'}`,
        models: available,
      });
      if (available.length && !available.includes(settings.prefs.textModel)) {
        settings.update({ textModel: available[0] });
      }
    } catch (err) {
      setTestResult({ ok: false, message: (err as Error).message });
    } finally {
      setBusy(null);
    }
  };

  const runCapabilityTest = async () => {
    const key = getKey();
    if (!key) {
      setError('Connect a key first.');
      return;
    }
    setBusy('capability');
    try {
      const result = await geminiApi.capability(
        key,
        settings.prefs.textModel,
        capabilityImage ?? undefined,
      );
      setTestResult({ ok: result.ok, message: `${result.capability}: ${result.note || (result.ok ? 'works' : 'not available')}` });
    } catch (err) {
      setTestResult({ ok: false, message: (err as Error).message });
    } finally {
      setBusy(null);
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Settings"
      description="Bring your own Gemini API key. Nothing is hardcoded, nothing is shared with other users."
      size="lg"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Done
          </Button>
        </>
      }
    >
      {/* ── key status ── */}
      <div className="glass-soft flex flex-wrap items-center justify-between gap-3 p-3">
        <div className="flex items-center gap-2">
          <ShieldCheck className={cx('h-4 w-4', settings.hasKey ? 'text-emerald-300' : 'text-amber-300')} />
          <div>
            <p className="text-sm text-slate-200">
              {settings.hasKey ? `Key connected · ${settings.keyHint ?? ''}` : 'No key connected'}
            </p>
            <p className="text-[11px] text-slate-400">
              {settings.keyStatus === 'locked'
                ? 'Stored encrypted — unlock with your passphrase.'
                : settings.keyMeta
                  ? MODE_COPY[settings.keyMeta.mode].title
                  : 'Add a key to enable analysis, detection and the voice agent.'}
            </p>
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          {settings.keyStatus === 'locked' ? (
            <>
              <input
                type="password"
                className={cx(inputClass, 'w-44')}
                placeholder="Passphrase"
                value={passphrase}
                onChange={(event) => setPassphrase(event.target.value)}
                aria-label="Passphrase to unlock stored key"
              />
              <Button
                size="sm"
                variant="primary"
                onClick={async () => {
                  const ok = await settings.unlock(passphrase);
                  if (ok) setPassphrase('');
                }}
              >
                <Lock className="h-3.5 w-3.5" /> Unlock
              </Button>
            </>
          ) : null}
          {settings.hasKey ? (
            <Button size="sm" onClick={settings.forgetKey}>
              <Trash2 className="h-3.5 w-3.5" /> Forget key
            </Button>
          ) : null}
        </div>
      </div>
      {settings.keyError ? <p className="text-xs text-rose-300">{settings.keyError}</p> : null}

      {/* ── add key ── */}
      <div className="space-y-3">
        <Field
          label="Gemini API key"
          htmlFor="api-key"
          hint="Create one at aistudio.google.com/apikey. It is sent only to your own app server, which forwards it to Google — never logged or stored server-side."
        >
          <div className="flex gap-2">
            <div className="relative flex-1">
              <input
                id="api-key"
                type={showKey ? 'text' : 'password'}
                className={cx(inputClass, 'pr-10 font-mono')}
                placeholder="AIza…"
                autoComplete="off"
                spellCheck={false}
                value={apiKey}
                onChange={(event) => setApiKey(event.target.value)}
              />
              <button
                type="button"
                onClick={() => setShowKey((v) => !v)}
                className="focus-ring absolute right-2 top-1/2 -translate-y-1/2 rounded p-1 text-slate-400 hover:text-slate-200"
                aria-label={showKey ? 'Hide API key' : 'Show API key'}
              >
                {showKey ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
              </button>
            </div>
            <Button variant="primary" onClick={() => void connect()} disabled={!apiKey.trim() || busy === 'connect'}>
              {busy === 'connect' ? <Loader2 className="h-4 w-4 animate-spin" /> : <KeyRound className="h-4 w-4" />}
              Connect
            </Button>
          </div>
        </Field>

        <fieldset className="space-y-2">
          <legend className="label">How should the key be stored?</legend>
          <div className="grid gap-2 sm:grid-cols-3">
            {(Object.keys(MODE_COPY) as StorageMode[]).map((option) => (
              <button
                key={option}
                type="button"
                onClick={() => setMode(option)}
                aria-pressed={mode === option}
                className={cx(
                  'focus-ring rounded-xl border p-3 text-left transition-colors',
                  mode === option
                    ? 'border-cyan-300/50 bg-cyan-400/10'
                    : 'border-white/10 bg-white/[0.03] hover:border-white/20',
                )}
              >
                <p className="text-xs font-semibold text-slate-100">{MODE_COPY[option].title}</p>
                <p className="mt-1 text-[11px] leading-relaxed text-slate-400">{MODE_COPY[option].body}</p>
              </button>
            ))}
          </div>
        </fieldset>

        {mode === 'passphrase' ? (
          <Field label="Passphrase" htmlFor="passphrase" hint="At least 8 characters. You will need it once per page load.">
            <input
              id="passphrase"
              type="password"
              className={inputClass}
              value={passphrase}
              onChange={(event) => setPassphrase(event.target.value)}
              autoComplete="new-password"
            />
          </Field>
        ) : null}

        {error ? <p className="text-xs text-rose-300">{error}</p> : null}

        <div className="flex flex-wrap gap-2">
          <Button size="sm" onClick={() => void runKeyTest()} disabled={busy === 'test'}>
            {busy === 'test' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Wifi className="h-3.5 w-3.5" />}
            Verify key & list models
          </Button>
          <Button size="sm" onClick={() => void runCapabilityTest()} disabled={busy === 'capability'}>
            {busy === 'capability' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <BadgeCheck className="h-3.5 w-3.5" />}
            Test vision capability
          </Button>
          {settings.serverKeyAvailable ? (
            <Button size="sm" onClick={() => void settings.useServerKey()}>
              Use server key (demo)
            </Button>
          ) : null}
        </div>

        {testResult ? (
          <div
            className={cx(
              'flex items-start gap-2 rounded-xl border px-3 py-2 text-xs',
              testResult.ok
                ? 'border-emerald-400/30 bg-emerald-400/[0.08] text-emerald-100'
                : 'border-rose-400/30 bg-rose-400/[0.08] text-rose-100',
            )}
            role="status"
          >
            {testResult.ok ? <CheckCircle2 className="mt-0.5 h-3.5 w-3.5" /> : <WifiOff className="mt-0.5 h-3.5 w-3.5" />}
            <span>{testResult.message}</span>
          </div>
        ) : null}
      </div>

      <div className="hairline h-px" />

      {/* ── models ── */}
      <div className="grid gap-3 sm:grid-cols-2">
        <Field
          label="Vision / detection model"
          htmlFor="text-model"
          hint="Flash-class models are the ones that work on the free tier and support image input."
        >
          <select
            id="text-model"
            className={inputClass}
            value={settings.prefs.textModel}
            onChange={(event) => settings.update({ textModel: event.target.value })}
          >
            {TEXT_MODELS.map((model) => (
              <option key={model.id} value={model.id}>
                {model.label} — {model.note}
              </option>
            ))}
            {TEXT_MODELS.every((m) => m.id !== settings.prefs.textModel) ? (
              <option value={settings.prefs.textModel}>{settings.prefs.textModel} (custom)</option>
            ) : null}
          </select>
        </Field>

        <Field
          label="Live voice model"
          htmlFor="live-model"
          hint="Tried first when the voice session starts; the app probes for real and falls back to push-to-talk if your key cannot use it."
        >
          <input
            id="live-model"
            className={cx(inputClass, 'font-mono text-xs')}
            list="live-models"
            value={settings.prefs.liveModel}
            onChange={(event) => settings.update({ liveModel: event.target.value })}
          />
          <datalist id="live-models">
            {Array.from(new Set([DEFAULT_LIVE_MODEL, ...LIVE_MODEL_CANDIDATES])).map((id) => (
              <option key={id} value={id} />
            ))}
          </datalist>
        </Field>
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Voice" htmlFor="voice-enabled">
          <div className="flex items-center gap-3">
            <label className="flex items-center gap-2 text-sm text-slate-200">
              <input
                id="voice-enabled"
                type="checkbox"
                className="focus-ring h-4 w-4 rounded border-white/20 bg-void-800"
                checked={settings.prefs.voiceEnabled}
                onChange={(event) => settings.update({ voiceEnabled: event.target.checked })}
              />
              Voice guidance
            </label>
            <select
              className={cx(inputClass, 'w-auto')}
              value={settings.prefs.voiceStyle}
              onChange={(event) => settings.update({ voiceStyle: event.target.value as VoiceStyle })}
              aria-label="Voice style"
            >
              <option value="calm">Calm</option>
              <option value="energetic">Energetic</option>
              <option value="minimal">Minimal</option>
            </select>
          </div>
        </Field>

        <Field label="Detection rate" htmlFor="detect-fps" hint="Model localisations per second. Lower = cheaper and gentler on quota.">
          <input
            id="detect-fps"
            type="range"
            min={0.4}
            max={3}
            step={0.2}
            value={settings.prefs.detectFps}
            onChange={(event) => settings.update({ detectFps: Number(event.target.value) })}
            className="focus-ring w-full accent-cyan-400"
          />
          <p className="font-mono text-[11px] text-slate-400">{settings.prefs.detectFps.toFixed(1)} / s</p>
        </Field>
      </div>

      <div className="flex flex-wrap items-center gap-4">
        <label className="flex items-center gap-2 text-sm text-slate-200">
          <input
            type="checkbox"
            className="focus-ring h-4 w-4 rounded border-white/20 bg-void-800"
            checked={settings.prefs.verifyEnabled}
            onChange={(event) => settings.update({ verifyEnabled: event.target.checked })}
          />
          Cross-check candidates against the reference photo
        </label>
        <label className="flex items-center gap-2 text-sm text-slate-200">
          <input
            type="checkbox"
            className="focus-ring h-4 w-4 rounded border-white/20 bg-void-800"
            checked={settings.prefs.speakCues}
            onChange={(event) => settings.update({ speakCues: event.target.checked })}
          />
          Spoken guidance in fallback mode
        </label>
      </div>

      <div className="hairline h-px" />

      <div className="space-y-2 text-[11px] leading-relaxed text-slate-400">
        <p className="flex items-center gap-2">
          <Pill tone="violet">privacy</Pill> The key is used only for your own requests. The server keeps it in memory for
          the lifetime of a request/socket and never writes it to disk or logs.
        </p>
        <p className="flex items-center gap-2">
          <Pill tone="cyan">cost</Pill> Video frames are downscaled (640 px detection, 512 px live) and rate-limited.
          The local ZNCC tracker runs at 10 fps on-device and costs nothing.
        </p>
      </div>
    </Modal>
  );
}
