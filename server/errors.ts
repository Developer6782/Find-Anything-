import type { ApiErrorBody } from '../shared/types.js';

/**
 * Error shape that the API routes return. Codes are stable so the UI can react
 * (e.g. show "Fix API key" vs "Retry").
 */
export type ErrorCode =
  | 'NO_KEY'
  | 'INVALID_KEY'
  | 'PERMISSION_DENIED'
  | 'MODEL_NOT_FOUND'
  | 'MODEL_UNSUPPORTED'
  | 'RATE_LIMITED'
  | 'OVERLOADED'
  | 'TIMEOUT'
  | 'NETWORK'
  | 'BAD_REQUEST'
  | 'PARSE_ERROR'
  | 'NO_IMAGE'
  | 'UPSTREAM'
  | 'UNKNOWN';

const HINTS: Record<ErrorCode, string> = {
  NO_KEY: 'Paste your Gemini API key (Google AI Studio → Get API key) and try again.',
  INVALID_KEY: 'Check for a typo or extra space, or create a fresh key in Google AI Studio.',
  PERMISSION_DENIED: 'This key has no access to the selected model — enable the Generative Language API or use a key from AI Studio.',
  MODEL_NOT_FOUND: 'This model is not available for your key. Pick another model in Settings → Model.',
  MODEL_UNSUPPORTED: 'The selected model cannot do this task (e.g. no image input). Pick a multimodal model such as Gemini 2.5 Flash.',
  RATE_LIMITED: 'Free-tier quota reached. Wait a minute, lower the analyse rate in Settings, or use another key.',
  OVERLOADED: 'Gemini is busy right now. Try again in a few seconds.',
  TIMEOUT: 'The request took too long. Check your connection and retry.',
  NETWORK: 'Network failure — check your internet connection.',
  BAD_REQUEST: 'The request was rejected by the API. Try again with a different model.',
  PARSE_ERROR: 'The model replied in an unexpected format. Retry the step.',
  NO_IMAGE: 'Attach a reference photo/image first.',
  UPSTREAM: 'Gemini returned an error. Retry, or switch model in Settings.',
  UNKNOWN: 'Something went wrong. Retry, and check the browser console for details.',
};

export class GeminiApiError extends Error {
  code: ErrorCode;
  upstreamStatus?: number;
  upstreamDetail?: string;

  constructor(code: ErrorCode, message: string, upstreamStatus?: number, upstreamDetail?: string) {
    super(message);
    this.name = 'GeminiApiError';
    this.code = code;
    this.upstreamStatus = upstreamStatus;
    this.upstreamDetail = upstreamDetail;
  }

  toBody(): ApiErrorBody {
    return {
      error: {
        code: this.code,
        message: this.message,
        hint: HINTS[this.code],
        upstreamStatus: this.upstreamStatus,
      },
    };
  }
}

/** Maps a Google Generative Language API error payload to a friendly error. */
export function mapUpstreamError(status: number, payload: unknown): GeminiApiError {
  const anyPayload = payload as { error?: { message?: string; status?: string; details?: unknown[] } } | undefined;
  const detail = anyPayload?.error?.message ?? JSON.stringify(payload ?? {}).slice(0, 400);
  const statusText = anyPayload?.error?.status ?? '';
  const haystack = `${statusText} ${detail}`.toLowerCase();

  if (haystack.includes('api key not valid') || haystack.includes('api_key_invalid')) {
    return new GeminiApiError('INVALID_KEY', 'Your Gemini API key was rejected.', status, detail);
  }
  if (haystack.includes('api key expired') || haystack.includes('key expired')) {
    return new GeminiApiError('INVALID_KEY', 'Your Gemini API key has expired.', status, detail);
  }
  if (status === 401) {
    return new GeminiApiError('INVALID_KEY', 'Your Gemini API key was rejected.', status, detail);
  }
  if (status === 403) {
    return new GeminiApiError('PERMISSION_DENIED', 'This API key is not allowed to use the requested model.', status, detail);
  }
  if (status === 404 || haystack.includes('is not found') || haystack.includes('not supported for')) {
    return new GeminiApiError(
      'MODEL_NOT_FOUND',
      'That model does not exist for your key (or was retired).',
      status,
      detail,
    );
  }
  if (status === 429 || haystack.includes('quota') || haystack.includes('resource_exhausted')) {
    return new GeminiApiError('RATE_LIMITED', 'Quota or rate limit reached for this API key.', status, detail);
  }
  if (status === 400 && haystack.includes('image')) {
    return new GeminiApiError('MODEL_UNSUPPORTED', 'The selected model rejected the image input.', status, detail);
  }
  if (status === 400) {
    return new GeminiApiError('BAD_REQUEST', 'The API rejected the request as invalid.', status, detail);
  }
  if (status === 500 || status === 503 || status === 504) {
    return new GeminiApiError('OVERLOADED', 'Gemini is temporarily unavailable (server error).', status, detail);
  }
  return new GeminiApiError('UPSTREAM', 'Gemini returned an unexpected error.', status, detail);
}

export function classifyFetchFailure(err: unknown): GeminiApiError {
  const message = err instanceof Error ? err.message : String(err);
  if (/abort/i.test(message)) {
    return new GeminiApiError('TIMEOUT', 'The request timed out.');
  }
  return new GeminiApiError('NETWORK', 'Could not reach the Gemini API.');
}
