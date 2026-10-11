import type { BBox } from '../contracts';

/** All boxes in this module are normalized: 0..1 with x,y = top-left. */

export function clampBox(box: BBox): BBox {
  const x1 = Math.min(Math.max(box.x, 0), 1);
  const y1 = Math.min(Math.max(box.y, 0), 1);
  const x2 = Math.min(Math.max(box.x + box.width, 0), 1);
  const y2 = Math.min(Math.max(box.y + box.height, 0), 1);
  return { x: x1, y: y1, width: Math.max(0, x2 - x1), height: Math.max(0, y2 - y1) };
}

export function area(box: BBox): number {
  return Math.max(0, box.width) * Math.max(0, box.height);
}

export function center(box: BBox): { x: number; y: number } {
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

export function iou(a: BBox, b: BBox): number {
  const x1 = Math.max(a.x, b.x);
  const y1 = Math.max(a.y, b.y);
  const x2 = Math.min(a.x + a.width, b.x + b.width);
  const y2 = Math.min(a.y + a.height, b.y + b.height);
  if (x2 <= x1 || y2 <= y1) return 0;
  const inter = (x2 - x1) * (y2 - y1);
  const union = area(a) + area(b) - inter;
  return union <= 0 ? 0 : inter / union;
}

/** Scales a box about its own centre (factor > 1 grows it). */
export function expandBox(box: BBox, factor: number): BBox {
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  const w = box.width * factor;
  const h = box.height * factor;
  return clampBox({ x: cx - w / 2, y: cy - h / 2, width: w, height: h });
}

export function lerpBox(a: BBox, b: BBox, t: number): BBox {
  const k = Math.min(Math.max(t, 0), 1);
  return {
    x: a.x + (b.x - a.x) * k,
    y: a.y + (b.y - a.y) * k,
    width: a.width + (b.width - a.width) * k,
    height: a.height + (b.height - a.height) * k,
  };
}

export function matchesBox(a: BBox, b: BBox): boolean {
  return (
    Math.abs(a.x - b.x) < 0.001 &&
    Math.abs(a.y - b.y) < 0.001 &&
    Math.abs(a.width - b.width) < 0.001 &&
    Math.abs(a.height - b.height) < 0.001
  );
}

export function isDegenerate(box: BBox | null | undefined): boolean {
  if (!box) return true;
  if (!Number.isFinite(box.x) || !Number.isFinite(box.y)) return true;
  if (!Number.isFinite(box.width) || !Number.isFinite(box.height)) return true;
  return box.width < 0.02 || box.height < 0.02 || area(box) < 0.0005;
}

/** Converts a normalized box into integer pixel crop bounds for a W×H image. */
export function boxToCropRect(
  box: BBox,
  imageWidth: number,
  imageHeight: number,
  pad = 0.06,
): { x: number; y: number; w: number; h: number } {
  const padded = expandBox(box, 1 + pad * 2);
  const x = Math.max(0, Math.floor(padded.x * imageWidth));
  const y = Math.max(0, Math.floor(padded.y * imageHeight));
  const w = Math.max(1, Math.min(imageWidth - x, Math.ceil(padded.width * imageWidth)));
  const h = Math.max(1, Math.min(imageHeight - y, Math.ceil(padded.height * imageHeight)));
  return { x, y, w, h };
}

export interface ContentRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

/**
 * Where a video/image is actually painted inside an element when using
 * `object-fit: contain` — needed to map normalized boxes onto screen pixels on
 * any container size or aspect ratio (portrait phones included).
 */
export function fittedContentRect(
  mediaWidth: number,
  mediaHeight: number,
  elementWidth: number,
  elementHeight: number,
): ContentRect {
  if (!mediaWidth || !mediaHeight || !elementWidth || !elementHeight) {
    return { left: 0, top: 0, width: elementWidth, height: elementHeight };
  }
  const scale = Math.min(elementWidth / mediaWidth, elementHeight / mediaHeight);
  const width = mediaWidth * scale;
  const height = mediaHeight * scale;
  return {
    left: (elementWidth - width) / 2,
    top: (elementHeight - height) / 2,
    width,
    height,
  };
}

export function boxToPixels(
  box: BBox,
  content: ContentRect,
): { left: number; top: number; width: number; height: number } {
  return {
    left: content.left + box.x * content.width,
    top: content.top + box.y * content.height,
    width: box.width * content.width,
    height: box.height * content.height,
  };
}
