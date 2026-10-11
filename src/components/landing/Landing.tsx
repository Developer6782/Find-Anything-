import { useEffect, useState } from 'react';
import {
  ArrowRight,
  Boxes,
  Camera,
  Crosshair,
  Eye,
  Mic,
  MousePointerClick,
  PlayCircle,
  ScanEye,
  Sparkles,
  Upload,
} from 'lucide-react';
import { Button, cx, Pill } from '../ui/primitives';

export interface LandingProps {
  onStart: () => void;
  hasKey: boolean;
  onOpenSettings: () => void;
}

type DemoPhase = 'searching' | 'acquiring' | 'locked' | 'lost';

const PHASE_SCRIPT: { phase: DemoPhase; line: string; box: { x: number; y: number; w: number; h: number } | null }[] = [
  { phase: 'searching', line: 'Scanning the room… pan slowly to the left.', box: null },
  { phase: 'searching', line: 'Keep going — check the shelf area.', box: { x: 0.585, y: 0.34, w: 0.13, h: 0.3 } },
  { phase: 'acquiring', line: 'Possible match — hold still for a second.', box: { x: 0.585, y: 0.34, w: 0.13, h: 0.3 } },
  { phase: 'locked', line: 'Found it! That is your blue mug, 94% match.', box: { x: 0.585, y: 0.34, w: 0.13, h: 0.3 } },
  { phase: 'lost', line: 'Camera moved away — panning back to relocate.', box: null },
];

