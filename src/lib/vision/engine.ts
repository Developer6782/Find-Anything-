import { DETECTION } from '../config';
import type { BBox, DetectResponse, TargetProfile, VerifyResult } from '../contracts';
import { clampBox, iou, lerpBox } from './bbox';
import { type AnchorTemplate } from './matcher';
import { FrameGrabber, type CapturedJpeg } from './frames';
import { ObjectTracker, znccToConfidence } from './tracker';
import type { GrayImage } from './imageOps';

/* ───────────────────────────── public types ─────────────────────────────── */

export type TrackerState = 'idle' | 'searching' | 'acquiring' | 'locked' | 'occluded' | 'lost' | 'paused';

export type EvidenceSource = 'none' | 'local' | 'gemini-frame' | 'gemini-live' | 'fused' | 'demo';

export interface EngineStats {
  modelCalls: number;
  modelErrors: number;
  verifyCalls: number;
  localScore: number;
  modelConfidence: number;
  lastLatencyMs: number;
  avgLatencyMs: number;
  verifyVerdicts: number;
  verifyRejections: number;
}

export interface EngineSnapshot {
  state: TrackerState;
  /** Smoothed box for display (null when there is nothing trustworthy to show). */
  box: BBox | null;
  rawBox: BBox | null;
  confidence: number;
  source: EvidenceSource;
  lastSeenAt: number | null;
  lastReason: string;
  modelSeesTarget: boolean | null;
  stats: EngineStats;
}

export type ObservationKind = 'local' | 'model' | 'verify' | 'voice' | 'system';

export interface Observation {
  id: string;
  at: number;
  kind: ObservationKind;
  text: string;
  confidence?: number;
  tone: 'neutral' | 'good' | 'warn';
}

export interface EngineEvent {
  type: 'acquired' | 'reacquired' | 'occluded' | 'lost' | 'hint' | 'model-visible' | 'model-absent' | 'error';
  message: string;
  /** Advice the voice layer may speak. */
  speak?: string;
}

export interface EngineDeps {
  /** One model localisation round-trip. */
  detect: (frame: CapturedJpeg, profile: TargetProfile | null) => Promise<DetectResponse>;
  /** Optional high-precision confirmation (reference photo vs candidate crop). */
  verify?: (
    frame: CapturedJpeg,
    box: BBox,
    profile: TargetProfile | null,
  ) => Promise<VerifyResult>;
  onSnapshot: (snapshot: EngineSnapshot) => void;
  onObservation: (observation: Observation) => void;
  onEvent: (event: EngineEvent) => void;
  /** Settings that may change mid-session. */
  settings?: () => { detectFps: number; acquireConfidence: number; verifyEnabled: boolean };
  /** Test seams — production code uses the real FrameGrabber and this.now(). */
  frames?: {
    captureGray: (video: HTMLVideoElement, targetWidth: number) => GrayImage | null;
    captureJpeg: (video: HTMLVideoElement, maxWidth: number, quality?: number) => CapturedJpeg | null;
  };
  now?: () => number;
}

export interface ExternalObservation {
  source: 'gemini-live';
  visible: boolean;
  confidence: number;
  reason?: string;
  box?: BBox | null;
}

/* ─────────────────────────────── engine ────────────────────────────────── */

const HOLD_MIN_MS = 1300;

export class VisionEngine {
  private deps: EngineDeps;
  private tracker = new ObjectTracker();
  private grabber = new FrameGrabber();

  private video: HTMLVideoElement | null = null;
  private rafId = 0;
  private running = false;
  private paused = false;
  private inFlight = false;
  private stopping = false;

  private profile: TargetProfile | null = null;

  private displayBox: BBox | null = null;
  private modelBox: BBox | null = null;
  private modelConf = 0;
  private modelAt = 0;
  private localBox: BBox | null = null;
  private localConf = 0;
  /** Monotonic timestamp (engine clock) — used for all timing decisions. */
  private lastSeenMono: number | null = null;
  /** Wall-clock timestamp — what the UI displays ("last seen 4s ago"). */
  private lastSeenAt: number | null = null;
  private lastReason = '';
  private modelSeesTarget: boolean | null = null;
  private absentStreak = 0;
  private state: TrackerState = 'idle';

