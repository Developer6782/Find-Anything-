import type { ApiErrorBody } from '../contracts';

/**
 * Thin HTTP layer. Everything goes through the same origin (`/api/*`) so the
 * API key never appears in a URL and the browser never needs CORS exceptions.
 * Swap this file to move to a different backend without touching the UI.
 */

export class GeminiClientError extends Error {
  code: string;
  hint?: string;
  status: number;

  constructor(message: string, code = 'UNKNOWN', status = 0, hint?: string) {
    super(message);
    this.name = 'GeminiClientError';
    this.code = code;
    this.status = status;
    this.hint = hint;
  }
}

export async function postJson<T>(path: string, body: unknown, signal?: AbortSignal): Promise<T> {
  let response: Response;
  try {
    response = await fetch(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body ?? {}),
      signal,
    });
  } catch (err) {
    if ((err as Error)?.name === 'AbortError') {
      throw new GeminiClientError('Request cancelled.', 'TIMEOUT', 0);
    }
    throw new GeminiClientError(
      'Could not reach the app server. Is it still running?',
      'NETWORK',
      0,
      'Check your connection, then retry.',
    );
  }

  const text = await response.text();
  let payload: unknown = null;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    payload = null;
  }

  if (!response.ok) {
    const body = payload as ApiErrorBody | null;
    const message = body?.error?.message ?? `Request failed (HTTP ${response.status}).`;
    throw new GeminiClientError(message, body?.error?.code ?? 'UPSTREAM', response.status, body?.error?.hint);
  }
  return payload as T;
}

export async function getJson<T>(path: string): Promise<T> {
  const response = await fetch(path);
  if (!response.ok) throw new GeminiClientError(`Request failed (HTTP ${response.status})`, 'UPSTREAM', response.status);
  return (await response.json()) as T;
}

export function liveSocketUrl(): string {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${protocol}//${window.location.host}/api/live`;
}
