import { type GrayImage, type IntegralImage, cropGray, resizeGray, windowStats } from './imageOps';

/**
 * Zero-mean normalized cross correlation (ZNCC) template matching.
 *
 * Gemini is good at "roughly where", not at "pixel-exact, frame-stable". This
 * module turns its answer into a glued box: the reference photo gives us a
 * template, ZNCC finds it in the live frame at video rate, and the model's box
 * is used as a prior for where to look.
 *
 * Two details matter for real accuracy:
 *  1. Templates are kept as *source pixels* and re-rendered at the pixel size the
 *     object is expected to occupy in the working frame. Matching a downscaled
 *     template against a full-resolution window destroys correlation because the
 *     effective blur differs, so scale is always resolved explicitly.
 *  2. Scores are illumination invariant (mean/variance normalized), which is what
 *     makes the same object match under different lighting.
 *
 * Score range [-1, 1]: 1 = identical structure, ~0 = unrelated.
 */

export interface Template {
  /** Source patch pixels (max side capped), used to render size variants. */
  source: Float32Array;
  sourceWidth: number;
  sourceHeight: number;
  /** width / height of the source patch. */
  aspect: number;
  label: string;
}

/** A mean-centred, ready-to-match rendering of a template at a pixel size. */
export interface PreparedTemplate {
  data: Float32Array;
  width: number;
  height: number;
  /** Σ(t - mean)² */
  ssd: number;
  mean: number;
  label: string;
}

