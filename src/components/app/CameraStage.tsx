import { useCallback, useEffect, useState } from 'react';
import { Camera, CameraOff, Loader2, RefreshCw, ShieldAlert } from 'lucide-react';
import type { CameraApi } from '../../state/useCamera';
import type { EngineSnapshot } from '../../lib/vision/engine';
import type { ReferenceState } from '../../state/useSearchSession';
import { BoxOverlay } from './BoxOverlay';
import { Button, cx, Pill } from '../ui/primitives';
import { pct } from '../../lib/format';

export interface CameraStageProps {
  camera: CameraApi;
  snapshot: EngineSnapshot;
  reference: ReferenceState;
  sessionActive: boolean;
  mirrored: boolean;
}

export function CameraStage({ camera, snapshot, reference, sessionActive, mirrored }: CameraStageProps) {
  const [dimensions, setDimensions] = useState({ width: 0, height: 0 });

  const onMetadata = useCallback(() => {
    const video = camera.videoRef.current;
    if (video) setDimensions({ width: video.videoWidth, height: video.videoHeight });
  }, [camera.videoRef]);

  // Mobile tabs unmount/mount this element: re-attach a live stream on mount so
  // switching tabs never leaves a black viewport while the camera keeps running.
  useEffect(() => {
    const video = camera.videoRef.current;
    if (video && camera.stream && video.srcObject !== camera.stream) {
      video.srcObject = camera.stream;
      void video.play().catch(() => undefined);
    }
  }, [camera.stream, camera.videoRef, mirrored]);

  const stateLabel =
    snapshot.state === 'locked'
      ? 'Object found'
      : snapshot.state === 'acquiring'
        ? 'Confirming match'
        : snapshot.state === 'occluded'
          ? 'Temporarily lost'
          : snapshot.state === 'lost'
            ? 'Target lost — rescan'
            : snapshot.state === 'paused'
              ? 'Paused'
              : snapshot.state === 'searching'
                ? 'Searching…'
                : 'Idle';

  const tone =
    snapshot.state === 'locked' ? 'good' : snapshot.state === 'acquiring' ? 'warn' : snapshot.state === 'lost' || snapshot.state === 'occluded' ? 'error' : 'cyan';

  return (
    <section className="relative">
      <div
        className={cx(
          'relative aspect-video w-full overflow-hidden rounded-2xl border bg-void-900 transition-colors',
          snapshot.state === 'locked' ? 'border-cyan-400/50' : 'border-white/10',
        )}
      >
        <video
          ref={camera.videoRef}
          playsInline
          muted
          autoPlay
          onLoadedMetadata={onMetadata}
          className={cx('h-full w-full bg-black object-contain', mirrored && '-scale-x-100')}
        />

        {/* Corner ticks for the "camera feed" feel */}
        <div className="pointer-events-none absolute inset-3 rounded-xl border border-white/[0.06]" />

        {sessionActive ? (
          <BoxOverlay
            box={snapshot.box}
            state={snapshot.state}
            confidence={snapshot.stats.modelConfidence || snapshot.stats.localScore}
            label={reference.profile?.name ?? 'target'}
            videoWidth={dimensions.width}
            videoHeight={dimensions.height}
            mirrored={mirrored}
            lastSeenAt={snapshot.lastSeenAt}
          />
        ) : null}

        {/* Scanning sweep while actively searching */}
        {sessionActive && (snapshot.state === 'searching' || snapshot.state === 'lost' || snapshot.state === 'acquiring') ? (
          <div className="pointer-events-none absolute inset-0 overflow-hidden">
            <div className="animate-scan h-24 w-full bg-gradient-to-b from-transparent via-cyan-400/25 to-transparent" />
          </div>
        ) : null}

        {sessionActive && !snapshot.box ? (
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
            <div className="relative h-24 w-24">
              <div className="absolute inset-0 animate-pulse-ring rounded-full border border-cyan-300/40" />
              <div className="absolute inset-3 rounded-2xl border border-cyan-300/30" />
              <div className="absolute inset-0 flex items-center justify-center text-[10px] uppercase tracking-widest text-cyan-200/80">
                sweep
              </div>
            </div>
          </div>
        ) : null}

        {/* Status HUD */}
        <div className="pointer-events-none absolute left-3 top-3 flex flex-wrap items-center gap-2">
          <Pill tone={tone as 'good' | 'warn' | 'error' | 'cyan'}>
            <span className={cx('h-1.5 w-1.5 rounded-full', snapshot.state === 'locked' ? 'animate-blink bg-emerald-300' : 'bg-current')} />
            {stateLabel}
          </Pill>
          {sessionActive ? (
            <Pill tone="neutral" className="font-mono">
              conf {pct(snapshot.stats.modelConfidence || snapshot.stats.localScore)}
            </Pill>
          ) : null}
        </div>
        <div className="pointer-events-none absolute right-3 top-3 flex flex-wrap items-center gap-2">
          <Pill tone="violet" className="font-mono">
            {snapshot.source === 'fused' ? 'gemini + local' : snapshot.source === 'local' ? 'local tracker' : snapshot.source === 'gemini-frame' ? 'gemini frame' : 'idle'}
          </Pill>
          {snapshot.stats.avgLatencyMs ? (
            <Pill tone="neutral" className="font-mono">
              ~{Math.round(snapshot.stats.avgLatencyMs)} ms
            </Pill>
          ) : null}
        </div>

        {/* Camera not live */}
        {camera.status !== 'live' ? (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-void-900/85 px-6 text-center backdrop-blur-sm">
            {camera.status === 'error' ? (
              <>
                <ShieldAlert className="h-7 w-7 text-rose-300" />
                <p className="text-sm font-semibold text-rose-200">{camera.error?.message ?? 'Camera error'}</p>
                <p className="max-w-md text-xs leading-relaxed text-slate-400">{camera.error?.hint}</p>
                <Button variant="primary" size="sm" onClick={() => void camera.retry()}>
                  <RefreshCw className="h-3.5 w-3.5" /> Retry camera
                </Button>
              </>
            ) : camera.status === 'starting' ? (
              <>
                <Loader2 className="h-6 w-6 animate-spin text-cyan-300" />
                <p className="text-sm text-slate-300">Requesting camera permission…</p>
                <p className="text-xs text-slate-500">Allow access in the browser prompt to continue.</p>
              </>
            ) : (
              <>
                <CameraOff className="h-7 w-7 text-slate-400" />
                <p className="text-sm font-medium text-slate-300">Camera is off</p>
                <p className="max-w-sm text-xs text-slate-500">
                  Start a search to open the rear camera and sweep the room.
                </p>
                <Button size="sm" onClick={() => void camera.start({ facing: 'environment' })}>
                  <Camera className="h-3.5 w-3.5" /> Turn on camera
                </Button>
              </>
            )}
          </div>
        ) : null}
      </div>

      <div className="mt-2 flex flex-wrap items-center justify-between gap-2 text-[11px] text-slate-500">
        <span className="font-mono">
          {dimensions.width && dimensions.height ? `${dimensions.width}×${dimensions.height}` : 'no signal'}
          {' · '}
          {camera.facing === 'environment' ? 'rear camera' : 'front camera'}
        </span>
        <span>
          Frames analysed: <span className="font-mono text-slate-400">{snapshot.stats.modelCalls}</span>
          {' · '}
          verified: <span className="font-mono text-slate-400">{snapshot.stats.verifyVerdicts}</span>
        </span>
      </div>
    </section>
  );
}
