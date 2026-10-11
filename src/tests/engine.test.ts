import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { VisionEngine, type EngineEvent, type EngineSnapshot, type Observation } from '../lib/vision/engine';
import type { DetectResponse, TargetProfile } from '../../shared/types';
import type { CapturedJpeg } from '../lib/vision/frames';
import type { GrayImage } from '../lib/vision/imageOps';

/* ── deterministic harness: manual clock + manual animation frames ───────── */

let rafQueue: FrameRequestCallback[] = [];

beforeEach(() => {
  rafQueue = [];
  (globalThis as any).requestAnimationFrame = (cb: FrameRequestCallback) => {
    rafQueue.push(cb);
    return rafQueue.length;
  };
  (globalThis as any).cancelAnimationFrame = () => undefined;
});

afterEach(() => {
  delete (globalThis as any).requestAnimationFrame;
  delete (globalThis as any).cancelAnimationFrame;
});

class FakeClock {
  t = 0;
  now = () => this.t;
  advance(ms: number) {
    this.t += ms;
  }
}

const PROFILE: TargetProfile = {
  name: 'blue mug',
  category: 'drinkware',
  attributes: [{ key: 'colour', value: 'blue', distinctiveness: 'high' }],
  distinguishingColors: ['blue'],
  targetBBox: { x: 0.3, y: 0.3, width: 0.4, height: 0.4 },
  descriptors: ['blue ceramic', 'white rim'],
  sceneGuidance: 'Pan slowly across the shelf.',
  searchHint: 'Scanning for the blue mug',
  ambiguityRisks: ['other mugs'],
};

const GRAY: GrayImage = { width: 64, height: 48, data: new Float32Array(64 * 48) };
const JPEG: CapturedJpeg = { base64: 'AAAA', mimeType: 'image/jpeg', width: 640, height: 360 };
const VIDEO = { readyState: 3, videoWidth: 1280, videoHeight: 720 } as unknown as HTMLVideoElement;

const BOX_A = { x: 0.4, y: 0.35, width: 0.2, height: 0.25 };

function lockResponse(): DetectResponse {
  return {
    visible: true,
    confidence: 0.86,
    bbox: { ...BOX_A },
    reason: 'mug left of the keyboard',
    model: 'test-model',
    latencyMs: 180,
  };
}

function absentResponse(): DetectResponse {
  return { visible: false, confidence: 0.15, bbox: null, reason: 'not in frame', model: 'test-model', latencyMs: 140 };
}

function harness(script: (call: number) => DetectResponse) {
  const clock = new FakeClock();
  let calls = 0;
  const snapshots: EngineSnapshot[] = [];
  const events: EngineEvent[] = [];
  const observations: Observation[] = [];

  const engine = new VisionEngine({
    detect: async () => script(calls++),
    onSnapshot: (snapshot) => snapshots.push(snapshot),
    onObservation: (observation) => observations.push(observation),
    onEvent: (event) => events.push(event),
    settings: () => ({ detectFps: 4, acquireConfidence: 0.55, verifyEnabled: false }),
    frames: {
      captureGray: () => GRAY,
      captureJpeg: () => JPEG,
    },
    now: clock.now,
  });

  engine.setProfile(PROFILE, []);
  engine.start(VIDEO);

  const settle = async () => {
    for (let i = 0; i < 5; i += 1) await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
  };

  const advance = async (ms: number, stepMs = 60) => {
    for (let elapsed = 0; elapsed < ms; elapsed += stepMs) {
      clock.advance(stepMs);
      const queued = rafQueue;
      rafQueue = [];
      for (const cb of queued) cb(clock.t);
      await settle();
    }
  };

  return { engine, clock, snapshots, events, observations, advance, calls: () => calls };
}

/* ── tests ───────────────────────────────────────────────────────────────── */

