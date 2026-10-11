import { useEffect, useRef, useState } from 'react';
import { Activity, Bot, CircleDot, Gauge, Mic, Send, User, Volume2 } from 'lucide-react';
import type { ChatMessage, SessionStatus, VoiceState } from '../../state/useSearchSession';
import type { EngineSnapshot, Observation } from '../../lib/vision/engine';
import { Button, cx, EmptyState, inputClass, Panel, Pill, StatRow } from '../ui/primitives';
import { pct, timeAgo } from '../../lib/format';

export interface AssistantPanelProps {
  messages: ChatMessage[];
  observations: Observation[];
  snapshot: EngineSnapshot;
  voice: VoiceState;
  status: SessionStatus;
  onAsk: (text: string) => void;
}

const stateTone: Record<string, 'good' | 'warn' | 'error' | 'cyan' | 'neutral'> = {
  locked: 'good',
  acquiring: 'warn',
  occluded: 'error',
  lost: 'error',
  searching: 'cyan',
  paused: 'neutral',
  idle: 'neutral',
};

export function AssistantPanel({ messages, observations, snapshot, voice, status, onAsk }: AssistantPanelProps) {
  const [draft, setDraft] = useState('');
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const element = listRef.current;
    if (element) element.scrollTop = element.scrollHeight;
  }, [messages.length]);

  const send = () => {
    const text = draft.trim();
    if (!text) return;
    setDraft('');
    onAsk(text);
  };

  const voiceLabel =
    voice.liveStatus === 'ready'
      ? `Live · ${voice.liveModel ?? ''}`
      : voice.fallbackActive
        ? 'Push-to-talk'
        : voice.liveStatus === 'connecting'
          ? 'Connecting…'
          : 'Text only';

  return (
    <div className="flex h-full min-h-0 flex-col gap-3">
      <Panel className="space-y-3">
        <div className="flex items-center justify-between gap-2">
          <p className="label">Detection status</p>
          <Pill tone={stateTone[snapshot.state] ?? 'neutral'}>
            <CircleDot className="h-3 w-3" />
            {snapshot.state}
          </Pill>
        </div>

        <div>
          <div className="mb-1 flex items-center justify-between text-xs text-slate-400">
            <span>confidence</span>
            <span className="font-mono">
              {pct(Math.max(snapshot.stats.modelConfidence, snapshot.stats.localScore))}
            </span>
          </div>
          <div className="h-1.5 w-full overflow-hidden rounded-full bg-white/10">
            <div
              className={cx(
                'h-full rounded-full transition-all duration-300',
                snapshot.state === 'locked'
                  ? 'bg-gradient-to-r from-cyan-400 to-emerald-300'
                  : snapshot.state === 'acquiring'
                    ? 'bg-gradient-to-r from-amber-400 to-cyan-400'
                    : 'bg-gradient-to-r from-slate-500 to-slate-400',
              )}
              style={{
                width: `${Math.round(Math.max(snapshot.stats.modelConfidence, snapshot.stats.localScore) * 100)}%`,
              }}
            />
          </div>
        </div>

        <div className="divide-y divide-white/5">
          <StatRow label="last seen" value={timeAgo(snapshot.lastSeenAt)} />
          <StatRow label="evidence" value={snapshot.source} />
          <StatRow label="model sees target" value={snapshot.modelSeesTarget === null ? '—' : snapshot.modelSeesTarget ? 'yes' : 'no'} tone={snapshot.modelSeesTarget ? 'good' : 'warn'} />
          <StatRow label="local ZNCC score" value={snapshot.stats.localScore.toFixed(2)} />
          <StatRow label="frames analysed" value={snapshot.stats.modelCalls} />
          <StatRow label="verify verdicts" value={`${snapshot.stats.verifyVerdicts} (${snapshot.stats.verifyRejections} rejected)`} />
          <StatRow label="voice" value={voiceLabel} />
          {voice.liveFramesSent ? <StatRow label="video frames streamed" value={voice.liveFramesSent} /> : null}
        </div>

        {snapshot.lastReason ? (
          <p className="rounded-lg border border-white/10 bg-void-800/70 px-3 py-2 text-xs italic text-slate-300">
            “{snapshot.lastReason}”
          </p>
        ) : null}
      </Panel>

      <Panel className="flex min-h-[16rem] flex-1 flex-col gap-3 overflow-hidden">
        <div className="flex items-center justify-between gap-2">
          <p className="label flex items-center gap-2">
            <Bot className="h-3.5 w-3.5 text-cyan-300" /> Agent conversation
          </p>
          {voice.modelSpeaking ? (
            <Pill tone="cyan">
              <Volume2 className="h-3 w-3 animate-blink" /> speaking
            </Pill>
          ) : voice.pttListening ? (
            <Pill tone="warn">
              <Mic className="h-3 w-3 animate-blink" /> listening
            </Pill>
          ) : null}
        </div>

        <div ref={listRef} className="min-h-0 flex-1 space-y-2 overflow-y-auto pr-1">
          {messages.length === 0 ? (
            <EmptyState
              icon={<Activity className="h-5 w-5" />}
              title="Nothing said yet"
              message="Start a search — the agent greets you, guides the sweep and narrates every detection."
            />
          ) : (
            messages.map((message) => {
              const isUser = message.role === 'user';
              const isSystem = message.role === 'system';
              const isGuidance = message.role === 'guidance';
              return (
                <div
                  key={message.id}
                  className={cx(
                    'animate-rise-in rounded-xl border px-3 py-2 text-xs leading-relaxed',
                    isUser
                      ? 'ml-6 border-white/10 bg-white/[0.06] text-slate-100'
                      : isSystem
                        ? 'border-dashed border-white/[0.12] bg-transparent text-slate-400'
                        : isGuidance
                          ? 'border-cyan-400/25 bg-cyan-400/[0.07] text-cyan-100'
                          : message.tone === 'warn'
                            ? 'border-amber-400/25 bg-amber-400/[0.07] text-amber-100'
                            : 'border-violet-400/20 bg-violet-400/[0.07] text-slate-100',
                  )}
                >
                  <div className="mb-0.5 flex items-center gap-1.5 text-[10px] uppercase tracking-wide opacity-70">
                    {isUser ? <User className="h-3 w-3" /> : isSystem ? <CircleDot className="h-3 w-3" /> : <Bot className="h-3 w-3" />}
                    {isUser ? 'you' : isSystem ? 'system' : isGuidance ? 'guidance' : 'find anything'}
                    {message.model ? <span className="font-mono lowercase">· {message.model}</span> : null}
                  </div>
                  {message.text}
                </div>
              );
            })
          )}
        </div>

        <div className="flex items-end gap-2">
          <label className="sr-only" htmlFor="agent-input">
            Message the agent
          </label>
          <input
            id="agent-input"
            className={inputClass}
            placeholder={status === 'searching' ? 'Ask: “is it on the left?”' : 'Type a message…'}
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault();
                send();
              }
            }}
          />
          <Button variant="primary" onClick={send} aria-label="Send message" className="px-3 py-2.5">
            <Send className="h-4 w-4" />
          </Button>
        </div>
      </Panel>

      <Panel className="max-h-56 space-y-2 overflow-y-auto">
        <p className="label flex items-center gap-2">
          <Gauge className="h-3.5 w-3.5 text-violet-300" /> Recent observations
        </p>
        {observations.length === 0 ? (
          <p className="text-xs text-slate-500">Model and tracker decisions will appear here as they happen.</p>
        ) : (
          observations.map((observation) => (
            <div key={observation.id} className="flex items-start gap-2 text-xs">
              <span
                className={cx(
                  'mt-1 h-1.5 w-1.5 shrink-0 rounded-full',
                  observation.tone === 'good'
                    ? 'bg-emerald-300'
                    : observation.tone === 'warn'
                      ? 'bg-amber-300'
                      : 'bg-slate-400',
                )}
              />
              <div className="min-w-0">
                <p className="truncate text-slate-300">{observation.text}</p>
                <p className="font-mono text-[10px] text-slate-500">
                  {observation.kind}
                  {observation.confidence !== undefined ? ` · ${pct(observation.confidence)}` : ''} ·{' '}
                  {new Date(observation.at).toLocaleTimeString()}
                </p>
              </div>
            </div>
          ))
        )}
      </Panel>
    </div>
  );
}