/** Interactive-looking hero visual. Explicitly labelled as a preview. */
function HeroDemo() {
  const [index, setIndex] = useState(0);

  useEffect(() => {
    const timer = window.setInterval(() => setIndex((i) => (i + 1) % PHASE_SCRIPT.length), 2600);
    return () => window.clearInterval(timer);
  }, []);

  const step = PHASE_SCRIPT[index];
  const tone =
    step.phase === 'locked'
      ? 'border-cyan-300 bg-cyan-400/10 text-cyan-100'
      : step.phase === 'acquiring'
        ? 'border-amber-300/90 text-amber-100'
        : 'border-white/25 text-slate-200';

  return (
    <div className="glass relative overflow-hidden rounded-3xl p-3 shadow-glow">
      <div className="mb-2 flex items-center justify-between px-1">
        <div className="flex items-center gap-2">
          <span className="h-2 w-2 rounded-full bg-rose-400/80" />
          <span className="h-2 w-2 rounded-full bg-amber-300/80" />
          <span className="h-2 w-2 rounded-full bg-emerald-400/80" />
          <span className="ml-2 font-mono text-[11px] text-slate-400">live viewport · preview</span>
        </div>
        <Pill tone="violet">interactive preview</Pill>
      </div>

      <div className="relative aspect-video w-full overflow-hidden rounded-2xl border border-white/10 bg-void-900">
        <svg viewBox="0 0 800 450" className="h-full w-full" role="img" aria-label="Preview of the camera viewport with a highlighted object">
          <defs>
            <linearGradient id="wall" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="#0d1524" />
              <stop offset="100%" stopColor="#070a12" />
            </linearGradient>
            <linearGradient id="shelf" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="#1c2536" />
              <stop offset="100%" stopColor="#111826" />
            </linearGradient>
            <linearGradient id="desk" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="#151d2c" />
              <stop offset="100%" stopColor="#0a0f19" />
            </linearGradient>
            <radialGradient id="lamp" cx="50%" cy="0%" r="80%">
              <stop offset="0%" stopColor="rgba(34,224,255,0.22)" />
              <stop offset="100%" stopColor="rgba(34,224,255,0)" />
            </radialGradient>
          </defs>

          <rect width="800" height="450" fill="url(#wall)" />
          <rect width="800" height="450" fill="url(#lamp)" />

          {/* shelf with objects */}
          <rect x="420" y="250" width="330" height="12" rx="4" fill="url(#shelf)" />
          {/* blue mug (the target) */}
          <g>
            <rect x="470" y="152" width="86" height="96" rx="12" fill="#2b7bd6" />
            <rect x="470" y="152" width="86" height="14" rx="7" fill="#3f95ef" />
            <path d="M556 180 h16 a18 18 0 0 1 0 40 h-16" fill="none" stroke="#2b7bd6" strokeWidth="10" strokeLinecap="round" />
            <ellipse cx="513" cy="152" rx="43" ry="10" fill="#57a6f7" />
          </g>
          {/* books */}
          <g>
            <rect x="600" y="214" width="58" height="36" rx="4" fill="#3b3350" />
            <rect x="606" y="186" width="52" height="28" rx="4" fill="#4a3d63" />
            <rect x="612" y="162" width="44" height="24" rx="4" fill="#5b4a78" />
          </g>
          {/* plant */}
          <g>
            <rect x="694" y="196" width="42" height="54" rx="8" fill="#26303f" />
            <circle cx="700" cy="186" r="18" fill="#2f5f4a" />
            <circle cx="726" cy="176" r="22" fill="#37735a" />
            <circle cx="712" cy="196" r="16" fill="#2b5643" />
          </g>

          {/* desk with laptop + phone */}
          <rect x="0" y="300" width="800" height="150" fill="url(#desk)" />
          <g transform="translate(90 236)">
            <path d="M0 64 L150 64 L168 96 L-18 96 Z" fill="#1d2637" />
            <rect x="10" y="0" width="130" height="66" rx="6" fill="#232f43" />
            <rect x="16" y="6" width="118" height="54" rx="4" fill="#0f1724" />
            <circle cx="140" cy="30" r="4" fill="#22e0ff" opacity="0.6" />
          </g>
          <g transform="translate(300 268)">
            <rect x="0" y="0" width="46" height="76" rx="9" fill="#161d2b" />
            <rect x="5" y="6" width="36" height="62" rx="5" fill="#0c1119" />
          </g>
          {/* keyboard */}
          <g transform="translate(430 330)">
            <rect width="200" height="52" rx="8" fill="#161e2c" />
            {Array.from({ length: 4 }).map((_, row) => (
              <g key={`row-${row}`}>
                {Array.from({ length: 10 }).map((__, col) => (
                  <rect
                    key={`key-${row}-${col}`}
                    x={10 + col * 18}
                    y={8 + row * 11}
                    width="14"
                    height="8"
                    rx="2"
                    fill="#1f2a3c"
                  />
                ))}
              </g>
            ))}
          </g>
          {/* window light */}
          <rect x="40" y="40" width="150" height="150" rx="12" fill="#0b1220" stroke="#1b2740" strokeWidth="3" />
          <path d="M115 40 V190 M40 115 H190" stroke="#1b2740" strokeWidth="3" />
        </svg>

        {/* scanning sweep */}
        {step.phase !== 'locked' ? (
          <div className="pointer-events-none absolute inset-0 overflow-hidden">
            <div className="animate-scan h-20 w-full bg-gradient-to-b from-transparent via-cyan-400/20 to-transparent" />
          </div>
        ) : null}

        {/* animated bounding box */}
        {step.box ? (
          <div
            className={cx(
              'absolute rounded-lg border-2 transition-all duration-[900ms] ease-out',
              tone,
              step.phase === 'acquiring' && 'border-dashed',
            )}
            style={{
              left: `${step.box.x * 100}%`,
              top: `${step.box.y * 100}%`,
              width: `${step.box.w * 100}%`,
              height: `${step.box.h * 100}%`,
              boxShadow: step.phase === 'locked' ? '0 0 40px -6px rgba(34,224,255,0.8)' : 'none',
            }}
          >
            <span className="bracket bracket-tl" />
            <span className="bracket bracket-tr" />
            <span className="bracket bracket-bl" />
            <span className="bracket bracket-br" />
            <span className="absolute -top-7 left-0 whitespace-nowrap rounded-full border border-cyan-300/40 bg-void-900/85 px-2 py-0.5 text-[10px] uppercase tracking-wide text-cyan-100">
              blue ceramic mug · {step.phase === 'locked' ? '94%' : 'checking'}
            </span>
          </div>
        ) : null}

        <div className="pointer-events-none absolute bottom-3 left-3 right-3 flex items-center gap-2 rounded-xl border border-white/10 bg-void-900/75 px-3 py-2 backdrop-blur">
          <Mic className="h-3.5 w-3.5 shrink-0 text-cyan-300" />
          <p key={step.line} className="animate-rise-in truncate text-xs text-slate-200">
            {step.line}
          </p>
        </div>
      </div>

      <p className="mt-2 px-1 text-[11px] text-slate-500">
        Preview animation — the real app draws the box from live model coordinates plus an on-device tracker.
      </p>
    </div>
  );
}

