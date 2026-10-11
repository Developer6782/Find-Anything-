import { describe, expect, it } from 'vitest';
import { type GrayImage, cropGray, integralImage, resizeGray } from '../lib/vision/imageOps';
import {
  buildTemplate,
  matchBest,
  matchInBox,
  matchTemplate,
  regionForBox,
  templateVariants,
  prepareTemplate,
} from '../lib/vision/matcher';
import { ObjectTracker, znccToConfidence } from '../lib/vision/tracker';

/** Deterministic pseudo-random noise (no dependency on Math.random). */
function noise(width: number, height: number, seed = 1): GrayImage {
  const data = new Float32Array(width * height);
  let s = seed >>> 0;
  for (let i = 0; i < data.length; i += 1) {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    data[i] = (s >>> 16) % 256;
  }
  return { width, height, data };
}

/** Synthetic "object": a bright disc with a dark ring on a noisy background. */
function sceneWithObject(width: number, height: number, cx: number, cy: number, radius: number, brightness = 1): GrayImage {
  const image = noise(width, height, 7);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const dist = Math.hypot(x - cx, y - cy);
      if (dist < radius * 0.75) image.data[y * width + x] = 210 * brightness;
      else if (dist < radius) image.data[y * width + x] = 40 * brightness;
    }
  }
  return image;
}

describe('ZNCC template matcher', () => {
  it('localises a patch at the exact position', () => {
    const scene = sceneWithObject(160, 120, 90, 60, 24);
    const patch = cropGray(scene, 66, 36, 48, 48);
    const template = buildTemplate(patch, 'test')!;
    const integral = integralImage(scene);
    // A patch rendered at its own size must match itself with ~1.0.
    const prepared = prepareTemplate(template, template.sourceWidth, template.sourceHeight)!;
    const match = matchTemplate(scene, integral, prepared, { x: 0, y: 0, width: 160, height: 120 });
    expect(match).not.toBeNull();
    expect(match!.score).toBeGreaterThan(0.9);
    expect(Math.abs(match!.x - 66)).toBeLessThanOrEqual(2);
    expect(Math.abs(match!.y - 36)).toBeLessThanOrEqual(2);

    // And the full multi-variant search agrees without being told the position.
    const best = matchBest(scene, integral, templateVariants(template));
    expect(best).not.toBeNull();
    expect(Math.abs(best!.x - 66)).toBeLessThanOrEqual(3);
    expect(Math.abs(best!.y - 36)).toBeLessThanOrEqual(3);
  });

  it('survives brightness and contrast changes (different lighting)', () => {
    const reference = sceneWithObject(160, 120, 50, 50, 20, 1);
    const dimmed = sceneWithObject(160, 120, 50, 50, 20, 0.55); // same geometry, darker scene
    const template = buildTemplate(cropGray(reference, 30, 30, 40, 40), 'object')!;
    const integral = integralImage(dimmed);
    const match = matchBest(dimmed, integral, templateVariants(template));
    expect(match!.score).toBeGreaterThan(0.8);
    expect(Math.abs(match!.x - 30)).toBeLessThanOrEqual(3);
  });

  it('scores unrelated patches low', () => {
    const a = noise(120, 90, 3);
    const b = noise(120, 90, 99);
    const template = buildTemplate(cropGray(a, 20, 20, 30, 30), 'noise')!;
    const match = matchBest(b, integralImage(b), templateVariants(template));
    expect(match!.score).toBeLessThan(0.5);
  });

  it('refuses flat patches (no structure to match)', () => {
    const flat: GrayImage = { width: 60, height: 60, data: new Float32Array(3600).fill(128) };
    expect(buildTemplate(cropGray(flat, 10, 10, 30, 30), 'flat')).toBeNull();
  });

  it('finds a smaller-looking object through the multi-scale search', () => {
    const scene = sceneWithObject(200, 150, 140, 80, 26);
    const template = buildTemplate(cropGray(scene, 116, 56, 48, 48), 'object')!;
    const scaled = resizeGray(scene, 160, 120); // object now appears at 0.8× in the frame
    const best = matchBest(scaled, integralImage(scaled), templateVariants(template));
    expect(best).not.toBeNull();
    expect(best!.score).toBeGreaterThan(0.7);
    expect(best!.x).toBeGreaterThan(80);
  });

  it('maps ZNCC scores onto a 0..1 confidence', () => {
    expect(znccToConfidence(0.2)).toBe(0);
    expect(znccToConfidence(0.72)).toBeCloseTo(1, 5);
    expect(znccToConfidence(0.55)).toBeGreaterThan(0.4);
  });

  it('renders size variants from the source pixels (smallest → native)', () => {
    const scene = sceneWithObject(80, 80, 40, 40, 18);
    const template = buildTemplate(cropGray(scene, 24, 24, 32, 32), 'object')!;
    const variants = templateVariants(template);
    expect(variants.length).toBeGreaterThan(1);
    const widths = variants.map((v) => v.width);
    expect(Math.min(...widths)).toBeLessThan(Math.max(...widths));
    expect(Math.max(...widths)).toBeLessThanOrEqual(template.sourceWidth);
    // Variants carry a real variance (mean-centred, non-degenerate).
    for (const variant of variants) expect(variant.ssd).toBeGreaterThan(1);
  });

  it('produces a search region a template can slide inside', () => {
    const region = regionForBox({ x: 10, y: 10, width: 100, height: 80 }, 30, 20);
    expect(region).toEqual({ x: 10, y: 10, width: 70, height: 60 });
  });
});

