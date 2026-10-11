import { GEMINI_BASE } from '../shared/types.js';
import type {
  AnalyzeResponse,
  BBox,
  CapabilityCheckResponse,
  DetectResponse,
  ModelInfo,
  TargetProfile,
  VerifyResult,
} from '../shared/types.js';
import { GeminiApiError, classifyFetchFailure, mapUpstreamError } from './errors.js';
import {
  ANALYZE_SCHEMA,
  CAPABILITY_SCHEMA,
  DETECT_SCHEMA,
  VERIFY_SCHEMA,
  analyzePrompt,
  capabilityPrompt,
  detectPrompt,
  verifyPrompt,
} from './prompts.js';

export interface InlineImage {
  /** Base64 without the data: URL prefix. */
  data: string;
  mimeType: string;
}

const REQUEST_TIMEOUT_MS = 45_000;

async function callGemini(
  apiKey: string,
  model: string,
  method: 'generateContent',
  body: unknown,
): Promise<{ json: any; latencyMs: number }> {
  const started = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(`${GEMINI_BASE}/models/${encodeURIComponent(model)}:${method}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        // Key travels in a header, not a URL — keeps it out of access logs.
        'x-goog-api-key': apiKey,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (err) {
    throw classifyFetchFailure(err);
  } finally {
    clearTimeout(timer);
  }

  const text = await res.text();
  let parsed: unknown = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = { raw: text.slice(0, 400) };
  }
  if (!res.ok) throw mapUpstreamError(res.status, parsed);
  return { json: parsed, latencyMs: Date.now() - started };
}

function inlinePart(image: InlineImage) {
  return { inlineData: { data: image.data, mimeType: image.mimeType } };
}

/** Pulls the first text part of a generateContent response. */
function firstText(json: any): string {
  const parts = json?.candidates?.[0]?.content?.parts;
  if (!Array.isArray(parts)) return '';
  return parts
    .filter((p: any) => p && typeof p.text === 'string' && p.thought !== true)
    .map((p: any) => p.text)
    .join('\n')
    .trim();
}

function safeJson(text: string): any {
  if (!text) throw new GeminiApiError('PARSE_ERROR', 'Gemini returned an empty response.');
  let cleaned = text.trim();
  // Strip markdown fences if the model added them despite responseMimeType.
  cleaned = cleaned.replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  try {
    return JSON.parse(cleaned);
  } catch {
    const start = cleaned.indexOf('{');
    const end = cleaned.lastIndexOf('}');
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(cleaned.slice(start, end + 1));
      } catch {
        /* fallthrough */
      }
    }
    throw new GeminiApiError('PARSE_ERROR', 'Gemini replied in an unexpected format.');
  }
}

/* ────────────────────────────── known models ─────────────────────────────── */

/**
 * Curated free/cheap-tier multimodal models. The UI defaults to one of these and
 * disables the rest. (Gemini Pro / newest flagships were reported as not working
 * on this account's tier, so they are not offered.)
 */
export const CURATED_MODELS: { id: string; label: string; note: string }[] = [
  { id: 'gemini-flash-latest', label: 'Gemini Flash (latest)', note: 'Fast, multimodal, generous free tier' },
  { id: 'gemini-2.5-flash', label: 'Gemini 2.5 Flash', note: 'Stable multimodal workhorse' },
  { id: 'gemini-2.5-flash-lite', label: 'Gemini 2.5 Flash-Lite', note: 'Cheapest, highest quota, slightly weaker' },
  { id: 'gemini-flash-lite-latest', label: 'Gemini Flash-Lite (latest)', note: 'Cheapest alias' },
];

export const DEFAULT_TEXT_MODEL = 'gemini-flash-latest';

export async function listModels(apiKey: string): Promise<{ models: ModelInfo[]; recommended: string[] }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20_000);
  let res: Response;
  try {
    res = await fetch(`${GEMINI_BASE}/models?pageSize=200`, {
      headers: { 'x-goog-api-key': apiKey },
      signal: controller.signal,
    });
  } catch (err) {
    throw classifyFetchFailure(err);
  } finally {
    clearTimeout(timer);
  }
  const body = await res.json().catch(() => null);
  if (!res.ok) throw mapUpstreamError(res.status, body);

  const raw = (body as any)?.models ?? [];
  const models: ModelInfo[] = raw.map((m: any) => ({
    id: String(m.name ?? '').replace(/^models\//, ''),
    displayName: String(m.displayName ?? ''),
    methods: Array.isArray(m.supportedGenerationMethods) ? m.supportedGenerationMethods : [],
    inputTokenLimit: m.inputTokenLimit,
    thinking: Boolean(m.thinking),
  }));

  const available = new Set(models.map((m) => m.id));
  const recommended = CURATED_MODELS.map((m) => m.id).filter((id) => available.has(id));
  return { models, recommended };
}

/* ─────────────────────────── reference analysis ──────────────────────────── */

export async function analyzeReference(
  apiKey: string,
  model: string,
  image: InlineImage,
): Promise<AnalyzeResponse> {
  const { json, latencyMs } = await callGemini(apiKey, model, 'generateContent', {
    contents: [{ role: 'user', parts: [inlinePart(image), { text: analyzePrompt() }] }],
    generationConfig: {
      temperature: 0.2,
      responseMimeType: 'application/json',
      responseSchema: ANALYZE_SCHEMA,
    },
  });

  const data = safeJson(firstText(json));
  const profile: TargetProfile = {
    name: String(data.name ?? 'object'),
    category: String(data.category ?? 'unknown'),
    attributes: Array.isArray(data.attributes)
      ? data.attributes.map((a: any) => ({
          key: String(a?.key ?? ''),
          value: String(a?.value ?? ''),
          distinctiveness: (['high', 'medium', 'low'] as const).includes(a?.distinctiveness)
            ? a.distinctiveness
            : 'medium',
        }))
      : [],
    distinguishingColors: Array.isArray(data.distinguishingColors)
      ? data.distinguishingColors.map((c: any) => String(c))
      : [],
    targetBBox: sanitizeBBox(data.targetBBox),
    descriptors: Array.isArray(data.descriptors)
      ? data.descriptors.map((d: any) => String(d)).slice(0, 20)
      : [],
    sceneGuidance: String(data.sceneGuidance ?? '') || 'Pan slowly around the room.',
    searchHint: String(data.searchHint ?? '') || 'Scanning…',
    ambiguityRisks: Array.isArray(data.ambiguityRisks) ? data.ambiguityRisks.map((r: any) => String(r)) : [],
  };

  const warnings: string[] = [];
  if (!profile.descriptors.length) {
    warnings.push('The model did not return visual descriptors — matching quality may drop.');
  }
  if (/blur|empty|no object|screenshot|unusable/i.test(profile.ambiguityRisks.join(' '))) {
    warnings.push('The reference photo may be unsuitable (blurry, empty, or a screenshot).');
  }

  return { profile, warnings, model, latencyMs };
}

/* ──────────────────────── per-frame localisation ─────────────────────────── */

export function sanitizeBBox(input: unknown): BBox | null {
  // Accept both the object form and Gemini's recommended [ymin, xmin, ymax, xmax]
  // 0..1000 array form. Everything is normalized to 0..1 objects.
  let x: number | undefined;
  let y: number | undefined;
  let width: number | undefined;
  let height: number | undefined;

  if (Array.isArray(input) && input.length === 4 && input.every((n) => typeof n === 'number')) {
    const [ymin, xmin, ymax, xmax] = input as number[];
    const looks0to1000 = Math.max(ymin, xmin, ymax, xmax) > 1.5;
    const s = looks0to1000 ? 1000 : 1;
    y = ymin / s;
    x = xmin / s;
    width = (xmax - xmin) / s;
    height = (ymax - ymin) / s;
  } else if (input && typeof input === 'object') {
    const b = input as Record<string, unknown>;
    const maybeX = b.x;
    const maybeY = b.y;
    const maybeW = b.width;
    const maybeH = b.height;
    // Some replies use min/max naming instead of x/y/width/height.
    if (typeof maybeX === 'number' && typeof maybeY === 'number' && typeof maybeW === 'number' && typeof maybeH === 'number') {
      ({ x: x, y: y, width: width, height: height } = { x: maybeX, y: maybeY, width: maybeW, height: maybeH });
    } else if (typeof b.xmin === 'number' && typeof b.ymin === 'number' && typeof b.xmax === 'number' && typeof b.ymax === 'number') {
      x = b.xmin;
      y = b.ymin;
      width = b.xmax - b.xmin;
      height = b.ymax - b.ymin;
    }
  }
  if ([x, y, width, height].some((v) => typeof v !== 'number' || !Number.isFinite(v))) return null;

  // If values are 0..1000 style, normalize.
  const max = Math.max(x!, y!, width!, height!);
  if (max > 1.5) {
    const s = 1000;
    x = x! / s;
    y = y! / s;
    width = width! / s;
    height = height! / s;
  }

  if (width! <= 0 || height! <= 0) return null;
  if (width! * height! < 0.0005) return null; // < ~0.05% of the frame: noise, not an object

  const x1 = Math.min(Math.max(x!, 0), 1);
  const y1 = Math.min(Math.max(y!, 0), 1);
  const x2 = Math.min(Math.max(x! + width!, 0), 1);
  const y2 = Math.min(Math.max(y! + height!, 0), 1);
  if (x2 - x1 < 0.02 || y2 - y1 < 0.02) return null; // degenerate box
  return { x: x1, y: y1, width: x2 - x1, height: y2 - y1 };
}

export async function detectInFrame(
  apiKey: string,
  model: string,
  image: InlineImage,
  profile: TargetProfile | null,
  extraContext: string[],
): Promise<DetectResponse> {
  const { json, latencyMs } = await callGemini(apiKey, model, 'generateContent', {
    contents: [{ role: 'user', parts: [inlinePart(image), { text: detectPrompt(profile, extraContext) }] }],
    generationConfig: {
      temperature: 0.1,
      responseMimeType: 'application/json',
      responseSchema: DETECT_SCHEMA,
    },
  });

  const data = safeJson(firstText(json));
  const rawConfidence = Number(data.confidence);
  const confidence = Number.isFinite(rawConfidence) ? Math.min(Math.max(rawConfidence, 0), 1) : 0;
  const rawVisible = data.visible === true;
  const bbox = sanitizeBBox(data.bbox);

  // The model must not claim a position it cannot pin down: a visible=true
  // without a usable box is downgraded to a weak "possible" signal.
  const visible = rawVisible && (bbox !== null || confidence >= 0.5);

  return {
    visible,
    confidence,
    bbox: visible ? bbox : null,
    reason: typeof data.reason === 'string' ? data.reason : undefined,
    attributes: Array.isArray(data.attributes) ? data.attributes.map((a: any) => String(a)).slice(0, 8) : undefined,
    candidatesConsidered: Number.isFinite(Number(data.candidatesConsidered))
      ? Number(data.candidatesConsidered)
      : undefined,
    model,
    latencyMs,
  };
}

export async function verifyCandidate(
  apiKey: string,
  model: string,
  reference: InlineImage,
  crop: InlineImage,
  profile: TargetProfile | null,
): Promise<VerifyResult> {
  const { json } = await callGemini(apiKey, model, 'generateContent', {
    contents: [
      {
        role: 'user',
        parts: [
          { text: 'REFERENCE PHOTO of the target:' },
          inlinePart(reference),
          { text: 'CANDIDATE CROP from the live camera:' },
          inlinePart(crop),
          { text: verifyPrompt(profile) },
        ],
      },
    ],
    generationConfig: { temperature: 0, responseMimeType: 'application/json', responseSchema: VERIFY_SCHEMA },
  });
  const data = safeJson(firstText(json));
  const c = Number(data.confidence);
  return {
    visible: data.visible === true,
    confidence: Number.isFinite(c) ? Math.min(Math.max(c, 0), 1) : 0,
    reason: typeof data.reason === 'string' ? data.reason : undefined,
  };
}

export async function capabilityCheck(
  apiKey: string,
  model: string,
  image: InlineImage,
): Promise<CapabilityCheckResponse> {
  const capability = 'vision.generateContent';
  try {
    const { json } = await callGemini(apiKey, model, 'generateContent', {
      contents: [{ role: 'user', parts: [inlinePart(image), { text: capabilityPrompt() }] }],
      generationConfig: { temperature: 0, responseMimeType: 'application/json', responseSchema: CAPABILITY_SCHEMA },
    });
    const data = safeJson(firstText(json));
    return {
      capability,
      ok: data.canReadImage === true,
      note: String(data.note ?? '').slice(0, 160),
      model,
    };
  } catch (err) {
    if (err instanceof GeminiApiError) {
      return { capability, ok: false, note: `${err.code}: ${err.message}`, model };
    }
    return { capability, ok: false, note: 'Unknown failure', model };
  }
}