const FEATURES = [
  {
    icon: ScanEye,
    title: 'Live Vision',
    body: 'Every frame is analysed by Gemini and snapped to pixels by an on-device ZNCC tracker, so the box stays glued to the object while you move.',
    accent: 'from-cyan-400/20',
  },
  {
    icon: Mic,
    title: 'Voice Guidance',
    body: 'A two-way voice session walks you around the room — "pan left", "get closer" — and speaks the moment the object is found.',
    accent: 'from-violet-400/20',
  },
  {
    icon: Crosshair,
    title: 'Smart Object Tracking',
    body: 'When the target leaves the frame the state becomes “temporarily lost”, the last known spot is held, and re-acquisition kicks in automatically.',
    accent: 'from-emerald-400/20',
  },
];

const STEPS = [
  { icon: Upload, title: 'Show the object', body: 'Upload or capture one clear photo of the thing you are looking for.' },
  { icon: Eye, title: 'AI studies it', body: 'Gemini extracts the target’s colours, shape, texture, logos and confusable look-alikes.' },
  { icon: Camera, title: 'Sweep the room', body: 'Start the live camera. Frames stream to the vision pipeline while the agent guides you.' },
  { icon: MousePointerClick, title: 'See it highlighted', body: 'A bounding box locks on the object, with confidence, tracking state and last-seen time.' },
];