  private lastLocalAt = 0;
  private lastModelAt = 0;
  private lastVerifyAt = 0;
  private verifyFailStreak = 0;
  private verifyConf = 0;
  /**
   * Cooldown per event type — a chatty "model-visible" tick must never mask the
   * "acquired"/"reacquired"/"lost" transitions that drive the UI counters.
   */
  private lastEventAt: Record<string, number> = {};
  private hadLock = false;

  private stats: EngineStats = {
    modelCalls: 0,
    modelErrors: 0,
    verifyCalls: 0,
    localScore: 0,
    modelConfidence: 0,
    lastLatencyMs: 0,
    avgLatencyMs: 0,
    verifyVerdicts: 0,
    verifyRejections: 0,
  };

  constructor(deps: EngineDeps) {
    this.deps = deps;
  }

  /** Monotonic clock (injectable so the tracker logic is unit-testable). */
  private now(): number {
    return this.deps.now ? this.deps.now() : performance.now();
  }

  private get frames() {
    return this.deps.frames ?? this.grabber;
  }

  /* ── lifecycle ── */

  setProfile(profile: TargetProfile | null, anchors: AnchorTemplate[]): void {
    this.profile = profile;
    this.tracker.setAnchors(anchors);
    this.resetEvidence();
  }

  hasAnchors(): boolean {
    return this.tracker.anchorCount > 0;
  }

  start(video: HTMLVideoElement): void {
    this.video = video;
    if (this.running) return;
    this.running = true;
    this.stopping = false;
    this.state = 'searching';
    this.resetEvidence();
    const tick = () => {
      if (!this.running) return;
      this.rafId = requestAnimationFrame(tick);
      this.step();
    };
    this.rafId = requestAnimationFrame(tick);
  }

  stop(): void {
    this.running = false;
    this.stopping = true;
    this.inFlight = false;
    cancelAnimationFrame(this.rafId);
    this.video = null;
    this.tracker.clear();
    this.displayBox = null;
    this.state = 'idle';
    this.emitSnapshot();
  }

  pause(): void {
    this.paused = true;
    this.state = 'paused';
    this.emitSnapshot();
  }

  resume(): void {
    this.paused = false;
    this.state = this.displayBox ? 'locked' : 'searching';
    this.emitSnapshot();
  }

  isPaused(): boolean {
    return this.paused;
  }

  /** Manual retry from the UI (e.g. "Re-scan"). */
  reacquire(): void {
    this.resetEvidence();
    this.state = 'searching';
    this.lastModelAt = 0;
    this.emitSnapshot();
  }

  cancelInFlight(): void {
    this.inFlight = false;
  }

  /** Marks the target as seen now, on both clocks. */
  private markSeen(): void {
    this.lastSeenMono = this.now();
    this.lastSeenAt = Date.now();
  }

  /** Back-dates the last sighting (used when evidence turns out to be wrong). */
  private backdateSeen(ms: number): void {
    const mono = this.now();
    const wall = Date.now();
    this.lastSeenMono = Math.min(this.lastSeenMono ?? mono, mono - ms);
    this.lastSeenAt = Math.min(this.lastSeenAt ?? wall, wall - ms);
  }

  private resetEvidence(): void {
    this.displayBox = null;
    this.modelBox = null;
    this.modelConf = 0;
    this.modelAt = 0;
    this.localBox = null;
    this.localConf = 0;
    this.lastSeenMono = null;
    this.lastSeenAt = null;
    this.lastReason = '';
    this.modelSeesTarget = null;
    this.absentStreak = 0;
    this.verifyFailStreak = 0;
    this.verifyConf = 0;
    this.hadLock = false;
    this.stats.localScore = 0;
    this.stats.modelConfidence = 0;
  }

  /* ── per-frame loop ── */

