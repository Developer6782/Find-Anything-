import { Camera, CameraOff, Crosshair, Mic, MicOff, Pause, Play, Square } from 'lucide-react';
import { cx } from '../ui/primitives';
import type { SessionStatus, VoiceState } from '../../state/useSearchSession';
import type { CameraStatus } from '../../state/useCamera';

export interface ToolbarProps {
  status: SessionStatus;
  cameraStatus: CameraStatus;
  voice: VoiceState;
  onToggleMic: () => void;
  onToggleCamera: () => void;
  onPause: () => void;
  onResume: () => void;
  onRescan: () => void;
  onEnd: () => void;
  disabled?: boolean;
}

function ToolButton({
  active,
  label,
  hint,
  tone = 'default',
  onClick,
  disabled,
  children,
}: {
  active?: boolean;
  label: string;
  hint?: string;
  tone?: 'default' | 'danger' | 'primary';
  onClick: () => void;
  disabled?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-pressed={active}
      aria-label={hint ? `${label} — ${hint}` : label}
      title={hint ? `${label} (${hint})` : label}
      className={cx(
        'focus-ring group relative flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl border transition-all duration-200 sm:h-13 sm:w-14',
        active
          ? 'border-cyan-300/60 bg-cyan-400/15 text-cyan-100 shadow-glow'
          : 'border-white/10 bg-white/[0.04] text-slate-300 hover:border-cyan-300/40 hover:bg-cyan-400/10 hover:text-white',
        tone === 'danger' && 'hover:border-rose-400/60 hover:bg-rose-500/15 hover:text-rose-100',
        disabled && 'cursor-not-allowed opacity-40',
      )}
    >
      {children}
      <span className="pointer-events-none absolute -top-9 left-1/2 -translate-x-1/2 whitespace-nowrap rounded-lg border border-white/10 bg-void-800/95 px-2 py-1 text-[10px] text-slate-200 opacity-0 transition-opacity group-hover:opacity-100">
        {label}
        {hint ? <span className="ml-1 font-mono text-slate-400">{hint}</span> : null}
      </span>
    </button>
  );
}

export function Toolbar({
  status,
  cameraStatus,
  voice,
  onToggleMic,
  onToggleCamera,
  onPause,
  onResume,
  onRescan,
  onEnd,
  disabled,
}: ToolbarProps) {
  const searching = status === 'searching';
  const paused = status === 'paused';
  const micOn = voice.micStreaming || voice.pttListening;

  return (
    <div className="glass mt-3 flex items-center justify-between gap-3 overflow-x-auto px-3 py-3 sm:justify-center sm:gap-4">
      <ToolButton
        label={micOn ? 'Mute microphone' : 'Talk to the agent'}
        hint="M"
        active={micOn}
        onClick={onToggleMic}
        disabled={disabled || status === 'ended' || status === 'setup'}
      >
        <span className="relative flex items-center justify-center">
          {micOn ? <Mic className="h-5 w-5" /> : <MicOff className="h-5 w-5" />}
          {micOn ? (
            <span
              className="absolute -inset-2 rounded-full border border-cyan-300/50"
              style={{ transform: `scale(${1 + voice.userLevel * 0.7})`, opacity: 0.25 + voice.userLevel * 0.6 }}
              aria-hidden="true"
            />
          ) : null}
        </span>
      </ToolButton>

      <ToolButton
        label={cameraStatus === 'live' ? 'Turn camera off' : 'Turn camera on'}
        hint="C"
        active={cameraStatus === 'live'}
        onClick={onToggleCamera}
        disabled={disabled || status === 'ended'}
      >
        {cameraStatus === 'live' ? <Camera className="h-5 w-5" /> : <CameraOff className="h-5 w-5" />}
      </ToolButton>

      <ToolButton label="Re-scan around the room" hint="R" onClick={onRescan} disabled={disabled || !searching}>
        <Crosshair className="h-5 w-5" />
      </ToolButton>

      {paused ? (
        <ToolButton label="Resume search" hint="Space" active onClick={onResume} disabled={disabled}>
          <Play className="h-5 w-5" />
        </ToolButton>
      ) : (
        <ToolButton label="Pause search" hint="Space" onClick={onPause} disabled={disabled || !searching}>
          <Pause className="h-5 w-5" />
        </ToolButton>
      )}

      <ToolButton label="End session" tone="danger" onClick={onEnd} disabled={disabled || status === 'ended'}>
        <Square className="h-5 w-5" />
      </ToolButton>
    </div>
  );
}
