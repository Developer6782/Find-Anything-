import { describe, expect, it } from 'vitest';
import { sanitizeBBox } from '../../server/gemini';
import { parseStatusLine } from '../lib/audio/liveSession';

/**
 * Model output is untrusted input: every coordinate form Gemini is documented to
 * use must be normalised to 0..1, and anything degenerate must be rejected so a
 * bogus box is never drawn.
 */
describe('sanitizeBBox (model → normalized box)', () => {
  it('passes through normalized objects', () => {
    const box = sanitizeBBox({ x: 0.1, y: 0.2, width: 0.3, height: 0.4 })!;
    expect(box.x).toBeCloseTo(0.1, 6);
    expect(box.y).toBeCloseTo(0.2, 6);
    expect(box.width).toBeCloseTo(0.3, 6);
    expect(box.height).toBeCloseTo(0.4, 6);
  });

  it('converts the [ymin, xmin, ymax, xmax] 0–1000 form', () => {
    const box = sanitizeBBox([250, 500, 750, 900])!;
    expect(box.x).toBeCloseTo(0.5, 5);
    expect(box.y).toBeCloseTo(0.25, 5);
    expect(box.width).toBeCloseTo(0.4, 5);
    expect(box.height).toBeCloseTo(0.5, 5);
  });

  it('converts 0–1 array form', () => {
    const box = sanitizeBBox([0.25, 0.5, 0.75, 0.9])!;
    expect(box.x).toBeCloseTo(0.5, 5);
    expect(box.height).toBeCloseTo(0.5, 5);
  });

  it('accepts xmin/xmax naming', () => {
    const box = sanitizeBBox({ xmin: 0.2, ymin: 0.3, xmax: 0.6, ymax: 0.7 })!;
    expect(box.x).toBeCloseTo(0.2, 6);
    expect(box.y).toBeCloseTo(0.3, 6);
    expect(box.width).toBeCloseTo(0.4, 6);
    expect(box.height).toBeCloseTo(0.4, 6);
  });

  it('clamps boxes that stick out of the frame', () => {
    const box = sanitizeBBox({ x: -0.2, y: 0.8, width: 1.5, height: 0.5 })!;
    expect(box.x).toBe(0);
    expect(box.y).toBeCloseTo(0.8, 5);
    expect(box.x + box.width).toBeLessThanOrEqual(1);
    expect(box.y + box.height).toBeLessThanOrEqual(1);
  });

  it('rejects degenerate, tiny and malformed boxes', () => {
    expect(sanitizeBBox(null)).toBeNull();
    expect(sanitizeBBox(undefined)).toBeNull();
    expect(sanitizeBBox({})).toBeNull();
    expect(sanitizeBBox({ x: 0.1, y: 0.1, width: 0, height: 0.2 })).toBeNull();
    expect(sanitizeBBox({ x: 0.1, y: 0.1, width: 0.001, height: 0.002 })).toBeNull();
    expect(sanitizeBBox({ x: 'a', y: 0.1, width: 0.2, height: 0.2 })).toBeNull();
    expect(sanitizeBBox([1, 2, 3])).toBeNull();
    expect(sanitizeBBox([Number.NaN, 0, 10, 10])).toBeNull();
  });
});

describe('parseStatusLine (live voice model → structured status)', () => {
  it('parses the JSON status line out of spoken text', () => {
    const parsed = parseStatusLine(
      '{"visible": true, "confidence": 0.82, "reason": "mug on the shelf", "guide": "Hold still", "guessBox": null}',
    )!;
    expect(parsed.visible).toBe(true);
    expect(parsed.confidence).toBeCloseTo(0.82, 5);
    expect(parsed.guide).toBe('Hold still');
    expect(parsed.box).toBeNull();
  });

  it('separates conversational text from the status object', () => {
    const parsed = parseStatusLine(
      'Pan a bit left. {"visible": false, "confidence": 0.2, "reason": "empty wall", "guide": "Keep panning left"}',
    )!;
    expect(parsed.visible).toBe(false);
    expect(parsed.cleaned).toBe('Pan a bit left.');
  });

  it('returns null for plain conversation', () => {
    expect(parseStatusLine('I can see a shelf of mugs, keep going.')).toBeNull();
    expect(parseStatusLine('')).toBeNull();
    expect(parseStatusLine('{ not json }')).toBeNull();
  });

  it('tolerates missing fields without inventing values', () => {
    const parsed = parseStatusLine('{"visible": true}')!;
    expect(parsed.visible).toBe(true);
    expect(parsed.confidence).toBeUndefined();
    expect(parsed.guide).toBeUndefined();
  });
});