  private step(): void {
    const now = this.now();
    const video = this.video;
    if (!video || video.readyState < 2 || !video.videoWidth) return;
    if (this.paused) {
      this.emitSnapshot();
      return;
    }

    const settings = this.deps.settings?.() ?? {
      detectFps: DETECTION.detectFps,
      acquireConfidence: DETECTION.acquireConfidence,
      verifyEnabled: true,
    };

    // 1) Cheap local tracking at video cadence.
    if (now - this.lastLocalAt >= 1000 / DETECTION.localFps) {
      this.lastLocalAt = now;
      const gray = this.frames.captureGray(video, DETECTION.matcherWidth);
      if (gray) {
        const predicted = this.displayBox;
        const outcome = this.tracker.track(gray, predicted);
        if (outcome.box && outcome.score > 0.2) {
          this.localBox = outcome.box;
          this.localConf = outcome.confidence;
          this.stats.localScore = outcome.score;
        } else {
          this.localBox = null;
          this.localConf = 0;
          this.stats.localScore = Math.max(0, outcome.score);
        }
      }
    }

    // 2) Model localisation at a cost-controlled cadence.
    const holdMs = Math.max(HOLD_MIN_MS, (2000 / Math.max(settings.detectFps, 0.2)));
    const modelFresh = now - this.modelAt < holdMs;
    const intervalMs =
      this.state === 'locked' && this.modelConf > 0.75
        ? 1000 / Math.max(settings.detectFps, 0.35)
        : 1000 / Math.max(settings.detectFps, 0.2);
    if (!this.inFlight && now - this.lastModelAt >= intervalMs) {
      void this.runModelProbe(now, settings);
    }

    // 3) Fuse evidence → display state.
    this.fuse(now, modelFresh, settings.acquireConfidence);
    this.emitSnapshot();
  }

  private async runModelProbe(
    startedAt: number,
    settings: { detectFps: number; acquireConfidence: number; verifyEnabled: boolean },
  ): Promise<void> {
    const video = this.video;
    if (!video) return;
    this.inFlight = true;
    this.lastModelAt = startedAt;
    const frame = this.frames.captureJpeg(video, DETECTION.frameWidth);
    if (!frame) {
      this.inFlight = false;
      return;
    }
    this.stats.modelCalls += 1;

    try {
      const result = await this.deps.detect(frame, this.profile);
      if (this.stopping) return;
      this.stats.lastLatencyMs = result.latencyMs;
      this.stats.avgLatencyMs = this.stats.avgLatencyMs
        ? this.stats.avgLatencyMs * 0.7 + result.latencyMs * 0.3
        : result.latencyMs;

      const wasLocked = this.state === 'locked';

      if (result.visible && result.bbox && result.confidence >= DETECTION.lowConfidence) {
        // Guard against a model that jumps to a completely different object.
        const jumpIsSuspicious =
          this.displayBox !== null && iou(this.displayBox, result.bbox) < 0.05 && result.confidence < 0.8;
        if (!jumpIsSuspicious) {
          this.modelBox = clampBox(result.bbox);
          this.modelConf = result.confidence;
          this.modelAt = this.now();
          this.markSeen();
          this.absentStreak = 0;
          this.modelSeesTarget = true;
          this.lastReason = result.reason ?? '';
          this.verifyConf = 0;

          // Snap harder when we just (re)acquired, glide when refining.
          const alpha = wasLocked ? 0.55 : 0.95;
          this.displayBox = this.displayBox
            ? lerpBox(this.displayBox, this.modelBox, alpha)
            : this.modelBox;

          this.pushObservation({
            kind: 'model',
            tone: result.confidence >= 0.75 ? 'good' : 'neutral',
            confidence: result.confidence,
            text: result.reason
              ? `Sees target — “${result.reason}”`
              : 'Target visible in the frame',
          });

          if (wasLocked) this.maybeEvent('model-visible', 'Target confirmed');
          else this.maybeEvent('model-visible', 'Target spotted');

          if (settings.verifyEnabled && this.deps.verify && this.shouldVerify(result.confidence)) {
            void this.runVerify(frame, this.modelBox);
          }
        }
      } else if (result.visible && !result.bbox) {
        // Model is confident it sees the object but will not place it — be honest.
        this.modelSeesTarget = true;
        this.modelConf = Math.max(this.modelConf * 0.6, 0);
        this.lastReason = result.reason ?? 'Target seen, but its exact position is unclear';
        this.pushObservation({
          kind: 'model',
          tone: 'warn',
          confidence: result.confidence,
          text: `Target likely in view, position unclear — “${this.lastReason}”`,
        });
      } else {
        this.modelSeesTarget = false;
        this.modelConf = Math.max(0, this.modelConf * 0.35);
        this.absentStreak += 1;
        this.lastReason = result.reason ?? '';
        if (result.reason) {
          this.pushObservation({
            kind: 'model',
            tone: 'neutral',
            text: `Not visible — “${result.reason}”`,
          });
        }
        if (this.absentStreak === 2 && !wasLocked) {
          this.maybeEvent('model-absent', 'Target not visible', 'I can\'t see it yet — keep moving slowly.');
        }
      }
    } catch (err) {
      this.stats.modelErrors += 1;
      const message = err instanceof Error ? err.message : 'Localisation failed';
      this.pushObservation({ kind: 'system', tone: 'warn', text: `Detection error — ${message}` });
    } finally {
      this.inFlight = false;
    }
  }

