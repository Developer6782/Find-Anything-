import type { BBox } from '../contracts';
import { boxToCropRect } from './bbox';

/** Grayscale image: intensity 0..255 in a flat Float32Array (row-major). */
export interface GrayImage {
  width: number;
  height: number;
  data: Float32Array;
}

export interface IntegralImage {
  width: number;
  height: number;
  /** (w+1) × (h+1) prefix sums of intensity. */
  sum: Float64Array;
  /** (w+1) × (h+1) prefix sums of intensity² — gives O(1) window variance. */
  sumSq: Float64Array;
}

export function grayFromImageData(image: ImageData): GrayImage {
  const { width, height, data } = image;
  const out = new Float32Array(width * height);
  for (let i = 0, p = 0; i < out.length; i += 1, p += 4) {
    // Rec. 601 luma — cheap and good enough for template matching.
    out[i] = 0.299 * data[p] + 0.587 * data[p + 1] + 0.114 * data[p + 2];
  }
  return { width, height, data: out };
}

/** Box-filter downscale (or nearest upscale) keeping aspect ratio ignored. */
export function resizeGray(src: GrayImage, targetWidth: number, targetHeight: number): GrayImage {
  const width = Math.max(2, Math.round(targetWidth));
  const height = Math.max(2, Math.round(targetHeight));
  if (width === src.width && height === src.height) return src;

  const out = new Float32Array(width * height);
  const scaleX = src.width / width;
  const scaleY = src.height / height;
  const downscaling = scaleX > 1 || scaleY > 1;

  if (!downscaling) {
    for (let y = 0; y < height; y += 1) {
      const sy = Math.min(src.height - 1, Math.floor(y * scaleY));
      for (let x = 0; x < width; x += 1) {
        const sx = Math.min(src.width - 1, Math.floor(x * scaleX));
        out[y * width + x] = src.data[sy * src.width + sx];
      }
    }
    return { width, height, data: out };
  }

  // Area-average for downscaling: fewer aliasing artefacts, better matching.
  for (let y = 0; y < height; y += 1) {
    const y0 = Math.floor(y * scaleY);
    const y1 = Math.min(src.height, Math.max(y0 + 1, Math.floor((y + 1) * scaleY)));
    for (let x = 0; x < width; x += 1) {
      const x0 = Math.floor(x * scaleX);
      const x1 = Math.min(src.width, Math.max(x0 + 1, Math.floor((x + 1) * scaleX)));
      let acc = 0;
      let n = 0;
      for (let yy = y0; yy < y1; yy += 1) {
        const row = yy * src.width;
        for (let xx = x0; xx < x1; xx += 1) {
          acc += src.data[row + xx];
          n += 1;
        }
      }
      out[y * width + x] = n ? acc / n : 0;
    }
  }
  return { width, height, data: out };
}

export function cropGray(src: GrayImage, x: number, y: number, w: number, h: number): GrayImage {
  const x0 = Math.max(0, Math.min(src.width - 1, Math.floor(x)));
  const y0 = Math.max(0, Math.min(src.height - 1, Math.floor(y)));
  const w0 = Math.max(1, Math.min(src.width - x0, Math.floor(w)));
  const h0 = Math.max(1, Math.min(src.height - y0, Math.floor(h)));
  const out = new Float32Array(w0 * h0);
  for (let yy = 0; yy < h0; yy += 1) {
    const srcRow = (y0 + yy) * src.width + x0;
    out.set(src.data.subarray(srcRow, srcRow + w0), yy * w0);
  }
  return { width: w0, height: h0, data: out };
}

/** Crops a normalized box out of a grayscale image. */
export function cropGrayByBox(src: GrayImage, box: BBox, pad = 0.04): GrayImage {
  const rect = boxToCropRect(box, src.width, src.height, pad);
  return cropGray(src, rect.x, rect.y, rect.w, rect.h);
}

export function integralImage(src: GrayImage): IntegralImage {
  const w = src.width;
  const h = src.height;
  const sum = new Float64Array((w + 1) * (h + 1));
  const sumSq = new Float64Array((w + 1) * (h + 1));
  for (let y = 0; y < h; y += 1) {
    let rowSum = 0;
    let rowSq = 0;
    for (let x = 0; x < w; x += 1) {
      const v = src.data[y * w + x];
      rowSum += v;
      rowSq += v * v;
      sum[(y + 1) * (w + 1) + (x + 1)] = sum[y * (w + 1) + (x + 1)] + rowSum;
      sumSq[(y + 1) * (w + 1) + (x + 1)] = sumSq[y * (w + 1) + (x + 1)] + rowSq;
    }
  }
  return { width: w, height: h, sum, sumSq };
}

export interface WindowStats {
  mean: number;
  /** Sum of squared deviations from the mean (not variance). */
  ssd: number;
  n: number;
}

/** O(1) mean and sum-of-squared-deviations for any window. */
export function windowStats(integral: IntegralImage, x: number, y: number, w: number, h: number): WindowStats {
  const sw = integral.width + 1;
  const x0 = x;
  const y0 = y;
  const x1 = x + w;
  const y1 = y + h;
  const s = integral.sum;
  const sq = integral.sumSq;
  const total =
    s[y1 * sw + x1] - s[y0 * sw + x1] - s[y1 * sw + x0] + s[y0 * sw + x0];
  const totalSq =
    sq[y1 * sw + x1] - sq[y0 * sw + x1] - sq[y1 * sw + x0] + sq[y0 * sw + x0];
  const n = w * h;
  const mean = total / n;
  return { mean, ssd: Math.max(1e-6, totalSq - (total * total) / n), n };
}

export function imageDataFromGray(gray: GrayImage): ImageData {
  const out = new ImageData(gray.width, gray.height);
  for (let i = 0; i < gray.data.length; i += 1) {
    const v = Math.max(0, Math.min(255, gray.data[i]));
    out.data[i * 4] = v;
    out.data[i * 4 + 1] = v;
    out.data[i * 4 + 2] = v;
    out.data[i * 4 + 3] = 255;
  }
  return out;
}
