import { useCallback, useEffect, useState } from 'react';
import { ChevronLeft, Radio, Settings2, Sparkles } from 'lucide-react';
import type { SearchSessionApi } from '../../state/useSearchSession';
import type { SettingsApi } from '../../state/useSettings';
import { ReferencePanel } from './ReferencePanel';
import { CameraStage } from './CameraStage';
import { AssistantPanel } from './AssistantPanel';
import { Toolbar } from './Toolbar';
import { SessionSummary } from './SessionSummary';
import { Button, cx, Panel, Pill } from '../ui/primitives';
import { clock } from '../../lib/format';

export interface DashboardProps {
  session: SearchSessionApi;
  settings: SettingsApi;
  onOpenSettings: () => void;
  onExit: () => void;
}

type MobileTab = 'reference' | 'camera' | 'agent';

export function Dashboard({ session, settings, onOpenSettings, onExit }: DashboardProps) {
  const { camera, status, reference, snapshot, messages, observations, voice, stats, actions, statusLabel } = session;
  const [tab, setTab] = useState<MobileTab>('reference');
  const [cameraOn, setCameraOn] = useState(true);

  const sessionActive = status === 'searching' || status === 'paused';

  const toggleCamera = useCallback(async () => {
    if (camera.status === 'live') {
      if (status === 'searching') actions.pauseSession();
      camera.stop();
      setCameraOn(false);
    } else {
      await camera.start({ facing: camera.facing });
      setCameraOn(true);
    }
  }, [actions, camera, status]);

  /* Keyboard shortcuts (desktop power-user path). */
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target && ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName)) return;
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      switch (event.key.toLowerCase()) {
        case ' ':
          if (status === 'searching') {
            event.preventDefault();
            actions.pauseSession();
          } else if (status === 'paused') {
            event.preventDefault();
            actions.resumeSession();
          }
          break;
        case 'm':
          void actions.toggleMic();
          break;
        case 'c':
          void toggleCamera();
          break;
        case 'r':
          actions.reacquire();
          break;
        default:
          break;
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [actions, status, toggleCamera]);

  const startLabel = reference.profile ? 'Start visual search' : 'Upload a reference photo first';

  return (
    <div className="mx-auto flex min-h-screen w-full max-w-[1680px] flex-col gap-4 px-3 py-4 sm:px-5">
      {/* ── top bar ── */}
      <header className="glass flex flex-wrap items-center justify-between gap-3 px-4 py-3">
        <div className="flex items-center gap-3">
          <Button variant="icon" onClick={onExit} aria-label="Back to landing page" className="h-9 w-9">
            <ChevronLeft className="h-4 w-4" />
          </Button>
          <div className="flex items-center gap-2">
            <span className="relative flex h-8 w-8 items-center justify-center rounded-xl border border-cyan-300/40 bg-cyan-400/10">
              <Sparkles className="h-4 w-4 text-cyan-200" />
            </span>
            <div className="leading-tight">
              <p className="text-sm font-semibold text-white">Find Anything</p>
              <p className="text-[11px] text-slate-400">visual search agent</p>
            </div>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <Pill tone={snapshot.state === 'locked' ? 'good' : snapshot.state === 'lost' || snapshot.state === 'occluded' ? 'warn' : 'cyan'}>
            <Radio className="h-3 w-3" />
            {statusLabel}
          </Pill>
          {reference.profile ? <Pill tone="violet">target: {reference.profile.name}</Pill> : null}
          {stats.startedAt ? <Pill tone="neutral" className="font-mono">{clock(stats.durationMs)}</Pill> : null}
        </div>

        <div className="flex items-center gap-2">
          <Button size="sm" onClick={onOpenSettings}>
            <Settings2 className="h-3.5 w-3.5" />
            {settings.hasKey ? `Key ${settings.keyHint ?? 'connected'}` : 'Connect API key'}
          </Button>
        </div>
      </header>

      {/* ── desktop grid ── */}
      <div className="hidden flex-1 items-start gap-4 lg:grid lg:grid-cols-[20rem_minmax(0,1fr)_23rem]">
        <div className="space-y-4">
          <ReferencePanel
            reference={reference}
            disabled={status === 'searching'}
            onChoose={(file) => void actions.setReferenceFile(file)}
            onRemove={actions.clearReference}
            onReanalyse={() => void actions.reanalyse()}
          />
          <Panel className="space-y-3">
            <p className="label">Search session</p>
            {!sessionActive ? (
              <Button
                variant="primary"
                onClick={() => void actions.startSession()}
                disabled={!reference.profile || status === 'starting' || !settings.hasKey}
                className="w-full"
              >
                {status === 'starting' ? 'Opening camera…' : startLabel}
              </Button>
            ) : (
              <div className="grid grid-cols-2 gap-2">
                {status === 'paused' ? (
                  <Button variant="primary" onClick={actions.resumeSession}>
                    Resume
                  </Button>
                ) : (
                  <Button onClick={actions.pauseSession}>Pause</Button>
                )}
                <Button
                  onClick={actions.endSession}
                  className="hover:border-rose-400/60 hover:bg-rose-500/10 hover:text-rose-100"
                >
                  End
                </Button>
              </div>
            )}
            {!settings.hasKey ? (
              <p className="text-xs text-amber-200">
                Connect your Gemini API key in settings — the key stays in this browser.
              </p>
            ) : null}
            <ul className="space-y-1 text-[11px] text-slate-500">
              <li>Shortcuts: M mic · C camera · R re-scan · Space pause</li>
              <li>Frames: local matcher 10 fps · model 1.2 fps (cost-aware)</li>
            </ul>
          </Panel>
          {status === 'ended' ? (
            <SessionSummary
              stats={stats}
              reference={reference}
              messages={messages}
              observations={observations}
              voiceModel={voice.liveModel}
              onRestart={actions.restartSession}
            />
          ) : null}
        </div>

        <div className="min-w-0">
          <CameraStage
            camera={camera}
            snapshot={snapshot}
            reference={reference}
            sessionActive={sessionActive}
            mirrored={camera.facing === 'user'}
          />
          <Toolbar
            status={status}
            cameraStatus={camera.status}
            voice={voice}
            onToggleMic={() => void actions.toggleMic()}
            onToggleCamera={() => void toggleCamera()}
            onPause={actions.pauseSession}
            onResume={actions.resumeSession}
            onRescan={actions.reacquire}
            onEnd={actions.endSession}
            disabled={!settings.hasKey}
          />
        </div>

        <div className="min-h-[40rem]">
          <AssistantPanel
            messages={messages}
            observations={observations}
            snapshot={snapshot}
            voice={voice}
            status={status}
            onAsk={(text) => void actions.ask(text)}
          />
        </div>
      </div>

      {/* ── mobile / tablet: stacked panels + tabs + persistent toolbar ── */}
      <div className="flex flex-1 flex-col gap-3 lg:hidden">
        <div className="glass flex items-center gap-1 p-1" role="tablist" aria-label="Panels">
          {(['reference', 'camera', 'agent'] as MobileTab[]).map((item) => (
            <button
              key={item}
              role="tab"
              aria-selected={tab === item}
              onClick={() => setTab(item)}
              className={cx(
                'focus-ring flex-1 rounded-xl px-3 py-2 text-xs font-medium capitalize transition-colors',
                tab === item ? 'bg-cyan-400/15 text-cyan-100' : 'text-slate-400 hover:text-slate-200',
              )}
            >
              {item}
            </button>
          ))}
        </div>

        {/* Panels stay mounted (they are only hidden) so the camera keeps
            delivering frames and the engine never loses its video element. */}
        <div className={cx('space-y-3', tab !== 'reference' && 'hidden')}>
          <ReferencePanel
            reference={reference}
            disabled={status === 'searching'}
            onChoose={(file) => void actions.setReferenceFile(file)}
            onRemove={actions.clearReference}
            onReanalyse={() => void actions.reanalyse()}
          />
          {!sessionActive ? (
            <Button
              variant="primary"
              className="w-full"
              onClick={() => void actions.startSession()}
              disabled={!reference.profile || !settings.hasKey || status === 'starting'}
            >
              {status === 'starting' ? 'Opening camera…' : startLabel}
            </Button>
          ) : null}
        </div>

        <div className={cx(tab !== 'camera' && 'hidden')}>
          <CameraStage
            camera={camera}
            snapshot={snapshot}
            reference={reference}
            sessionActive={sessionActive}
            mirrored={camera.facing === 'user'}
          />
          {cameraOn && camera.status !== 'live' && status !== 'ended' ? (
            <p className="mt-2 text-center text-xs text-slate-500">Camera off — press the camera button to reopen it.</p>
          ) : null}
        </div>

        <div className={cx(tab !== 'agent' && 'hidden')}>
          <AssistantPanel
            messages={messages}
            observations={observations}
            snapshot={snapshot}
            voice={voice}
            status={status}
            onAsk={(text) => void actions.ask(text)}
          />
        </div>

        {status === 'ended' ? (
          <SessionSummary
            stats={stats}
            reference={reference}
            messages={messages}
            observations={observations}
            voiceModel={voice.liveModel}
            onRestart={actions.restartSession}
          />
        ) : null}

        {/* Persistent bottom toolbar: controls must be reachable from every tab. */}
        <div className="sticky bottom-2 z-20">
          <Toolbar
            status={status}
            cameraStatus={camera.status}
            voice={voice}
            onToggleMic={() => void actions.toggleMic()}
            onToggleCamera={() => void toggleCamera()}
            onPause={actions.pauseSession}
            onResume={actions.resumeSession}
            onRescan={actions.reacquire}
            onEnd={actions.endSession}
            disabled={!settings.hasKey}
          />
        </div>
      </div>

      {/* ── toasts ── */}
      <div className="pointer-events-none fixed bottom-4 right-4 z-40 flex w-[min(22rem,calc(100vw-2rem))] flex-col gap-2">
        {session.toasts.map((toast) => (
          <div
            key={toast.id}
            className={cx(
              'glass pointer-events-auto animate-rise-in space-y-1 border-l-2 px-4 py-3',
              toast.tone === 'error'
                ? 'border-l-rose-400'
                : toast.tone === 'warn'
                  ? 'border-l-amber-400'
                  : toast.tone === 'success'
                    ? 'border-l-emerald-400'
                    : 'border-l-cyan-400',
            )}
            role="status"
          >
            <div className="flex items-start justify-between gap-2">
              <p className="text-sm font-medium text-white">{toast.title}</p>
              <button
                className="focus-ring rounded text-xs text-slate-400 hover:text-white"
                onClick={() => actions.dismissToast(toast.id)}
                aria-label="Dismiss notification"
              >
                ✕
              </button>
            </div>
            <p className="text-xs text-slate-300">{toast.message}</p>
            {toast.hint ? <p className="text-[11px] text-slate-500">{toast.hint}</p> : null}
          </div>
        ))}
      </div>
    </div>
  );
}