  private shouldVerify(modelConfidence: number): boolean {
    const now = this.now();
    if (now - this.lastVerifyAt < DETECTION.verifyEveryMs) return false;
    if (this.stats.verifyRejections >= 3 && this.verifyFailStreak >= 2) return false;
    // Verify uncertain hits and periodically refresh a confident lock.
    return modelConfidence < 0.85 || this.stats.verifyVerdicts % 3 === 2;
  }

  private async runVerify(frame: CapturedJpeg, box: BBox): Promise<void> {
    const verify = this.deps.verify;
    if (!verify) return;
    this.lastVerifyAt = this.now();
    this.stats.verifyCalls += 1;
    try {
      const verdict = await verify(frame, box, this.profile);
      if (this.stopping) return;
      this.stats.verifyVerdicts += 1;
      if (verdict.visible && verdict.confidence >= 0.5) {
        this.verifyConf = verdict.confidence;
        this.modelConf = Math.max(this.modelConf, Math.min(0.9, verdict.confidence));
        this.verifyFailStreak = 0;
        this.pushObservation({
          kind: 'verify',
          tone: 'good',
          confidence: verdict.confidence,
          text: `Verified candidate — ${verdict.reason ?? 'matches the reference'}`,
        });
      } else if (!verdict.visible && verdict.confidence >= 0.55) {
        this.verifyFailStreak += 1;
        this.stats.verifyRejections += 1;
        this.modelConf *= 0.45;
        this.pushObservation({
          kind: 'verify',
          tone: 'warn',
          confidence: verdict.confidence,
          text: `Verifier: not the same object — ${verdict.reason ?? 'look-alike'}`,
        });
        if (this.verifyFailStreak >= 2) {
          this.modelBox = null;
          this.modelAt = 0;
          this.backdateSeen(DETECTION.occludedAfterMs);
        }
      }
    } catch {
      /* verification is best-effort; never break tracking because of it */
    }
  }

  /* ── fusion + state machine ── */

  private fuse(now: number, modelFresh: boolean, acquireConfidence: number): void {
    const sinceSeen = this.lastSeenMono === null ? Infinity : now - this.lastSeenMono;
    const decay = Math.exp((-Math.LN2 * (this.lastSeenMono === null ? 9999 : sinceSeen)) / DETECTION.decayHalfLifeMs);

    const modelConfNow = modelFresh ? this.modelConf : this.modelConf * decay;
    const localConfNow = this.localConf;
    this.stats.modelConfidence = modelConfNow;

    // Position: prefer a verified model box, refined continuously by ZNCC.
    let target: BBox | null = this.displayBox;

    if (modelConfNow >= Math.max(0.3, acquireConfidence * 0.6)) {
      target = this.localConf > 0.45 && this.localBox ? this.localBox : (this.modelBox ?? this.displayBox);
    } else if (this.localConf > 0.45 && this.localBox) {
      target = this.localBox;
    }

    if (target) {
      const alpha = this.localConf > 0.45 || modelFresh ? 0.5 : 0.22;
      this.displayBox = this.displayBox ? lerpBox(this.displayBox, target, alpha) : clampBox(target);
    }

    const confidence = Math.max(
      modelConfNow * (this.verifyConf > 0 ? 1 : 0.92),
      localConfNow * (modelFresh ? 1 : 0.85),
      this.verifyConf * 0.98,
    );
    const effectiveConfidence = sinceSeen === Infinity ? 0 : Math.max(0, confidence * decay);

    const next = this.nextState(effectiveConfidence, sinceSeen, acquireConfidence);
    if (next !== this.state) this.transition(next, effectiveConfidence);
  }

