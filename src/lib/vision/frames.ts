import type { BBox } from '../contracts';
import { type GrayImage, grayFromImageData } from './imageOps';

/**
 * Single reusable canvas keeps frame grabbing allocation-free at video rate.
 * Frames are always DOWNSCALED before they touch the network or the matcher —
 * a 640 px JPEG is plenty for the model, and 192 px is plenty for ZNCC.
 */

export interface CapturedJpeg {
  base64: string;
  mimeType: string;
  width: number;
  height: number;
}

export class FrameGrabber {
  private canvas: HTMLCanvasElement | null = null;
  private ctx: CanvasRenderingContext2D | null = null;
  private grayCanvas: HTMLCanvasElement | null = null;
  private grayCtx: CanvasRenderingContext2D | null = null;

  private ensure(width: number, height: number): CanvasRenderingContext2D {
    if (!this.canvas) {
      this.canvas = document.createElement('canvas');
      this.ctx = this.canvas.getContext('2d', { willReadFrequently: true });
    }
    const canvas = this.canvas!;
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
    }
    return this.ctx!;
  }

  private ensureGray(width: number, height: number): CanvasRenderingContext2D {
    if (!this.grayCanvas) {
      this.grayCanvas = document.createElement('canvas');
      this.grayCtx = this.grayCanvas.getContext('2d', { willReadFrequently: true });
    }
    const canvas = this.grayCanvas!;
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
    }
    return this.grayCtx!;
  }

  /** Downscaled JPEG of the current video frame. */
  captureJpeg(video: HTMLVideoElement, maxWidth: number, quality = 0.72): CapturedJpeg | null {
    const vw = video.videoWidth;
    const vh = video.videoHeight;
    if (!vw || !vh) return null;
    const width = Math.min(maxWidth, vw);
    const height = Math.max(2, Math.round((vh / vw) * width));
    const ctx = this.ensure(width, height);
    ctx.drawImage(video, 0, 0, width, height);
    const dataUrl = this.canvas!.toDataURL('image/jpeg', quality);
    const comma = dataUrl.indexOf(',');
    return {
      base64: comma >= 0 ? dataUrl.slice(comma + 1) : dataUrl,
      mimeType: 'image/jpeg',
      width,
      height,
    };
  }

  /** Small grayscale frame for the on-device matcher. */
  captureGray(video: HTMLVideoElement, targetWidth: number): GrayImage | null {
    const vw = video.videoWidth;
    const vh = video.videoHeight;
    if (!vw || !vh) return null;
    const width = Math.min(targetWidth, vw);
    const height = Math.max(2, Math.round((vh / vw) * width));
    const ctx = this.ensureGray(width, height);
    ctx.drawImage(video, 0, 0, width, height);
    return grayFromImageData(ctx.getImageData(0, 0, width, height));
  }
}

/** Loads an <img>/bitmap into a canvas and returns its grayscale pixels. */
export async function imageToGray(source: HTMLImageElement, maxWidth = 512): Promise<GrayImage> {
  const width = Math.min(maxWidth, source.naturalWidth || source.width);
  const height = Math.max(
    2,
    Math.round(((source.naturalHeight || source.height) / (source.naturalWidth || source.width)) * width),
  );
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new Error('Could not create a 2D canvas context.');
  ctx.drawImage(source, 0, 0, width, height);
  return grayFromImageData(ctx.getImageData(0, 0, width, height));
}

/** Cuts a padded crop around a normalized box out of a data URL image. */
export async function cropBoxFromDataUrl(
  dataUrl: string,
  box: BBox,
  pad = 0.08,
  outWidth = 320,
  quality = 0.7,
): Promise<CapturedJpeg | null> {
  const img = await loadImage(dataUrl);
  const sx = Math.max(0, Math.floor((box.x - box.width * pad) * img.naturalWidth));
  const sy = Math.max(0, Math.floor((box.y - box.height * pad) * img.naturalHeight));
  const sw = Math.max(8, Math.ceil(box.width * (1 + pad * 2) * img.naturalWidth));
  const sh = Math.max(8, Math.ceil(box.height * (1 + pad * 2) * img.naturalHeight));
  const sw2 = Math.min(sw, img.naturalWidth - sx);
  const sh2 = Math.min(sh, img.naturalHeight - sy);
  const width = Math.min(outWidth, sw2);
  const height = Math.max(2, Math.round((sh2 / sw2) * width));

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  ctx.drawImage(img, sx, sy, sw2, sh2, 0, 0, width, height);
  const dataUrl2 = canvas.toDataURL('image/jpeg', quality);
  const comma = dataUrl2.indexOf(',');
  return {
    base64: comma >= 0 ? dataUrl2.slice(comma + 1) : dataUrl2,
    mimeType: 'image/jpeg',
    width,
    height,
  };
}

export function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('Could not load the image.'));
    img.src = src;
  });
}

export function fileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error('Could not read the file.'));
    reader.readAsDataURL(file);
  });
}
