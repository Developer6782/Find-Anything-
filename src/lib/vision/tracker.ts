import type { BBox } from '../contracts';
import {
  type AnchorTemplate,
  type BestMatch,
  matchBest,
  matchInBox,
  templateVariants,
} from './matcher';
import { type GrayImage, type IntegralImage, cropGray, integralImage, resizeGray } from './imageOps';
import { clampBox, expandBox } from './bbox';

export interface TrackOutcome {
  /** Raw ZNCC score of the best anchor (-1 when no match was attempted). */
  score: number;
  secondBest: number;
  /** Normalized box estimate in the *working image* frame. */
  box: BBox | null;
  /** 0..1 confidence derived from the ZNCC score. */
  confidence: number;
  anchorLabel: string | null;
}

const NO_MATCH: TrackOutcome = {
  score: -1,
  secondBest: -1,
  box: null,
  confidence: 0,
  anchorLabel: null,
};

/** ZNCC → confidence mapping (empirical: <0.35 is noise, >0.72 is a solid lock). */
export function znccToConfidence(score: number): number {
  if (!Number.isFinite(score)) return 0;
  const lo = 0.35;
  const hi = 0.72;
  return Math.max(0, Math.min(1, (score - lo) / (hi - lo)));
}

function boxFromMatch(match: BestMatch, image: GrayImage): BBox {
  return clampBox({
    x: match.x / image.width,
    y: match.y / image.height,
    width: match.width / image.width,
    height: match.height / image.height,
  });
}

/** Global re-acquisition is throttled — the workspace is re-scanned slowly. */
const GLOBAL_SCAN_INTERVAL_MS = 250;
/** Above this ZNCC score the ROI result is trusted without a global check. */
const CONFIDENT_SCORE = 0.62;
const COARSE_WIDTH = 110;

/**
 * On-device object tracker.
 *
 * Anchors come from the reference photo (object patch + tighter core patch).
 * With a prior box the search is restricted to a ROI (cheap, ~1-3 ms/frame);
 * without one it falls back to a throttled coarse→fine full-frame scan. This
 * runs at video cadence and keeps the box glued to the object *between* the
 * model's localisations.
 */
export class ObjectTracker {
  private anchors: AnchorTemplate[] = [];
  private lastGlobalAt = 0;
  private lastGlobalOutcome: TrackOutcome = NO_MATCH;

  setAnchors(anchors: AnchorTemplate[]): void {
    this.anchors = anchors;
    this.lastGlobalAt = 0;
    this.lastGlobalOutcome = NO_MATCH;
  }

  get anchorCount(): number {
    return this.anchors.length;
  }

  clear(): void {
    this.setAnchors([]);
  }

  /**
   * Tracks the target inside `gray`. `predicted` is the previous display box.
   *
   * A confident ROI hit is returned directly. Anything weaker is cross-checked
   * with a throttled full-frame sweep — a mediocre local match must never win
   * over a correct global one (that is exactly how a box ends up "drifting").
   */
  track(gray: GrayImage, predicted: BBox | null): TrackOutcome {
    if (!this.anchors.length) return NO_MATCH;
    if (gray.width < 24 || gray.height < 24) return NO_MATCH;

    const integral: IntegralImage = integralImage(gray);

    let local: TrackOutcome | null = null;
    if (predicted) {
      // 2.6× the previous box: tolerant of fast pans without scanning the room.
      const roi = expandBox(predicted, 2.6);
      const roiBox = {
        x: Math.floor(roi.x * gray.width),
        y: Math.floor(roi.y * gray.height),
        width: Math.ceil(roi.width * gray.width),
        height: Math.ceil(roi.height * gray.height),
      };
      const expectedWidth = Math.max(10, Math.round(predicted.width * gray.width * 0.92));
      local = this.matchAnchors(gray, integral, roiBox, expectedWidth);
      if (local && local.score >= CONFIDENT_SCORE) return local;
    }

    const global = this.globalSearchThrottled(gray, integral);
    if (!local || !local.box) return global;
    if (!global.box) return local;
    return global.score > local.score ? global : local;
  }