export function Landing({ onStart, hasKey, onOpenSettings }: LandingProps) {
  return (
    <div className="mx-auto w-full max-w-7xl px-4 pb-16 pt-6 sm:px-6">
      <nav className="glass flex items-center justify-between gap-3 px-4 py-3">
        <div className="flex items-center gap-2">
          <span className="relative flex h-9 w-9 items-center justify-center rounded-xl border border-cyan-300/40 bg-cyan-400/10">
            <Sparkles className="h-4 w-4 text-cyan-200" />
          </span>
          <div className="leading-tight">
            <p className="text-sm font-semibold text-white">Find Anything</p>
            <p className="text-[11px] text-slate-400">AI visual search agent</p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <a href="#how" className="focus-ring hidden rounded-lg px-3 py-2 text-sm text-slate-300 hover:text-white sm:block">
            See how it works
          </a>
          <Button size="sm" onClick={onOpenSettings}>
            {hasKey ? 'API key connected' : 'Connect API key'}
          </Button>
          <Button size="sm" variant="primary" onClick={onStart}>
            Start Visual Search
          </Button>
        </div>
      </nav>

      <header className="mt-10 grid items-center gap-8 lg:mt-16 lg:grid-cols-[1.05fr_1fr]">
        <div className="space-y-6">
          <Pill tone="cyan" className="w-fit">
            <Sparkles className="h-3 w-3" /> Gemini-powered · BYOK · works in your browser
          </Pill>
          <h1 className="text-4xl font-semibold leading-[1.05] tracking-tight text-white sm:text-5xl lg:text-6xl">
            Find Anything.
            <br />
            <span className="text-gradient">Just Look Around.</span>
          </h1>
          <p className="max-w-xl text-base leading-relaxed text-slate-400 sm:text-lg">
            Upload a photo of any object, then point your camera around the room. The agent talks you through the
            search in real time and outlines the exact object the moment it appears — no typing, no scrolling, no
            guesswork.
          </p>
          <div className="flex flex-wrap items-center gap-3">
            <Button variant="primary" size="lg" onClick={onStart}>
              Start Visual Search <ArrowRight className="h-4 w-4" />
            </Button>
            <a href="#how" className="btn btn-ghost px-5 py-3 text-base">
              <PlayCircle className="h-4 w-4" /> See How It Works
            </a>
          </div>
          <div className="flex flex-wrap gap-4 text-[11px] text-slate-500">
            <span className="flex items-center gap-1.5">
              <Boxes className="h-3.5 w-3.5 text-cyan-300/80" /> Live vision + voice + tracking
            </span>
            <span className="flex items-center gap-1.5">
              <Crosshair className="h-3.5 w-3.5 text-violet-300/80" /> Normalized coordinates, screen-accurate boxes
            </span>
            <span className="flex items-center gap-1.5">
              <Mic className="h-3.5 w-3.5 text-emerald-300/80" /> Your key stays in your browser
            </span>
          </div>
        </div>

        <HeroDemo />
      </header>

      <section id="how" className="mt-20 space-y-6">
        <div className="space-y-2">
          <p className="label">How it works</p>
          <h2 className="text-2xl font-semibold text-white sm:text-3xl">Four steps from photo to found</h2>
        </div>
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {STEPS.map((step, i) => (
            <div key={step.title} className="glass group relative overflow-hidden p-5">
              <span className="absolute right-4 top-3 font-mono text-3xl text-white/5">0{i + 1}</span>
              <step.icon className="h-5 w-5 text-cyan-300" />
              <p className="mt-3 text-sm font-semibold text-white">{step.title}</p>
              <p className="mt-1.5 text-xs leading-relaxed text-slate-400">{step.body}</p>
            </div>
          ))}
        </div>
      </section>

      <section className="mt-16 space-y-6">
        <div className="space-y-2">
          <p className="label">Built for the real world</p>
          <h2 className="text-2xl font-semibold text-white sm:text-3xl">Not a chat window with a camera</h2>
        </div>
        <div className="grid gap-4 md:grid-cols-3">
          {FEATURES.map((feature) => (
            <div key={feature.title} className="glass relative overflow-hidden p-5">
              <div className={cx('absolute inset-x-0 -top-16 h-32 bg-gradient-to-b to-transparent blur-2xl', feature.accent)} />
              <feature.icon className="relative h-5 w-5 text-cyan-200" />
              <p className="relative mt-3 text-base font-semibold text-white">{feature.title}</p>
              <p className="relative mt-2 text-sm leading-relaxed text-slate-400">{feature.body}</p>
            </div>
          ))}
        </div>
      </section>

      <section className="glass mt-16 flex flex-wrap items-center justify-between gap-4 p-6">
        <div className="max-w-xl space-y-2">
          <h3 className="text-lg font-semibold text-white">Bring your own Gemini key</h3>
          <p className="text-sm text-slate-400">
            This product never ships with a hardcoded key. Paste your own key, choose how it is stored (tab-only,
            passphrase-encrypted, or memory-only), and the app will verify which models your account can actually use
            before starting.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button onClick={onOpenSettings}>{hasKey ? 'Manage key' : 'Connect key'}</Button>
          <Button variant="primary" onClick={onStart}>
            Start Visual Search <ArrowRight className="h-4 w-4" />
          </Button>
        </div>
      </section>

      <footer className="mt-14 flex flex-col items-center gap-2 text-center text-[11px] text-slate-500">
        <p>Find Anything · visual search agent demo · camera and microphone need HTTPS or localhost.</p>
        <p>Built with React, Vite, Express and the Gemini API. No analytics, no tracking, no server-side key storage.</p>
      </footer>
    </div>
  );
}