export interface MatchResult {
  score: number;
  /** Top-left of the match in image pixels. */
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface SearchRegion {
  /** Bounds in which the template's TOP-LEFT corner may move (image pixels). */
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface AnchorTemplate {
  template: Template;
  /** Normalized box of this anchor inside the reference photo. */
  sourceBox: { x: number; y: number; width: number; height: number };
  label: string;
}

const DEFAULT_MAX_SOURCE_SIDE = 48;
const MIN_PATTERN_SIDE = 8;
const MAX_PATTERN_SIDE = 160;

/** Default size ratios explored when the object's apparent size is unknown. */
export const DEFAULT_RATIOS = [0.45, 0.62, 0.8, 1];

export function buildTemplate(patch: GrayImage, label: string, maxSide = DEFAULT_MAX_SOURCE_SIDE): Template | null {
  if (patch.width < 6 || patch.height < 6) return null;
  const scale = Math.min(1, maxSide / Math.max(patch.width, patch.height));
  const resized = scale < 1 ? resizeGray(patch, patch.width * scale, patch.height * scale) : patch;

  let mean = 0;
  for (let i = 0; i < resized.data.length; i += 1) mean += resized.data[i];
  mean /= resized.data.length;
  let variance = 0;
  for (let i = 0; i < resized.data.length; i += 1) {
    const d = resized.data[i] - mean;
    variance += d * d;
  }
  if (variance / resized.data.length < 1) return null; // flat patch: nothing to match

  return {
    source: resized.data.slice(),
    sourceWidth: resized.width,
    sourceHeight: resized.height,
    aspect: resized.width / resized.height,
    label,
  };
}

/** Renders a template at a specific pixel size, mean-centred for ZNCC. */
export function prepareTemplate(template: Template, width: number, height: number): PreparedTemplate | null {
  const w = Math.round(Math.min(MAX_PATTERN_SIDE, Math.max(MIN_PATTERN_SIDE, width)));
  const h = Math.round(Math.min(MAX_PATTERN_SIDE, Math.max(MIN_PATTERN_SIDE, height)));
  const source: GrayImage = {
    width: template.sourceWidth,
    height: template.sourceHeight,
    data: template.source,
  };
  const resized = w === template.sourceWidth && h === template.sourceHeight ? source : resizeGray(source, w, h);

  const n = resized.width * resized.height;
  let mean = 0;
  for (let i = 0; i < n; i += 1) mean += resized.data[i];
  mean /= n;
  const data = new Float32Array(n);
  let ssd = 0;
  for (let i = 0; i < n; i += 1) {
    const v = resized.data[i] - mean;
    data[i] = v;
    ssd += v * v;
  }
  if (ssd < 1e-3) return null;
  return { data, width: resized.width, height: resized.height, ssd, mean, label: template.label };
}

/** Size variants used when the object's apparent size is unknown. */
export function templateVariants(template: Template, ratios = DEFAULT_RATIOS): PreparedTemplate[] {
  const base = Math.max(template.sourceWidth, template.sourceHeight);
  const out: PreparedTemplate[] = [];
  for (const ratio of ratios) {
    const target = base * ratio;
    const prepared = prepareTemplate(
      template,
      (template.sourceWidth / base) * target,
      (template.sourceHeight / base) * target,
    );
    if (prepared) out.push(prepared);
  }
  // De-duplicate identical pixel sizes.
  return out.filter((variant, index) => out.findIndex((v) => v.width === variant.width) === index);
}

/**
 * Size variants derived from the box we already had — the object's apparent
 * size in the frame only changes slowly, so this is both cheaper and sharper
 * than an open-ended scale search.
 */
export function variantsForBox(template: Template, boxWidthPx: number): PreparedTemplate[] {
  const target = Math.max(MIN_PATTERN_SIDE, boxWidthPx);
  // A 5-step ladder: the tracked apparent size drifts by ~±20% between frames
  // (distance changes, IPD, model error), so neighbouring sizes must be close.
  const heights = [0.8, 0.9, 1, 1.12, 1.25];
  const out: PreparedTemplate[] = [];
  for (const factor of heights) {
    const width = target * factor;
    const prepared = prepareTemplate(template, width, width / template.aspect);
    if (prepared) out.push(prepared);
  }
  return out.filter((variant, index) => out.findIndex((v) => v.width === variant.width) === index);
}

/** Search region derived from a pixel box, so a template can slide inside it. */
export function regionForBox(
  box: { x: number; y: number; width: number; height: number },
  templateWidth: number,
  templateHeight: number,
): SearchRegion {
  return {
    x: box.x,
    y: box.y,
    width: Math.max(1, box.width - templateWidth),
    height: Math.max(1, box.height - templateHeight),
  };
}

/** Core ZNCC scan of one prepared template inside a region. */
export function matchTemplate(
  image: GrayImage,
  integral: IntegralImage,
  template: PreparedTemplate,
  region: SearchRegion,
  step = 1,
): MatchResult | null {
  const tw = template.width;
  const th = template.height;
  if (image.width < tw || image.height < th) return null;

  const xStart = Math.max(0, Math.floor(region.x));
  const yStart = Math.max(0, Math.floor(region.y));
  const xEnd = Math.min(image.width - tw, Math.ceil(region.x + region.width - 1));
  const yEnd = Math.min(image.height - th, Math.ceil(region.y + region.height - 1));
  if (xEnd < xStart || yEnd < yStart) return null;

  const stride = image.width;
  const px = image.data;
  const td = template.data;
  let bestScore = -Infinity;
  let bestX = xStart;
  let bestY = yStart;

  for (let y = yStart; y <= yEnd; y += step) {
    for (let x = xStart; x <= xEnd; x += step) {
      const stats = windowStats(integral, x, y, tw, th);
      if (stats.ssd < 1e-3) continue; // flat window cannot match
      let cross = 0;
      for (let ty = 0; ty < th; ty += 1) {
        const srcRow = (y + ty) * stride + x;
        const tplRow = ty * tw;
        for (let tx = 0; tx < tw; tx += 1) {
          cross += px[srcRow + tx] * td[tplRow + tx];
        }
      }
      const score = cross / Math.sqrt(stats.ssd * template.ssd);
      if (score > bestScore) {
        bestScore = score;
        bestX = x;
        bestY = y;
      }
    }
  }
  if (!Number.isFinite(bestScore)) return null;
  return { score: bestScore, x: bestX, y: bestY, width: tw, height: th };
}

export interface BestMatch extends MatchResult {
  template: PreparedTemplate;
  /** Score of the runner-up variant — useful for diagnostics. */
  secondBest: number;
}

/**
 * Coarse-to-fine match of a template across size variants: each variant is
 * scanned with a step of 2, then only the winner is refined at step 1.
 */
export function matchBest(
  image: GrayImage,
  integral: IntegralImage,
  variants: PreparedTemplate[],
): BestMatch | null {
  let best: BestMatch | null = null;
  let secondBest = -1;

  for (const variant of variants) {
    const region: SearchRegion = {
      x: 0,
      y: 0,
      width: image.width,
      height: image.height,
    };
    if (region.width < variant.width || region.height < variant.height) continue;
    const coarse = matchTemplate(image, integral, variant, region, 2);
    if (!coarse) continue;
    const refined = matchTemplate(image, integral, variant, {
      x: coarse.x - 2,
      y: coarse.y - 2,
      width: 5,
      height: 5,
    });
    const winner = refined && refined.score > coarse.score ? refined : coarse;
    if (!best || winner.score > best.score) {
      if (best) secondBest = best.score;
      best = { ...winner, template: variant, secondBest };
    } else if (winner.score > secondBest) {
      secondBest = winner.score;
    }
  }
  if (!best) return null;
  return { ...best, secondBest };
}

/**
 * Matches a template inside an explicit pixel box (ROI tracking path).
 *
 * `searchBox` is where the template may slide; `targetWidthPx` is how wide the
 * object is expected to look *in this frame*. Keeping them separate matters:
 * the search region is deliberately padded (~2× the object) and using its width
 * as the template size would make every match twice too large.
 */
export function matchInBox(
  image: GrayImage,
  integral: IntegralImage,
  template: Template,
  searchBox: { x: number; y: number; width: number; height: number },
  targetWidthPx: number,
): BestMatch | null {
  const box = searchBox;
  const variants = variantsForBox(template, targetWidthPx);
  let best: BestMatch | null = null;
  let secondBest = -1;

  for (const variant of variants) {
    const region = regionForBox(box, variant.width, variant.height);
    if (region.width < 1 || region.height < 1) continue;
    // Coarse step then a local refine keeps the ROI path ~1-2 ms per frame.
    const coarse = matchTemplate(image, integral, variant, region, 2);
    if (!coarse) continue;
    const refined = matchTemplate(image, integral, variant, {
      x: coarse.x - 1,
      y: coarse.y - 1,
      width: 3,
      height: 3,
    });
    const winner = refined && refined.score > coarse.score ? refined : coarse;
    if (!best || winner.score > best.score) {
      if (best) secondBest = best.score;
      best = { ...winner, template: variant, secondBest };
    } else if (winner.score > secondBest) {
      secondBest = winner.score;
    }
  }
  if (!best) return null;
  return { ...best, secondBest };
}

/**
 * Builds anchor templates from the reference photo: the whole object plus a
 * tighter "core" patch that still matches when the object is partly occluded.
 */
export function buildAnchors(
  referenceGray: GrayImage,
  objectBox: { x: number; y: number; width: number; height: number },
): AnchorTemplate[] {
  const anchors: AnchorTemplate[] = [];
  const rect = {
    x: Math.floor(objectBox.x * referenceGray.width),
    y: Math.floor(objectBox.y * referenceGray.height),
    w: Math.ceil(objectBox.width * referenceGray.width),
    h: Math.ceil(objectBox.height * referenceGray.height),
  };

  const full = cropGray(referenceGray, rect.x, rect.y, rect.w, rect.h);
  const fullTemplate = buildTemplate(full, 'object');
  if (fullTemplate) anchors.push({ template: fullTemplate, sourceBox: objectBox, label: 'object' });

  const inner = {
    x: rect.x + Math.floor(rect.w * 0.15),
    y: rect.y + Math.floor(rect.h * 0.15),
    w: Math.max(8, Math.floor(rect.w * 0.7)),
    h: Math.max(8, Math.floor(rect.h * 0.7)),
  };
  const innerPatch = cropGray(referenceGray, inner.x, inner.y, inner.w, inner.h);
  const coreTemplate = buildTemplate(innerPatch, 'core');
  if (coreTemplate) {
    anchors.push({
      template: coreTemplate,
      sourceBox: {
        x: inner.x / referenceGray.width,
        y: inner.y / referenceGray.height,
        width: inner.w / referenceGray.width,
        height: inner.h / referenceGray.height,
      },
      label: 'core',
    });
  }
  return anchors;
}