  private globalSearchThrottled(gray: GrayImage, integral: IntegralImage): TrackOutcome {
    const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
    if (now - this.lastGlobalAt < GLOBAL_SCAN_INTERVAL_MS) return this.lastGlobalOutcome;
    this.lastGlobalAt = now;
    const outcome = this.globalSearch(gray, integral);
    this.lastGlobalOutcome = outcome;
    return outcome;
  }

  /** Refines a model-provided box: the model's answer is used as a prior only. */
  refine(gray: GrayImage, priorBox: BBox): TrackOutcome | null {
    if (!this.anchors.length || gray.width < 24 || gray.height < 24) return null;
    const integral = integralImage(gray);
    const roi = expandBox(priorBox, 2.4);
    const roiBox = {
      x: Math.floor(roi.x * gray.width),
      y: Math.floor(roi.y * gray.height),
      width: Math.ceil(roi.width * gray.width),
      height: Math.ceil(roi.height * gray.height),
    };
    const expectedWidth = Math.max(10, Math.round(priorBox.width * gray.width * 0.92));
    return this.matchAnchors(gray, integral, roiBox, expectedWidth);
  }

  private matchAnchors(
    gray: GrayImage,
    integral: IntegralImage,
    roiBox: { x: number; y: number; width: number; height: number },
    targetWidthPx: number,
  ): TrackOutcome | null {
    let best: TrackOutcome | null = null;
    for (const anchor of this.anchors) {
      const match = matchInBox(gray, integral, anchor.template, roiBox, targetWidthPx);
      if (!match) continue;
      if (!best || match.score > best.score) {
        best = {
          score: match.score,
          secondBest: match.secondBest,
          box: boxFromMatch(match, gray),
          confidence: znccToConfidence(match.score),
          anchorLabel: anchor.label,
        };
      }
    }
    return best;
  }

  private globalSearch(gray: GrayImage, integral: IntegralImage): TrackOutcome {
    // Coarse pass on a small copy of the frame, then refine at working scale.
    const scale = Math.min(1, COARSE_WIDTH / gray.width);
    const small = scale < 1 ? resizeGray(gray, Math.round(gray.width * scale), Math.round(gray.height * scale)) : gray;
    const smallIntegral = small === gray ? integral : integralImage(small);

    let best: { match: BestMatch; anchor: AnchorTemplate } | null = null;
    for (const anchor of this.anchors) {
      const match = matchBest(small, smallIntegral, templateVariants(anchor.template));
      if (!match) continue;
      if (!best || match.score > best.match.score) best = { match, anchor };
    }
    if (!best) return NO_MATCH;

    // Map the coarse hit back to the working frame and refine there.
    const coarseBoxPx = {
      x: (best.match.x / small.width) * gray.width,
      y: (best.match.y / small.height) * gray.height,
      width: (best.match.width / small.width) * gray.width,
      height: (best.match.height / small.height) * gray.height,
    };
    const pad = 8;
    const refineBox = {
      x: Math.max(0, Math.floor(coarseBoxPx.x - pad)),
      y: Math.max(0, Math.floor(coarseBoxPx.y - pad)),
      width: Math.ceil(coarseBoxPx.width + pad * 2),
      height: Math.ceil(coarseBoxPx.height + pad * 2),
    };
    const refined = this.matchAnchors(gray, integral, refineBox, Math.round(coarseBoxPx.width));
    if (refined && refined.score >= best.match.score - 0.08) {
      return { ...refined, anchorLabel: refined.anchorLabel ?? best.anchor.label };
    }

    const coarseOutcome: TrackOutcome = {
      score: best.match.score,
      secondBest: best.match.secondBest,
      box: clampBox({
        x: best.match.x / small.width,
        y: best.match.y / small.height,
        width: best.match.width / small.width,
        height: best.match.height / small.height,
      }),
      confidence: znccToConfidence(best.match.score),
      anchorLabel: best.anchor.label,
    };
    return coarseOutcome;
  }
}

/** Helper used in tests/debugging: cut a patch around a box. */
export function patchFor(gray: GrayImage, box: BBox): GrayImage {
  const rect = {
    x: Math.floor(box.x * gray.width),
    y: Math.floor(box.y * gray.height),
    w: Math.ceil(box.width * gray.width),
    h: Math.ceil(box.height * gray.height),
  };
  return cropGray(gray, rect.x, rect.y, rect.w, rect.h);
}