  private nextState(confidence: number, sinceSeen: number, acquireConfidence: number): TrackerState {
    if (this.paused) return 'paused';
    if (!this.profile) return 'idle';
    if (confidence >= acquireConfidence && this.displayBox) return 'locked';
    if (this.displayBox && sinceSeen < DETECTION.occludedAfterMs) return 'acquiring';
    if (this.displayBox && sinceSeen < DETECTION.lostAfterMs) return 'occluded';
    if (this.state === 'locked' || this.state === 'occluded') return 'lost';
    return this.hadLock ? 'lost' : 'searching';
  }

  private transition(next: TrackerState, confidence: number): void {
    const previous = this.state;
    this.state = next;

    if (next === 'locked') {
      const message = previous === 'locked' ? '' : 'Locked on target';
      if (message) {
        if (this.hadLock && (previous === 'occluded' || previous === 'lost')) {
          this.maybeEvent('reacquired', 'Target re-acquired', 'Found it again — there it is.');
        } else {
          this.maybeEvent('acquired', 'Target acquired', 'Found it! The box on screen is your object.');
        }
      }
      this.hadLock = true;
      return;
    }

    if (next === 'occluded' && (previous === 'locked' || previous === 'acquiring')) {
      this.maybeEvent('occluded', 'Temporarily lost', 'Hold on, I lost sight of it. Move the camera back slowly.');
      this.pushObservation({ kind: 'local', tone: 'warn', text: 'Line of sight lost — holding the last known position' });
      return;
    }

    if (next === 'lost' && (previous === 'locked' || previous === 'occluded' || previous === 'acquiring')) {
      this.maybeEvent('lost', 'Target lost', 'Lost it — pan around the room slowly and I will tell you when I see it.');
      this.displayBox = null;
      this.pushObservation({ kind: 'local', tone: 'warn', text: `Target lost at ${Math.round(confidence * 100)}% confidence` });
    }
  }

  private static readonly EVENT_COOLDOWN_MS: Record<EngineEvent['type'], number> = {
    'model-visible': 9000,
    'model-absent': 9000,
    acquired: 2500,
    reacquired: 2500,
    occluded: 4000,
    lost: 4000,
    hint: 6000,
    error: 6000,
  };

  private maybeEvent(type: EngineEvent['type'], message: string, speak?: string): void {
    const now = this.now();
    const cooldown = VisionEngine.EVENT_COOLDOWN_MS[type] ?? 4000;
    const last = this.lastEventAt[type] ?? Number.NEGATIVE_INFINITY;
    if (now - last < cooldown) return;
    this.lastEventAt[type] = now;
    this.deps.onEvent({ type, message, speak });
  }

  private pushObservation(input: Omit<Observation, 'id' | 'at'> & { at?: number }): void {
    const now = this.now();
    if (now - this.lastObservationAt < 1200) return;
    this.lastObservationAt = now;
    this.deps.onObservation({
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      at: Date.now(),
      kind: input.kind,
      text: input.text,
      confidence: input.confidence,
      tone: input.tone,
    });
  }

  private lastObservationAt = Number.NEGATIVE_INFINITY;

  /* ── external (voice model / user) input ── */

