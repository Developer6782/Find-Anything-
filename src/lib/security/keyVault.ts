/**
 * BYOK key vault.
 *
 * The API key is NEVER hardcoded, never committed, and never written to storage
 * as plain text by default. Storage modes:
 *
 *  - 'session'    → sessionStorage, plain text, cleared when the tab closes.
 *  - 'passphrase' → localStorage, AES-GCM encrypted with PBKDF2(passphrase).
 *                   Default mode; requires the passphrase once per page load.
 *  - 'memory'     → never persisted at all; gone on refresh.
 *
 * Decrypted keys live only in a module-level variable (memory), never on
 * `window`, never in React state stores that get serialised.
 */

import { STORAGE } from '../config';

export type StorageMode = 'session' | 'passphrase' | 'memory';

export interface KeyMeta {
  mode: StorageMode;
  hint: string;
  updatedAt: number;
  model?: string;
}

interface Envelope {
  v: 1;
  alg: 'AES-GCM';
  kdf: 'PBKDF2-SHA256';
  iterations: number;
  salt: string; // base64
  iv: string; // base64
  data: string; // base64 ciphertext
}

export class WrongPassphraseError extends Error {
  constructor() {
    super('Wrong passphrase (or the stored key was tampered with).');
    this.name = 'WrongPassphraseError';
  }
}

export class InsecureContextError extends Error {
  constructor() {
    super(
      'WebCrypto is unavailable in this context. Use HTTPS or localhost, or choose the session-only storage mode.',
    );
    this.name = 'InsecureContextError';
  }
}

const subtle = () => {
  const c = globalThis.crypto;
  if (!c?.subtle) throw new InsecureContextError();
  return c.subtle;
};

function storageOf(kind: 'local' | 'session'): Storage | null {
  try {
    const s = kind === 'local' ? globalThis.localStorage : globalThis.sessionStorage;
    return s ?? null;
  } catch {
    return null;
  }
}

function b64(bytes: Uint8Array): string {
  let str = '';
  for (const b of bytes) str += String.fromCharCode(b);
  return btoa(str);
}

function unb64(value: string): Uint8Array {
  const raw = atob(value);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i += 1) out[i] = raw.charCodeAt(i);
  return out;
}

async function deriveKey(passphrase: string, salt: Uint8Array, iterations: number): Promise<CryptoKey> {
  const base = await subtle().importKey('raw', new TextEncoder().encode(passphrase), 'PBKDF2', false, [
    'deriveKey',
  ]);
  return subtle().deriveKey(
    { name: 'PBKDF2', salt: salt as unknown as BufferSource, iterations, hash: 'SHA-256' },
    base,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

/** In-memory only. Cleared on refresh, never serialised anywhere. */
let memoryKey: string | null = null;

export function getKey(): string | null {
  return memoryKey;
}

export function setKey(key: string): void {
  memoryKey = key.trim() || null;
}

export function clearRuntimeKey(): void {
  memoryKey = null;
}

export function readMeta(): KeyMeta | null {
  try {
    const raw = storageOf('local')?.getItem(STORAGE.keyMeta);
    return raw ? (JSON.parse(raw) as KeyMeta) : null;
  } catch {
    return null;
  }
}

function writeMeta(meta: KeyMeta | null): void {
  const s = storageOf('local');
  if (!s) return;
  if (meta) s.setItem(STORAGE.keyMeta, JSON.stringify(meta));
  else s.removeItem(STORAGE.keyMeta);
}

export interface SaveOptions {
  mode: StorageMode;
  passphrase?: string;
  model?: string;
}

/** Persists the key according to the chosen mode. Throws on crypto misuse. */
export async function saveKey(key: string, options: SaveOptions): Promise<KeyMeta> {
  const trimmed = key.trim();
  if (!trimmed) throw new Error('API key is empty.');
  setKey(trimmed);

  const hint = `${trimmed.slice(0, 6)}…${trimmed.slice(-4)}`;
  const meta: KeyMeta = { mode: options.mode, hint, updatedAt: Date.now(), model: options.model };

  const local = storageOf('local');
  const session = storageOf('session');
  // Always start from a clean slate so switching modes cannot leave stale blobs.
  local?.removeItem(STORAGE.keySecret);
  local?.removeItem(STORAGE.keyMeta);
  session?.removeItem(STORAGE.sessionKey);

  if (options.mode === 'memory') {
    writeMeta(meta);
    return meta;
  }

  if (options.mode === 'session') {
    session?.setItem(STORAGE.sessionKey, trimmed);
    writeMeta(meta);
    return meta;
  }

  const passphrase = options.passphrase?.trim();
  if (!passphrase || passphrase.length < 8) {
    throw new Error('Choose a passphrase of at least 8 characters.');
  }
  const salt = globalThis.crypto.getRandomValues(new Uint8Array(16));
  const iv = globalThis.crypto.getRandomValues(new Uint8Array(12));
  const iterations = 210_000;
  const derived = await deriveKey(passphrase, salt, iterations);
  const ct = await subtle().encrypt(
    { name: 'AES-GCM', iv: iv as unknown as BufferSource },
    derived,
    new TextEncoder().encode(trimmed),
  );
  const envelope: Envelope = {
    v: 1,
    alg: 'AES-GCM',
    kdf: 'PBKDF2-SHA256',
    iterations,
    salt: b64(salt),
    iv: b64(iv),
    data: b64(new Uint8Array(ct)),
  };
  local?.setItem(STORAGE.keySecret, JSON.stringify(envelope));
  writeMeta(meta);
  return meta;
}

/**
 * Restores the key from storage.
 * - session/memory modes: no passphrase needed.
 * - passphrase mode: pass the user's passphrase (throws WrongPassphraseError).
 */
export async function loadKey(passphrase?: string): Promise<{ key: string | null; needsPassphrase: boolean }> {
  const meta = readMeta();
  if (!meta) return { key: null, needsPassphrase: false };

  if (meta.mode === 'session') {
    const value = storageOf('session')?.getItem(STORAGE.sessionKey) ?? null;
    if (value) setKey(value);
    return { key: value, needsPassphrase: false };
  }
  if (meta.mode === 'memory') {
    return { key: null, needsPassphrase: false };
  }

  const raw = storageOf('local')?.getItem(STORAGE.keySecret);
  if (!raw) return { key: null, needsPassphrase: false };
  if (!passphrase) return { key: null, needsPassphrase: true };

  const envelope = JSON.parse(raw) as Envelope;
  const derived = await deriveKey(passphrase, unb64(envelope.salt), envelope.iterations);
  try {
    const plain = await subtle().decrypt(
      { name: 'AES-GCM', iv: unb64(envelope.iv) as unknown as BufferSource },
      derived,
      unb64(envelope.data) as unknown as BufferSource,
    );
    const key = new TextDecoder().decode(plain);
    setKey(key);
    return { key, needsPassphrase: false };
  } catch {
    throw new WrongPassphraseError();
  }
}

export function clearStoredKey(): void {
  const local = storageOf('local');
  const session = storageOf('session');
  local?.removeItem(STORAGE.keySecret);
  local?.removeItem(STORAGE.keyMeta);
  session?.removeItem(STORAGE.sessionKey);
  clearRuntimeKey();
}

export function storedKeyExists(): boolean {
  const meta = readMeta();
  if (!meta) return false;
  if (meta.mode === 'session') return Boolean(storageOf('session')?.getItem(STORAGE.sessionKey));
  if (meta.mode === 'memory') return false;
  return Boolean(storageOf('local')?.getItem(STORAGE.keySecret));
}