describe('VisionEngine tracking state machine', () => {
  it('locks on a confident model localisation and keeps a stable box', async () => {
    const h = harness(() => lockResponse());
    await h.advance(500);

    const latest = h.snapshots.at(-1)!;
    expect(latest.state).toBe('locked');
    expect(latest.box).not.toBeNull();
    expect(latest.box!.x).toBeGreaterThan(0.3);
    expect(latest.box!.width).toBeCloseTo(BOX_A.width, 1);
    expect(latest.stats.modelCalls).toBeGreaterThan(0);
    expect(h.events.some((event) => event.type === 'acquired')).toBe(true);
  });

  it('never invents a box when the model says "visible" but returns no coordinates', async () => {
    const h = harness(() => ({
      visible: true,
      confidence: 0.9,
      bbox: null,
      reason: 'I think it is somewhere here',
      model: 'test-model',
      latencyMs: 200,
    }));
    await h.advance(800);

    const latest = h.snapshots.at(-1)!;
    expect(latest.box).toBeNull();
    expect(latest.state).not.toBe('locked');
    expect(latest.modelSeesTarget).toBe(true);
    expect(h.observations.some((o) => /position unclear/i.test(o.text))).toBe(true);
  });

  it('never draws a box for a low-confidence guess', async () => {
    const h = harness(() => ({
      visible: true,
      confidence: 0.2,
      bbox: { x: 0.1, y: 0.1, width: 0.1, height: 0.1 },
      reason: 'maybe',
      model: 'test-model',
      latencyMs: 120,
    }));
    await h.advance(800);
    expect(h.snapshots.at(-1)!.box).toBeNull();
  });

  it('goes "temporarily lost" then "lost" when the object leaves the frame', async () => {
    let phase: 'lock' | 'absent' = 'lock';
    const h = harness(() => (phase === 'lock' ? lockResponse() : absentResponse()));

    await h.advance(400);
    expect(h.snapshots.at(-1)!.state).toBe('locked');

    phase = 'absent';
    await h.advance(1500);
    const occluded = h.snapshots.at(-1)!;
    expect(occluded.state).toBe('occluded');
    expect(occluded.box).not.toBeNull(); // last known position is held
    expect(h.events.some((event) => event.type === 'occluded')).toBe(true);

    await h.advance(4500);
    const lost = h.snapshots.at(-1)!;
    expect(lost.state).toBe('lost');
    expect(lost.box).toBeNull();
    expect(lost.confidence).toBeLessThan(0.2);
    expect(h.events.some((event) => event.type === 'lost')).toBe(true);
  });

  it('re-acquires after occlusion and reports the transition', async () => {
    let visible = true;
    const h = harness(() => (visible ? lockResponse() : absentResponse()));

    await h.advance(300);
    visible = false;
    await h.advance(4800); // through occluded → lost
    expect(h.snapshots.at(-1)!.state).toBe('lost');

    visible = true;
    await h.advance(700);
    const latest = h.snapshots.at(-1)!;
    expect(latest.state).toBe('locked');
    expect(h.events.some((event) => event.type === 'reacquired')).toBe(true);
  });

  it('ignores a suspicious jump to a different region of the frame', async () => {
    let jump = false;
    const h = harness(() =>
      jump
        ? {
            visible: true,
            confidence: 0.62,
            bbox: { x: 0.02, y: 0.02, width: 0.12, height: 0.12 },
            reason: 'maybe another mug',
            model: 'test-model',
            latencyMs: 150,
          }
        : lockResponse(),
    );

    await h.advance(400);
    const locked = h.snapshots.at(-1)!;
    expect(locked.state).toBe('locked');

    jump = true;
    await h.advance(900);
    const after = h.snapshots.at(-1)!;
    // The box must not teleport to the far corner on a medium-confidence claim.
    expect(after.box!.x).toBeGreaterThan(0.25);
  });

  it('pauses and resumes without losing the lock', async () => {
    const h = harness(() => lockResponse());
    await h.advance(400);
    h.engine.pause();
    await h.advance(200);
    expect(h.snapshots.at(-1)!.state).toBe('paused');
    expect(h.snapshots.at(-1)!.box).toBeNull(); // nothing is drawn while paused

    h.engine.resume();
    await h.advance(400);
    expect(h.snapshots.at(-1)!.state).toBe('locked');
  });

  it('accepts live-model presence signals without moving the box (no coordinates from voice)', async () => {
    const h = harness(() => absentResponse());
    await h.advance(300);
    expect(h.snapshots.at(-1)!.box).toBeNull();

    h.engine.pushExternal({ source: 'gemini-live', visible: true, confidence: 0.8, reason: 'I can see the mug', box: null });
    await h.advance(200);
    const snapshot = h.snapshots.at(-1)!;
    expect(snapshot.modelSeesTarget).toBe(true);
    expect(snapshot.box).toBeNull(); // presence is not a position
  });

  it('records observations and stops cleanly', async () => {
    const h = harness(() => lockResponse());
    await h.advance(400);
    expect(h.observations.length).toBeGreaterThan(0);
    h.engine.stop();
    expect(h.snapshots.at(-1)!.state).toBe('idle');
  });
});