  /**
   * Feeds a status observation coming from the Gemini Live session (the model
   * looks at streamed video and reports visible/not-visible + guidance).
   */
  pushExternal(observation: ExternalObservation): void {
    const now = this.now();
    if (observation.visible && observation.confidence >= DETECTION.lowConfidence) {
      this.modelSeesTarget = true;
      this.absentStreak = 0;
      if (observation.box && observation.confidence >= DETECTION.lowConfidence) {
        const jumpIsSuspicious =
          this.displayBox !== null && iou(this.displayBox, observation.box) < 0.05 && observation.confidence < 0.8;
        if (!jumpIsSuspicious) {
          this.modelBox = clampBox(observation.box);
          this.modelConf = Math.max(this.modelConf, observation.confidence);
          this.modelAt = now;
          this.markSeen();
          this.displayBox = this.displayBox ? lerpBox(this.displayBox, this.modelBox, 0.6) : this.modelBox;
        }
      } else {
        // Presence without a position: refresh the clock gently, don't move the box.
        this.modelConf = Math.min(0.9, Math.max(this.modelConf, observation.confidence * 0.8));
        this.modelAt = Math.max(this.modelAt, now - 400);
        if (this.localConf > 0.4) this.markSeen();
      }
      if (observation.reason) this.lastReason = observation.reason;
      return;
    }

    this.modelSeesTarget = false;
    this.absentStreak += 1;
    if (observation.reason) this.lastReason = observation.reason;
    if (this.absentStreak >= 2 && this.localConf < 0.45 && this.displayBox) {
      // Two independent "not visible" verdicts while the local matcher is weak:
      // start the occlusion clock honestly.
      this.backdateSeen(DETECTION.occludedAfterMs);
    }
  }

  /* ── snapshots / helpers ── */

  snapshot(): EngineSnapshot {
    return {
      state: this.state,
      box: this.state === 'paused' || this.state === 'idle' ? null : this.displayBox,
      rawBox: this.modelBox,
      confidence: this.stats.modelConfidence,
      source: this.determineSource(),
      lastSeenAt: this.lastSeenAt,
      lastReason: this.lastReason,
      modelSeesTarget: this.modelSeesTarget,
      stats: { ...this.stats },
    };
  }

  private determineSource(): EvidenceSource {
    if (this.localConf > 0.45 && this.modelConf > 0.3) return 'fused';
    if (this.localConf > 0.45) return 'local';
    if (this.modelConf > 0.3) return 'gemini-frame';
    return 'none';
  }

  private emitSnapshot(): void {
    this.deps.onSnapshot(this.snapshot());
  }

  /** Guidance text for the current situation — used by voice + status panel. */
  guidance(snapshot = this.snapshot()): string {
    const profile = this.profile;
    switch (snapshot.state) {
      case 'locked':
        return 'Target locked — hold the camera steady.';
      case 'acquiring':
        return 'Possible match in view — move closer or hold still.';
      case 'occluded':
        return 'Temporarily lost — back up slowly to the last spot.';
      case 'lost':
        return profile?.sceneGuidance || 'Pan slowly around the room, one direction at a time.';
      case 'paused':
        return 'Search paused.';
      default:
        return profile?.sceneGuidance || 'Point the camera at the room and move slowly.';
    }
  }
}

/** Local, non-model guidance cues for the assistant (used when voice is degraded). */
export function buildCues(snapshot: EngineSnapshot, profile: TargetProfile | null): string[] {
  const cues: string[] = [];
  if (snapshot.state === 'searching') {
    cues.push(`Scanning for ${profile?.name ?? 'the target'}. ${profile?.sceneGuidance ?? ''}`.trim());
    cues.push('Move the camera slowly, left to right.');
  }
  if (snapshot.state === 'acquiring') cues.push('Something similar is in frame — hold still for a second.');
  if (snapshot.state === 'occluded') cues.push('Hold on, I lost sight of it — go back to where it was.');
  if (snapshot.state === 'lost') cues.push('Lost it. Try a slower sweep, or get closer to the shelf/table.');
  if (snapshot.state === 'locked' && snapshot.box) {
    const cx = snapshot.box.x + snapshot.box.width / 2;
    cues.push(cx < 0.3 ? 'It is on the left side of the frame.' : cx > 0.7 ? 'It is on the right side of the frame.' : 'It is right in the middle of the frame.');
  }
  return cues;
}

export { znccToConfidence };
