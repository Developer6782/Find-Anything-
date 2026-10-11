import { useRef } from 'react';
import { Image as ImageIcon, Loader2, RefreshCw, ScanSearch, Sparkles, Trash2, Upload } from 'lucide-react';
import type { ReferenceState } from '../../state/useSearchSession';
import { Button, EmptyState, Panel, Pill, Skeleton } from '../ui/primitives';
import { pct } from '../../lib/format';

export interface ReferencePanelProps {
  reference: ReferenceState;
  disabled: boolean;
  onChoose: (file: File) => void;
  onRemove: () => void;
  onReanalyse: () => void;
}

export function ReferencePanel({ reference, disabled, onChoose, onRemove, onReanalyse }: ReferencePanelProps) {
  const inputRef = useRef<HTMLInputElement>(null);

  const pick = () => inputRef.current?.click();

  return (
    <Panel className="space-y-4">
      <header className="flex items-center justify-between gap-2">
        <div>
          <p className="label">Reference object</p>
          <p className="text-sm text-slate-300">What should the agent find?</p>
        </div>
        {reference.status === 'ready' ? <Pill tone="good">analysed</Pill> : null}
      </header>

      <input
        ref={inputRef}
        type="file"
        accept="image/*"
        capture="environment"
        className="hidden"
        aria-label="Upload reference photo"
        onChange={(event) => {
          const file = event.target.files?.[0];
          if (file) onChoose(file);
          event.target.value = '';
        }}
      />

      {reference.dataUrl ? (
        <div className="space-y-3">
          <div className="relative overflow-hidden rounded-xl border border-white/10 bg-void-800">
            <img src={reference.dataUrl} alt="Reference object" className="max-h-56 w-full object-contain" />
            {reference.profile?.targetBBox ? (
              <div
                className="pointer-events-none absolute rounded-md border-2 border-cyan-300/80 shadow-[0_0_24px_-6px_rgba(34,224,255,0.8)]"
                style={{
                  left: `${reference.profile.targetBBox.x * 100}%`,
                  top: `${reference.profile.targetBBox.y * 100}%`,
                  width: `${reference.profile.targetBBox.width * 100}%`,
                  height: `${reference.profile.targetBBox.height * 100}%`,
                }}
              >
                <span className="absolute -top-5 left-0 rounded-full border border-cyan-300/50 bg-void-900/85 px-2 py-0.5 text-[10px] uppercase tracking-wide text-cyan-100">
                  template
                </span>
              </div>
            ) : null}
            {reference.status === 'analysing' ? (
              <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-void-900/80 backdrop-blur-sm">
                <Loader2 className="h-5 w-5 animate-spin text-cyan-300" />
                <p className="text-xs text-slate-300">Reading the object…</p>
              </div>
            ) : null}
          </div>

          <div className="flex flex-wrap gap-2">
            <Button size="sm" onClick={pick} disabled={disabled}>
              <Upload className="h-3.5 w-3.5" /> Replace
            </Button>
            <Button size="sm" onClick={onReanalyse} disabled={disabled || reference.status === 'analysing'}>
              <RefreshCw className="h-3.5 w-3.5" /> Re-analyse
            </Button>
            <Button size="sm" onClick={onRemove} disabled={disabled}>
              <Trash2 className="h-3.5 w-3.5" /> Remove
            </Button>
          </div>
        </div>
      ) : (
        <EmptyState
          icon={<ImageIcon className="h-6 w-6" />}
          title="No reference photo yet"
          message="Upload or capture one clear photo of the object. Use good light and keep the object large in the frame."
          action={
            <Button variant="primary" size="sm" onClick={pick} className="mt-1">
              <Upload className="h-3.5 w-3.5" /> Upload photo
            </Button>
          }
        />
      )}

      {reference.status === 'analysing' ? (
        <div className="space-y-2">
          <Skeleton className="h-4 w-3/4" />
          <Skeleton className="h-4 w-1/2" />
          <Skeleton className="h-4 w-2/3" />
        </div>
      ) : null}

      {reference.error ? (
        <p className="rounded-xl border border-rose-400/30 bg-rose-400/10 px-3 py-2 text-xs text-rose-200">
          {reference.error}
        </p>
      ) : null}

      {reference.warnings.length ? (
        <ul className="space-y-1 rounded-xl border border-amber-400/25 bg-amber-400/[0.07] px-3 py-2 text-xs text-amber-200">
          {reference.warnings.map((warning) => (
            <li key={warning}>• {warning}</li>
          ))}
        </ul>
      ) : null}

      {reference.profile ? (
        <div className="space-y-3 rounded-xl border border-white/10 bg-void-800/60 p-3">
          <div className="flex items-start gap-2">
            <Sparkles className="mt-0.5 h-4 w-4 shrink-0 text-cyan-300" />
            <div>
              <p className="text-sm font-semibold text-white">{reference.profile.name}</p>
              <p className="text-xs text-slate-400">
                {reference.profile.category}
                {reference.latencyMs ? ` · analysed in ${reference.latencyMs} ms` : ''}
              </p>
            </div>
          </div>

          {reference.profile.attributes.length ? (
            <div className="flex flex-wrap gap-1.5">
              {reference.profile.attributes.slice(0, 8).map((attribute) => (
                <span
                  key={`${attribute.key}-${attribute.value}`}
                  className={
                    attribute.distinctiveness === 'high'
                      ? 'chip border-cyan-400/40 bg-cyan-400/10 text-cyan-100'
                      : 'chip'
                  }
                >
                  {attribute.key}: {attribute.value}
                </span>
              ))}
            </div>
          ) : null}

          {reference.profile.searchHint ? (
            <p className="text-xs italic text-slate-400">“{reference.profile.searchHint}”</p>
          ) : null}

          <details className="text-xs text-slate-400">
            <summary className="focus-ring cursor-pointer select-none text-slate-300">Vision pipeline details</summary>
            <div className="mt-2 space-y-2">
              {reference.profile.descriptors.length ? (
                <p>
                  <span className="label">matcher descriptors</span>
                  <br />
                  {reference.profile.descriptors.join(' · ')}
                </p>
              ) : null}
              {reference.profile.ambiguityRisks.length ? (
                <p>
                  <span className="label">may confuse with</span>
                  <br />
                  {reference.profile.ambiguityRisks.join(' · ')}
                </p>
              ) : null}
              <p className="font-mono text-[11px] text-slate-500">
                template box: {reference.profile.targetBBox
                  ? `${pct(reference.profile.targetBBox.x)} , ${pct(reference.profile.targetBBox.y)} · ${pct(
                      reference.profile.targetBBox.width,
                    )}×${pct(reference.profile.targetBBox.height)}`
                  : 'not returned — using image centre as the template'}
              </p>
            </div>
          </details>
        </div>
      ) : null}

      {reference.status !== 'ready' && reference.dataUrl ? (
        <p className="flex items-center gap-2 text-xs text-slate-400">
          <ScanSearch className="h-3.5 w-3.5 text-cyan-300" /> Analyse the photo to build the matching template.
        </p>
      ) : null}
    </Panel>
  );
}
