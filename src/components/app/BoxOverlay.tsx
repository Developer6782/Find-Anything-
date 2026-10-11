import { useEffect, useRef, useState } from 'react';
import type { BBox } from '../../lib/contracts';
import { boxToPixels, fittedContentRect } from '../../lib/vision/bbox';
import type { TrackerState } from '../../lib/vision/engine';
import { cx } from '../ui/primitives';
import { pct } from '../../lib/format';

export interface BoxOverlayProps {
  box: BBox | null;
  state: TrackerState;
  confidence: number;
  label: string;
  videoWidth: number;
  videoHeight: number;
  /** Front camera preview is mirrored — the box must be mirrored with it. */
  mirrored: boolean;
  lastSeenAt: number | null;
}

/**
 * Draws the tracked object box on top of the video.
 *
 * Mapping: normalized model/local coordinates → pixels inside the letterboxed
 * ("object-fit: contain") video rect measured with a ResizeObserver. That makes
 * the overlay exact on any container size, aspect ratio or device pixel ratio.
 */
export function BoxOverlay({
  box,
  state,
  confidence,
  label,
  videoWidth,
  videoHeight,
  mirrored,
  lastSeenAt,
}: BoxOverlayProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });

  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    const measure = () => {
      const rect = element.getBoundingClientRect();
      setSize({ width: rect.width, height: rect.height });
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    window.addEventListener('orientationchange', measure);
    return () => {
      observer.disconnect();
      window.removeEventListener('orientationchange', measure);
    };
  }, []);

  const showBox = Boolean(box) && (state === 'locked' || state === 'acquiring' || state === 'occluded');
  const content = fittedContentRect(videoWidth, videoHeight, size.width, size.height);

  let rect: { left: number; top: number; width: number; height: number } | null = null;
  if (showBox && box) {
    const effective: BBox = mirrored ? { x: 1 - box.x - box.width, y: box.y, width: box.width, height: box.height } : box;
    const pixels = boxToPixels(effective, content);
    const pad = 6;
    rect = {
      left: pixels.left - pad,
      top: pixels.top - pad,
      width: pixels.width + pad * 2,
      height: pixels.height + pad * 2,
    };
  }

  const tone =
    state === 'locked'
      ? { border: 'border-cyan-300', shadow: '0 0 34px -6px rgba(34,224,255,0.75)', text: 'text-cyan-100', chip: 'border-cyan-300/60 bg-cyan-400/15' }
      : state === 'acquiring'
        ? { border: 'border-amber-300/90', shadow: '0 0 26px -8px rgba(251,191,36,0.7)', text: 'text-amber-100', chip: 'border-amber-300/50 bg-amber-400/15' }
        : { border: 'border-slate-300/60', shadow: '0 0 18px -8px rgba(203,213,225,0.5)', text: 'text-slate-200', chip: 'border-slate-300/40 bg-slate-200/10' };

  return (
    <div ref={ref} className="pointer-events-none absolute inset-0" aria-hidden="true">
      {rect ? (
        <div
          className={cx(
            'absolute rounded-lg border-2 transition-[left,top,width,height] duration-150 ease-out',
            tone.border,
            state === 'occluded' && 'opacity-60',
          )}
          style={{
            left: `${rect.left}px`,
            top: `${rect.top}px`,
            width: `${rect.width}px`,
            height: `${rect.height}px`,
            boxShadow: tone.shadow,
            borderStyle: state === 'locked' ? 'solid' : 'dashed',
          }}
        >
          <span className="bracket bracket-tl" />
          <span className="bracket bracket-tr" />
          <span className="bracket bracket-bl" />
          <span className="bracket bracket-br" />

          <div
            className={cx(
              'absolute -top-8 left-0 flex max-w-[14rem] items-center gap-1.5 rounded-full border px-2 py-1 text-[10px] font-semibold tracking-wide backdrop-blur-md',
              tone.chip,
              tone.text,
            )}
          >
            <span
              className={cx(
                'h-1.5 w-1.5 rounded-full',
                state === 'locked' ? 'bg-cyan-300 animate-blink' : state === 'acquiring' ? 'bg-amber-300' : 'bg-slate-300',
              )}
            />
            <span className="truncate uppercase">{label || 'target'}</span>
            <span className="font-mono opacity-80">{pct(confidence)}</span>
          </div>

          {state === 'occluded' && lastSeenAt ? (
            <div className="absolute -bottom-7 left-0 rounded-full border border-slate-400/30 bg-void-900/80 px-2 py-0.5 text-[10px] text-slate-300 backdrop-blur">
              temporarily lost · {Math.max(0, Math.round((Date.now() - lastSeenAt) / 1000))}s ago
            </div>
          ) : null}

          {state === 'acquiring' ? (
            <div className="absolute -bottom-7 left-0 rounded-full border border-amber-300/40 bg-void-900/80 px-2 py-0.5 text-[10px] text-amber-200 backdrop-blur">
              confirming…
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
