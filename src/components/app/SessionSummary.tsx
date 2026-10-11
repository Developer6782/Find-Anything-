import { CheckCircle2, Download, RotateCcw } from 'lucide-react';
import type { ChatMessage, SessionStats, ReferenceState } from '../../state/useSearchSession';
import type { Observation } from '../../lib/vision/engine';
import { Button, Panel, StatRow } from '../ui/primitives';
import { clock } from '../../lib/format';

export interface SessionSummaryProps {
  stats: SessionStats;
  reference: ReferenceState;
  messages: ChatMessage[];
  observations: Observation[];
  voiceModel: string | null;
  onRestart: () => void;
}

/** Post-session report. Also exports the raw log for debugging / demo evidence. */
export function SessionSummary({ stats, reference, messages, observations, voiceModel, onRestart }: SessionSummaryProps) {
  const download = () => {
    const payload = {
      exportedAt: new Date().toISOString(),
      target: reference.profile,
      referenceAnalysedAt: reference.analysedAt,
      voiceModel,
      stats,
      messages,
      observations,
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `find-anything-session-${Date.now()}.json`;
    anchor.click();
    URL.revokeObjectURL(url);
  };

  return (
    <Panel className="animate-rise-in space-y-3 border-cyan-400/25">
      <div className="flex items-center gap-2">
        <CheckCircle2 className="h-4 w-4 text-emerald-300" />
        <p className="text-sm font-semibold text-white">Session ended</p>
      </div>
      <p className="text-xs text-slate-400">
        Camera, microphone and the model session are released. You can start another search without reloading.
      </p>
      <div className="divide-y divide-white/5">
        <StatRow label="Duration" value={clock(stats.durationMs)} />
        <StatRow label="Times locked on target" value={stats.locks} tone={stats.locks ? 'good' : 'warn'} />
        <StatRow label="Times lost" value={stats.losses} />
        <StatRow label="Model localisations" value={stats.modelCalls} />
        <StatRow label="Observations logged" value={observations.length} />
      </div>
      <div className="flex flex-wrap gap-2">
        <Button variant="primary" size="sm" onClick={onRestart}>
          <RotateCcw className="h-3.5 w-3.5" /> New search
        </Button>
        <Button size="sm" onClick={download}>
          <Download className="h-3.5 w-3.5" /> Download log
        </Button>
      </div>
    </Panel>
  );
}
