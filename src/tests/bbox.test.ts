import { describe, expect, it } from 'vitest';
import {
  boxToCropRect,
  boxToPixels,
  clampBox,
  expandBox,
  fittedContentRect,
  iou,
  isDegenerate,
  lerpBox,
} from '../lib/vision/bbox';

describe('normalized box geometry', () => {
  it('clamps boxes into the frame', () => {
    expect(clampBox({ x: -0.2, y: 0.5, width: 0.5, height: 0.9 })).toEqual({
      x: 0,
      y: 0.5,
      width: 0.3,
      height: 0.5,
    });
  });

  it('computes IoU correctly', () => {
    const a = { x: 0, y: 0, width: 1, height: 1 };
    const b = { x: 0.5, y: 0.5, width: 0.5, height: 0.5 };
    expect(iou(a, b)).toBeCloseTo(0.25 / 1, 5);
    expect(iou(a, { x: 2, y: 2, width: 0.1, height: 0.1 })).toBe(0);
  });

  it('expands about the centre and lerps', () => {
    const expanded = expandBox({ x: 0.4, y: 0.4, width: 0.2, height: 0.2 }, 2);
    expect(expanded.width).toBeCloseTo(0.4, 6);
    expect(expanded.x).toBeCloseTo(0.3, 6);
    expect(lerpBox({ x: 0, y: 0, width: 0.2, height: 0.2 }, { x: 0.8, y: 0.8, width: 0.2, height: 0.2 }, 0.5).x).toBeCloseTo(0.4, 6);
  });

  it('flags degenerate boxes (tiny / zero / NaN)', () => {
    expect(isDegenerate({ x: 0, y: 0, width: 0, height: 0.5 })).toBe(true);
    expect(isDegenerate({ x: 0.5, y: 0.5, width: 0.002, height: 0.002 })).toBe(true);
    expect(isDegenerate({ x: NaN, y: 0, width: 0.2, height: 0.2 })).toBe(true);
    expect(isDegenerate({ x: 0.1, y: 0.1, width: 0.3, height: 0.3 })).toBe(false);
  });

  it('crops a running box inside image bounds', () => {
    const rect = boxToCropRect({ x: 0.95, y: 0.95, width: 0.1, height: 0.1 }, 640, 480, 0);
    expect(rect.x + rect.w).toBeLessThanOrEqual(640);
    expect(rect.y + rect.h).toBeLessThanOrEqual(480);
    expect(rect.w).toBeGreaterThan(0);
  });
});

describe('box → screen pixel mapping (alignment across viewports)', () => {
  // Two letterboxed cases: landscape phone video in a square container and a
  // portrait video in a wide container (the two shapes that break naive maths).
  const cases = [
    { name: '640×480 in 400×400 (letterbox top/bottom)', media: [640, 480], element: [400, 400] },
    { name: '480×640 in 800×400 (pillarbox left/right)', media: [480, 640], element: [800, 400] },
    { name: '1280×720 in 1280×720 (exact height fill)', media: [1280, 720], element: [1280, 720] },
    { name: '360×640 (portrait phone) in 360×300', media: [360, 640], element: [360, 300] },
  ];

  for (const testCase of cases) {
    it(testCase.name, () => {
      const [mw, mh] = testCase.media;
      const [ew, eh] = testCase.element;
      const content = fittedContentRect(mw, mh, ew, eh);

      // The video must fit inside the element without cropping.
      expect(content.width).toBeLessThanOrEqual(ew + 0.001);
      expect(content.height).toBeLessThanOrEqual(eh + 0.001);
      // Aspect ratio preserved.
      expect(content.width / content.height).toBeCloseTo(mw / mh, 4);

      // A box covering the whole frame maps exactly onto the content rect.
      const full = boxToPixels({ x: 0, y: 0, width: 1, height: 1 }, content);
      expect(full.left).toBeCloseTo(content.left, 6);
      expect(full.top).toBeCloseTo(content.top, 6);
      expect(full.width).toBeCloseTo(content.width, 6);
      expect(full.height).toBeCloseTo(content.height, 6);

      // A centred quarter-size box stays centred and proportional.
      const quarter = boxToPixels({ x: 0.25, y: 0.25, width: 0.5, height: 0.5 }, content);
      expect(quarter.left + quarter.width / 2).toBeCloseTo(content.left + content.width / 2, 4);
      expect(quarter.top + quarter.height / 2).toBeCloseTo(content.top + content.height / 2, 4);
      expect(quarter.width / quarter.height).toBeCloseTo(content.width / content.height, 4);

      // Corner mapping: the box's bottom-right corner must never exceed the media rect.
      expect(quarter.left + quarter.width).toBeLessThanOrEqual(content.left + content.width + 0.001);
    });
  }

  it('is stable at device pixel ratios (fractional element sizes)', () => {
    const content = fittedContentRect(1280, 720, 800.5, 450.25);
    // A box whose centre is at (0.5, 0.5) of the frame must land on the centre of
    // the painted content rect, even with fractional CSS pixel sizes.
    const box = boxToPixels({ x: 0.375, y: 0.375, width: 0.25, height: 0.25 }, content);
    expect(box.left + box.width / 2).toBeCloseTo(content.left + content.width / 2, 3);
    expect(box.top + box.height / 2).toBeCloseTo(content.top + content.height / 2, 3);
  });
});