describe('ObjectTracker', () => {
  it('tracks the object when it moves between frames (ROI path)', () => {
    const first = sceneWithObject(200, 150, 60, 70, 22);
    const moved = sceneWithObject(200, 150, 95, 70, 22);
    const patch = cropGray(first, 38, 48, 44, 44);
    const template = buildTemplate(patch, 'object')!;
    const tracker = new ObjectTracker();
    // Build anchors the same way the app does, from a normalized box.
    tracker.setAnchors([
      { template, sourceBox: { x: 0.19, y: 0.32, width: 0.22, height: 0.29 }, label: 'object' },
    ]);

    const prior = { x: 0.17, y: 0.3, width: 0.26, height: 0.32 };
    const outcome = tracker.track(moved, prior);
    expect(outcome.box).not.toBeNull();
    expect(outcome.score).toBeGreaterThan(0.75);
    // Box should have followed the object to the right.
    expect(outcome.box!.x).toBeGreaterThan(0.35);
  });

  it('re-acquires from scratch without a prior box (global search)', () => {
    const scene = sceneWithObject(200, 150, 130, 90, 24);
    const template = buildTemplate(cropGray(scene, 104, 64, 52, 52), 'object')!;
    const tracker = new ObjectTracker();
    tracker.setAnchors([{ template, sourceBox: { x: 0.5, y: 0.4, width: 0.26, height: 0.34 }, label: 'object' }]);
    const outcome = tracker.track(scene, null);
    expect(outcome.box).not.toBeNull();
    expect(outcome.score).toBeGreaterThan(0.7);
    expect(outcome.box!.x).toBeGreaterThan(0.35);
  });

  it('snaps a model-provided box onto the actual pixels (refine)', () => {
    const scene = sceneWithObject(200, 150, 100, 75, 22);
    const elsewhere = sceneWithObject(200, 150, 100, 75, 22);
    const template = buildTemplate(cropGray(elsewhere, 78, 53, 44, 44), 'object')!;
    const tracker = new ObjectTracker();
    tracker.setAnchors([{ template, sourceBox: { x: 0.39, y: 0.35, width: 0.22, height: 0.29 }, label: 'object' }]);
    // Model box is off by ~10% of the frame; refine should pull it back onto the object.
    const refined = tracker.refine(scene, { x: 0.3, y: 0.3, width: 0.24, height: 0.3 });
    expect(refined).not.toBeNull();
    expect(refined!.score).toBeGreaterThan(0.75);
    expect(Math.abs(refined!.box!.x - 0.39)).toBeLessThan(0.08);
  });

  it('matches inside an explicit box with the ROI helper', () => {
    const scene = sceneWithObject(200, 150, 60, 70, 22);
    const template = buildTemplate(cropGray(scene, 38, 48, 44, 44), 'object')!;
    const match = matchInBox(scene, integralImage(scene), template, { x: 20, y: 30, width: 80, height: 80 }, 44);
    expect(match).not.toBeNull();
    expect(match!.score).toBeGreaterThan(0.8);
    expect(Math.abs(match!.x - 38)).toBeLessThanOrEqual(2);
  });

  it('reports a low score when the object is gone (occlusion)', () => {
    const scene = sceneWithObject(200, 150, 60, 70, 22);
    const patch = cropGray(scene, 38, 48, 44, 44);
    const template = buildTemplate(patch, 'object')!;
    const tracker = new ObjectTracker();
    tracker.setAnchors([{ template, sourceBox: { x: 0.19, y: 0.32, width: 0.22, height: 0.29 }, label: 'object' }]);

    const empty = noise(200, 150, 42);
    const outcome = tracker.track(empty, { x: 0.19, y: 0.32, width: 0.22, height: 0.29 });
    expect(outcome.score).toBeLessThan(0.6);
  });

  it('returns no match without anchors', () => {
    const tracker = new ObjectTracker();
    const scene = sceneWithObject(120, 90, 40, 40, 16);
    const outcome = tracker.track(scene, null);
    expect(outcome.box).toBeNull();
    expect(outcome.score).toBe(-1);
  });
});
