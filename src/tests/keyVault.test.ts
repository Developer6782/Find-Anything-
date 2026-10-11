import { beforeEach, describe, expect, it } from 'vitest';
import {
  WrongPassphraseError,
  clearStoredKey,
  getKey,
  loadKey,
  readMeta,
  saveKey,
  setKey,
  storedKeyExists,
} from '../lib/security/keyVault';

/** Minimal Storage stand-in (Node has no localStorage). */
class MemoryStorage implements Storage {
  private map = new Map<string, string>();
  get length() {
    return this.map.size;
  }
  clear() {
    this.map.clear();
  }
  getItem(key: string) {
    return this.map.get(key) ?? null;
  }
  key(index: number) {
    return Array.from(this.map.keys())[index] ?? null;
  }
  removeItem(key: string) {
    this.map.delete(key);
  }
  setItem(key: string, value: string) {
    this.map.set(key, value);
  }
}

const KEY = 'AIzaSyTestKey1234567890';

beforeEach(() => {
  (globalThis as any).localStorage = new MemoryStorage();
  (globalThis as any).sessionStorage = new MemoryStorage();
  clearStoredKey();
});

describe('BYOK key vault', () => {
  it('keeps the key in memory only when asked to', async () => {
    const meta = await saveKey(KEY, { mode: 'memory' });
    expect(meta.mode).toBe('memory');
    expect(getKey()).toBe(KEY);
    expect(storedKeyExists()).toBe(false);
    // nothing sensitive in localStorage
    expect(globalThis.localStorage.getItem('fa.key.secret.v1')).toBeNull();
  });

  it('stores tab-scoped keys in sessionStorage, not localStorage', async () => {
    await saveKey(KEY, { mode: 'session' });
    expect(globalThis.sessionStorage.getItem('fa.key.session.v1')).toBe(KEY);
    expect(globalThis.localStorage.getItem('fa.key.secret.v1')).toBeNull();
    clearRuntime();
    const restored = await loadKey();
    expect(restored.key).toBe(KEY);
  });

  it('encrypts passphrase-protected keys and never stores plaintext', async () => {
    await saveKey(KEY, { mode: 'passphrase', passphrase: 'correct horse battery' });
    const stored = globalThis.localStorage.getItem('fa.key.secret.v1')!;
    expect(stored).toBeTruthy();
    expect(stored).not.toContain(KEY);
    const envelope = JSON.parse(stored);
    expect(envelope.alg).toBe('AES-GCM');
    expect(envelope.kdf).toBe('PBKDF2-SHA256');
    expect(envelope.iterations).toBeGreaterThanOrEqual(100_000);
    expect(envelope.salt).toBeTruthy();
    expect(envelope.iv).toBeTruthy();
    // The raw key must not appear anywhere in storage.
    expect(JSON.stringify(globalThis.localStorage)).not.toContain(KEY);
  });

  it('round-trips an encrypted key with the right passphrase', async () => {
    await saveKey(KEY, { mode: 'passphrase', passphrase: 'correct horse battery' });
    clearRuntime();
    const needs = await loadKey();
    expect(needs.needsPassphrase).toBe(true);
    expect(needs.key).toBeNull();

    const unlocked = await loadKey('correct horse battery');
    expect(unlocked.key).toBe(KEY);
    expect(getKey()).toBe(KEY);
  });

  it('throws a typed error for a wrong passphrase', async () => {
    await saveKey(KEY, { mode: 'passphrase', passphrase: 'correct horse battery' });
    clearRuntime();
    await expect(loadKey('wrong passphrase')).rejects.toBeInstanceOf(WrongPassphraseError);
  });

  it('rejects short passphrases instead of silently weakening storage', async () => {
    await expect(saveKey(KEY, { mode: 'passphrase', passphrase: 'short' })).rejects.toThrow(/at least 8 characters/);
  });

  it('removes every trace on forget, and switching modes cleans old blobs', async () => {
    await saveKey(KEY, { mode: 'passphrase', passphrase: 'correct horse battery' });
    await saveKey(KEY, { mode: 'session' });
    expect(globalThis.localStorage.getItem('fa.key.secret.v1')).toBeNull();

    clearStoredKey();
    expect(storedKeyExists()).toBe(false);
    expect(readMeta()).toBeNull();
    expect(getKey()).toBeNull();
  });

  it('exposes only a short hint in metadata', async () => {
    const meta = await saveKey(KEY, { mode: 'session' });
    expect(meta.hint.length).toBeLessThan(20);
    expect(meta.hint).not.toBe(KEY);
    expect(meta.hint.startsWith('AIzaSy')).toBe(true);
  });

  it('trims accidental whitespace from pasted keys', async () => {
    await saveKey(`  ${KEY}  `, { mode: 'memory' });
    expect(getKey()).toBe(KEY);
  });
});

function clearRuntime() {
  setKey('');
}
